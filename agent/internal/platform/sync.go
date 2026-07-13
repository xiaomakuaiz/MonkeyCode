package platform

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// 技能 zip 解包防护上限
const (
	maxZipBytes      = 32 << 20  // 单个 zip 下载上限
	maxUnzipBytes    = 128 << 20 // 解包总字节上限
	maxUnzipFiles    = 2000
	maxUnzipFileSize = 16 << 20
)

// Skill 已落盘的技能:Dir 为解包目录,Doc 为入口文档(SKILL.md 等,可能为空)。
type Skill struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Dir         string `json:"dir"`
	Doc         string `json:"doc"`
}

// Materialized 同步(或离线读缓存)后的平台资源。
type Materialized struct {
	Rules  []Rule  `json:"rules"`
	Skills []Skill `json:"skills"`
}

// CacheDir 平台资源缓存目录(按平台 host 隔离)。
func CacheDir(platformURL string) string {
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	host := "default"
	if u, err := url.Parse(platformURL); err == nil && u.Host != "" {
		host = strings.ReplaceAll(u.Host, ":", "_")
	}
	return filepath.Join(base, "mc-agent", "platform", host)
}

// Sync 拉取平台技能/规则并落盘缓存:规则写入 resources.json,技能 zip 下载
// 解包到 skills/<name>@<version>/(同版本已存在则跳过下载)。任一技能失败
// 只跳过该技能,不阻塞整体。
func (c *Client) Sync(ctx context.Context) (*Materialized, error) {
	res, err := c.FetchResources(ctx)
	if err != nil {
		return nil, err
	}

	cacheDir := CacheDir(c.BaseURL)
	mat := &Materialized{Rules: res.Rules, Skills: []Skill{}}
	for _, ref := range res.Skills {
		dir := filepath.Join(cacheDir, "skills", sanitize(ref.Name)+"@"+sanitize(ref.Version))
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			if err := c.downloadSkill(ctx, ref.ZipURL, dir); err != nil {
				fmt.Fprintf(os.Stderr, "警告: 技能 %s 下载失败,已跳过: %v\n", ref.Name, err)
				continue
			}
		}
		mat.Skills = append(mat.Skills, Skill{
			Name:        ref.Name,
			Version:     ref.Version,
			Description: ref.Description,
			Dir:         dir,
			Doc:         findSkillDoc(dir),
		})
	}

	if err := saveCache(cacheDir, mat); err != nil {
		fmt.Fprintln(os.Stderr, "警告: 平台资源缓存写入失败:", err)
	}
	return mat, nil
}

// LoadCached 读取上次同步的缓存(平台不可达时的离线兜底)。
func LoadCached(platformURL string) (*Materialized, error) {
	data, err := os.ReadFile(filepath.Join(CacheDir(platformURL), "resources.json"))
	if err != nil {
		return nil, err
	}
	var mat Materialized
	if err := json.Unmarshal(data, &mat); err != nil {
		return nil, err
	}
	// 缓存里的技能目录可能已被清理,过滤失效项
	kept := mat.Skills[:0]
	for _, s := range mat.Skills {
		if st, err := os.Stat(s.Dir); err == nil && st.IsDir() {
			kept = append(kept, s)
		}
	}
	mat.Skills = kept
	return &mat, nil
}

func saveCache(cacheDir string, mat *Materialized) error {
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(mat, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(cacheDir, "resources.json"), data, 0o600)
}

// downloadSkill 下载 presigned zip 并安全解包到 dir(先写临时目录再改名)。
func (c *Client) downloadSkill(ctx context.Context, zipURL, dir string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, zipURL, nil)
	if err != nil {
		return err
	}
	// presigned URL 自带签名,不带平台令牌
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载返回 HTTP %d", resp.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxZipBytes+1))
	if err != nil {
		return err
	}
	if len(data) > maxZipBytes {
		return fmt.Errorf("zip 超过大小上限 %d 字节", maxZipBytes)
	}

	tmp := dir + ".tmp"
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	if err := unzipTo(data, tmp); err != nil {
		_ = os.RemoveAll(tmp)
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		_ = os.RemoveAll(tmp)
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		_ = os.RemoveAll(tmp)
		return err
	}
	return os.Rename(tmp, dir)
}

// unzipTo 解包 zip 到目录,防 zip-slip / zip 炸弹。
func unzipTo(data []byte, dir string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	if len(zr.File) > maxUnzipFiles {
		return fmt.Errorf("zip 文件数 %d 超过上限 %d", len(zr.File), maxUnzipFiles)
	}
	var total int64
	for _, f := range zr.File {
		name := filepath.FromSlash(f.Name)
		if filepath.IsAbs(name) || strings.Contains(name, "..") {
			return fmt.Errorf("zip 含非法路径 %q", f.Name)
		}
		target := filepath.Join(dir, name)
		if !strings.HasPrefix(target, filepath.Clean(dir)+string(filepath.Separator)) {
			return fmt.Errorf("zip 含越界路径 %q", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		}
		if f.UncompressedSize64 > maxUnzipFileSize {
			return fmt.Errorf("zip 内文件 %q 超过大小上限", f.Name)
		}
		total += int64(f.UncompressedSize64)
		if total > maxUnzipBytes {
			return fmt.Errorf("zip 解包总量超过上限 %d 字节", int64(maxUnzipBytes))
		}
		if err := extractFile(f, target); err != nil {
			return err
		}
	}
	return nil
}

func extractFile(f *zip.File, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	w, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer w.Close()
	// LimitReader 双保险:声明的 UncompressedSize64 可被伪造
	_, err = io.Copy(w, io.LimitReader(rc, maxUnzipFileSize+1))
	return err
}

// findSkillDoc 在技能目录找入口文档。
func findSkillDoc(dir string) string {
	for _, name := range []string{"SKILL.md", "skill.md", "README.md", "readme.md"} {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	// 兼容 zip 顶层多一层目录的形态
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || !entries[0].IsDir() {
		return ""
	}
	sub := filepath.Join(dir, entries[0].Name())
	for _, name := range []string{"SKILL.md", "skill.md", "README.md", "readme.md"} {
		p := filepath.Join(sub, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			return r
		default:
			return '_'
		}
	}, s)
}
