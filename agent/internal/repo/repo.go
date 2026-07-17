// Package repo 提供工作区的只读文件浏览与 diff 查询,服务于 UI 的
// call/call-response 同步请求(文件树、读文件、变更列表、单文件 diff)。
// 全部操作强制限定在工作区目录内。
package repo

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const (
	maxFileBytes = 1 << 20 // 单文件读取上限 1MB
	maxListItems = 2000
)

// Browser 一个工作区的只读浏览器。
type Browser struct {
	workdir string
}

// New 创建浏览器(workdir 须为绝对路径)。
func New(workdir string) *Browser { return &Browser{workdir: workdir} }

func (b *Browser) resolve(rel string) (string, error) {
	p := filepath.Join(b.workdir, rel)
	p = filepath.Clean(p)
	r, err := filepath.Rel(b.workdir, p)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("路径 %s 超出工作区", rel)
	}
	return p, nil
}

// Entry 目录项。
type Entry struct {
	Name  string `json:"name"`
	Path  string `json:"path"` // 相对工作区
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

// ListFiles 列出目录内容(单层,非递归)。dir 为空表示工作区根。
func (b *Browser) ListFiles(dir string) ([]Entry, error) {
	target, err := b.resolve(dir)
	if err != nil {
		return nil, err
	}
	items, err := os.ReadDir(target)
	if err != nil {
		return nil, err
	}
	var out []Entry
	for _, it := range items {
		if it.Name() == ".git" {
			continue
		}
		info, err := it.Info()
		if err != nil {
			continue
		}
		rel, _ := filepath.Rel(b.workdir, filepath.Join(target, it.Name()))
		out = append(out, Entry{
			Name: it.Name(), Path: filepath.ToSlash(rel),
			IsDir: it.IsDir(), Size: info.Size(),
		})
		if len(out) >= maxListItems {
			break
		}
	}
	// 目录在前,再按名排序
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// ReadFile 读取文件内容(带上限)。
func (b *Browser) ReadFile(rel string) (string, error) {
	p, err := b.resolve(rel)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s 是目录", rel)
	}
	if info.Size() > maxFileBytes {
		return "", fmt.Errorf("文件过大(%d 字节),超过 %d 上限", info.Size(), maxFileBytes)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Change 变更文件条目。Status: A(新增)/M(修改)/D(删除)。
type Change struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

// FileChanges 相对 HEAD 的变更列表(含未跟踪文件)。非 git 仓库返回空。
// 路径统一为相对 workdir:porcelain 输出的是仓库根相对路径,workdir 位于
// 仓库子目录时直接拿去当 pathspec 会永远匹配不上(diff 恒空);
// quotepath 关闭,否则非 ASCII 文件名(中文)被转成八进制转义乱码。
func (b *Browser) FileChanges() ([]Change, error) {
	if !b.isGitRepo() {
		return nil, nil
	}
	prefix, _ := b.git("rev-parse", "--show-prefix")
	prefix = strings.TrimSpace(prefix)
	// pathspec "." 限定 workdir 子树:子目录会话不该看到仓库其他地方的改动
	out, _ := b.git("-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=all", "--", ".")
	var changes []Change
	for line := range strings.SplitSeq(out, "\n") {
		if len(line) < 4 {
			continue
		}
		code := strings.TrimSpace(line[:2])
		path := strings.TrimSpace(line[3:])
		// 处理重命名 "old -> new"
		if i := strings.Index(path, " -> "); i >= 0 {
			path = path[i+4:]
		}
		path = strings.Trim(path, `"`)
		// 仓库根相对 → workdir 相对(前缀之外的条目丢弃,双保险)
		if prefix != "" {
			if !strings.HasPrefix(path, prefix) {
				continue
			}
			path = strings.TrimPrefix(path, prefix)
		}
		status := "M"
		switch {
		case strings.Contains(code, "?"), strings.Contains(code, "A"):
			status = "A"
		case strings.Contains(code, "D"):
			status = "D"
		}
		changes = append(changes, Change{Path: path, Status: status})
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].Path < changes[j].Path })
	return changes, nil
}

// FileDiff 单个文件相对 HEAD 的 unified diff。未跟踪文件构造为全新增 diff。
func (b *Browser) FileDiff(rel string) (string, error) {
	if _, err := b.resolve(rel); err != nil {
		return "", err
	}
	if !b.isGitRepo() {
		return "", fmt.Errorf("非 git 仓库,无法生成 diff")
	}
	// 已跟踪文件:直接 diff HEAD(rel 为 workdir 相对,与 FileChanges 一致)
	out, err := b.git("-c", "core.quotepath=false", "diff", "HEAD", "--", rel)
	if err == nil && strings.TrimSpace(out) != "" {
		return out, nil
	}
	// 未跟踪文件:git diff --no-index 生成新增 diff
	if untracked, _ := b.git("ls-files", "--others", "--exclude-standard", "--", rel); strings.TrimSpace(untracked) != "" {
		d, _ := b.gitAllowFail("-c", "core.quotepath=false", "diff", "--no-index", "--", os.DevNull, rel)
		return d, nil
	}
	return out, nil
}

func (b *Browser) isGitRepo() bool {
	out, err := b.git("rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(out) == "true"
}

func (b *Browser) git(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = b.workdir
	out, err := cmd.Output()
	return string(out), err
}

// gitAllowFail 用于 diff --no-index(有差异时退出码为 1,非错误)。
func (b *Browser) gitAllowFail(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = b.workdir
	out, _ := cmd.Output()
	return string(out), nil
}
