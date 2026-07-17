package baizhi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// cookieStore 极简持久化 cookie 罐:RFC 6265 的域后缀 + 路径前缀匹配,
// JSON 落盘(0600,登录凭证)。不用 net/http/cookiejar 是因为它不暴露
// 内容枚举,无法持久化;这里所有流量只对着 baizhi.cloud 一族域名,
// 完整 jar 的公共后缀防护没有必要。
//
// 会话 cookie(无过期时间)也持久化——它就是登录凭证本身,桌面场景的
// 预期是"登录一次长期有效",真实有效期以服务端 401 为准。
type cookieStore struct {
	mu   sync.Mutex
	path string // 落盘位置;空则仅内存(测试)
	list []storedCookie
}

type storedCookie struct {
	Name     string    `json:"name"`
	Value    string    `json:"value"`
	Domain   string    `json:"domain"`              // 无前导点;HostOnly 区分匹配语义
	Path     string    `json:"path"`                // 缺省 "/"
	Expires  time.Time `json:"expires,omitzero"`    // 零值 = 会话 cookie
	HostOnly bool      `json:"host_only,omitempty"` // Set-Cookie 未带 Domain 属性
	Secure   bool      `json:"secure,omitempty"`
}

func (sc *storedCookie) expired(now time.Time) bool {
	return !sc.Expires.IsZero() && now.After(sc.Expires)
}

// matches cookie 是否随发给 host+path 的请求携带。
func (sc *storedCookie) matches(host, path string) bool {
	if sc.HostOnly {
		if host != sc.Domain {
			return false
		}
	} else if host != sc.Domain && !strings.HasSuffix(host, "."+sc.Domain) {
		return false
	}
	cp := sc.Path
	if cp == "" {
		cp = "/"
	}
	return path == cp || strings.HasPrefix(path, strings.TrimSuffix(cp, "/")+"/")
}

// newCookieStore 创建并尝试从磁盘恢复;文件不存在或损坏都从空开始
// (登录态可重建,不因坏文件致死)。
func newCookieStore(path string) *cookieStore {
	s := &cookieStore{path: path}
	if path == "" {
		return s
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var list []storedCookie
	if json.Unmarshal(data, &list) != nil {
		return s
	}
	now := time.Now()
	for _, c := range list {
		if !c.expired(now) {
			s.list = append(s.list, c)
		}
	}
	return s
}

// update 吸收一条响应的 Set-Cookie(覆盖同名同域同路径;过期/负 Max-Age 删除)。
func (s *cookieStore) update(reqURL *url.URL, cookies []*http.Cookie) {
	if len(cookies) == 0 {
		return
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range cookies {
		sc := storedCookie{
			Name:   c.Name,
			Value:  c.Value,
			Domain: strings.TrimPrefix(c.Domain, "."),
			Path:   c.Path,
			Secure: c.Secure,
		}
		host := reqURL.Hostname()
		// RFC 6265:无 Domain 属性,或属性与请求 host 不匹配(如联调假服务
		// 在 localhost 却声明 .baizhi.cloud),都按 host-only 处理
		if sc.Domain == "" || (host != sc.Domain && !strings.HasSuffix(host, "."+sc.Domain)) {
			sc.Domain = host
			sc.HostOnly = true
		}
		if sc.Path == "" {
			sc.Path = "/"
		}
		switch {
		case c.MaxAge > 0:
			sc.Expires = now.Add(time.Duration(c.MaxAge) * time.Second)
		case c.MaxAge < 0:
			sc.Expires = now.Add(-time.Hour) // 立即过期 = 删除
		default:
			sc.Expires = c.Expires // 可能为零值(会话 cookie)
		}

		replaced := false
		for i := range s.list {
			if s.list[i].Name == sc.Name && s.list[i].Domain == sc.Domain && s.list[i].Path == sc.Path {
				s.list[i] = sc
				replaced = true
				break
			}
		}
		if !replaced {
			s.list = append(s.list, sc)
		}
	}
	// 清掉已过期项后落盘
	kept := s.list[:0]
	for _, c := range s.list {
		if !c.expired(now) {
			kept = append(kept, c)
		}
	}
	s.list = kept
	s.saveLocked()
}

// header 拼请求应携带的 Cookie 头;无匹配返回空串。
func (s *cookieStore) header(reqURL *url.URL) string {
	now := time.Now()
	host := reqURL.Hostname()
	path := reqURL.Path
	if path == "" {
		path = "/"
	}
	secure := reqURL.Scheme == "https"
	s.mu.Lock()
	defer s.mu.Unlock()
	var parts []string
	for _, c := range s.list {
		if c.expired(now) || (c.Secure && !secure) || !c.matches(host, path) {
			continue
		}
		parts = append(parts, c.Name+"="+c.Value)
	}
	return strings.Join(parts, "; ")
}

// clear 清空全部 cookie 并删除落盘文件(登出)。
func (s *cookieStore) clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.list = nil
	if s.path != "" {
		_ = os.Remove(s.path)
	}
}

// empty 是否没有任何(未过期)cookie。
func (s *cookieStore) empty() bool {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.list {
		if !c.expired(now) {
			return false
		}
	}
	return true
}

func (s *cookieStore) saveLocked() {
	if s.path == "" {
		return
	}
	data, err := json.MarshalIndent(s.list, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return
	}
	// 同目录临时文件 + rename,避免半写文件
	tmp := fmt.Sprintf("%s.tmp%d", s.path, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, s.path)
}
