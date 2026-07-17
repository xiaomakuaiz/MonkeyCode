package baizhi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeBaizhi 假百智云:实现 challenge/redeem(按协议独立校验 PoW 解)、
// 发码、登录(种会话 cookie)、profile(校验 cookie)。
type fakeBaizhi struct {
	t              *testing.T
	challengeToken string
	captchaToken   string
	sentPhone      string
	sentKind       string
	loginPhone     string
	loginCode      string
	sessionCookie  string
}

func (f *fakeBaizhi) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/public/captcha/challenge", func(w http.ResponseWriter, r *http.Request) {
		f.challengeToken = "chtok-123"
		w.WriteHeader(http.StatusCreated) // 真实服务端回 201,钉住 2xx 兼容
		json.NewEncoder(w).Encode(map[string]any{
			"challenge": map[string]int{"c": 3, "s": 32, "d": 3},
			"token":     f.challengeToken,
		})
	})
	mux.HandleFunc("POST /api/v1/public/captcha/redeem", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Token     string `json:"token"`
			Solutions []int  `json:"solutions"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if req.Token != f.challengeToken || len(req.Solutions) != 3 {
			json.NewEncoder(w).Encode(map[string]any{"success": false, "message": "质询不匹配"})
			return
		}
		// 独立校验每个解(协议本身的校验逻辑,与求解器实现无关)
		for i, nonce := range req.Solutions {
			idx := strconv.Itoa(i + 1)
			salt := prng(req.Token+idx, 32)
			target := prng(req.Token+idx+"d", 3)
			digest := sha256.Sum256([]byte(salt + strconv.Itoa(nonce)))
			if !strings.HasPrefix(hex.EncodeToString(digest[:]), target) {
				json.NewEncoder(w).Encode(map[string]any{"success": false, "message": "PoW 解无效"})
				return
			}
		}
		f.captchaToken = "captok-456"
		json.NewEncoder(w).Encode(map[string]any{"success": true, "token": f.captchaToken})
	})
	mux.HandleFunc("POST /api/v1/user/phone_code", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Phone, Kind, CaptchaToken string
		}
		var raw map[string]string
		json.NewDecoder(r.Body).Decode(&raw)
		req.Phone, req.Kind, req.CaptchaToken = raw["phone"], raw["kind"], raw["captcha_token"]
		if req.CaptchaToken != f.captchaToken {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]any{"code": 400, "message": "验证码无效 [trace_id:abc123]"})
			return
		}
		f.sentPhone, f.sentKind = req.Phone, req.Kind
		json.NewEncoder(w).Encode(map[string]any{"code": 0})
	})
	mux.HandleFunc("POST /api/v1/user/login/phone", func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]string
		json.NewDecoder(r.Body).Decode(&raw)
		if raw["captcha_token"] != f.captchaToken || raw["phone"] != f.loginPhone || raw["code"] != f.loginCode {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]any{"code": 401, "message": "验证码错误"})
			return
		}
		f.sessionCookie = "sess-789"
		http.SetCookie(w, &http.Cookie{Name: "baizhi_session", Value: f.sessionCookie, Path: "/", HttpOnly: true})
		json.NewEncoder(w).Encode(map[string]any{"code": 0})
	})
	mux.HandleFunc("GET /api/v1/user/profile", func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("baizhi_session")
		if err != nil || f.sessionCookie == "" || c.Value != f.sessionCookie {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte("Unauthorized"))
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]string{"phone": f.loginPhone, "name": "测试用户"}})
	})
	return mux
}

func newTestService(t *testing.T, srvURL, cookiePath string) *Service {
	t.Helper()
	s := NewService(srvURL, cookiePath)
	// NewService 会被 MC_AGENT_BAIZHI_URL 覆盖;测试环境确保指向假服务
	s.base = strings.TrimRight(srvURL, "/")
	return s
}

func TestLoginFlow(t *testing.T) {
	fake := &fakeBaizhi{t: t, loginPhone: "13800138000", loginCode: "123456"}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	cookiePath := filepath.Join(t.TempDir(), "cookies.json")
	s := newTestService(t, srv.URL, cookiePath)
	ctx := context.Background()

	// 未登录状态
	loggedIn, _, err := s.Status(ctx)
	if err != nil || loggedIn {
		t.Fatalf("初始应未登录: loggedIn=%v err=%v", loggedIn, err)
	}

	// 发码(内部完成 PoW)
	if err := s.SendPhoneCode(ctx, "13800138000"); err != nil {
		t.Fatalf("发码失败: %v", err)
	}
	if fake.sentPhone != "13800138000" || fake.sentKind != "login" {
		t.Fatalf("发码参数不对: phone=%s kind=%s", fake.sentPhone, fake.sentKind)
	}

	// 登录
	if err := s.LoginPhone(ctx, "13800138000", "123456"); err != nil {
		t.Fatalf("登录失败: %v", err)
	}

	// 已登录:profile 探测通过
	loggedIn, profile, err := s.Status(ctx)
	if err != nil || !loggedIn {
		t.Fatalf("登录后应为已登录: loggedIn=%v err=%v", loggedIn, err)
	}
	var p struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(profile, &p) != nil || p.Name != "测试用户" {
		t.Fatalf("profile 不对: %s", profile)
	}

	// cookie 落盘:新 Service 实例(模拟内核重启)恢复会话
	s2 := newTestService(t, srv.URL, cookiePath)
	loggedIn, _, err = s2.Status(ctx)
	if err != nil || !loggedIn {
		t.Fatalf("重启后应恢复登录态: loggedIn=%v err=%v", loggedIn, err)
	}

	// 登出:清 cookie,状态回到未登录
	s2.Logout()
	loggedIn, _, _ = s2.Status(ctx)
	if loggedIn {
		t.Fatal("登出后应为未登录")
	}
	s3 := newTestService(t, srv.URL, cookiePath)
	if loggedIn, _, _ = s3.Status(ctx); loggedIn {
		t.Fatal("登出后重启也应为未登录")
	}
}

func TestLoginWrongCode(t *testing.T) {
	fake := &fakeBaizhi{t: t, loginPhone: "13800138000", loginCode: "123456"}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	s := newTestService(t, srv.URL, "")
	err := s.LoginPhone(context.Background(), "13800138000", "000000")
	if err == nil || !strings.Contains(err.Error(), "验证码错误") {
		t.Fatalf("错误验证码应报错并透传 message: %v", err)
	}
}

func TestErrorMessageStripsTraceID(t *testing.T) {
	fake := &fakeBaizhi{t: t}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	s := newTestService(t, srv.URL, "")
	// 跳过验证码直接发码 → captcha_token 不匹配 → 服务端 message 带 trace_id
	err := s.call(context.Background(), http.MethodPost, "/api/v1/user/phone_code",
		map[string]string{"phone": "13800138000", "kind": "login", "captcha_token": "bogus"}, nil)
	if err == nil {
		t.Fatal("应报错")
	}
	if strings.Contains(err.Error(), "trace_id") {
		t.Fatalf("message 应去掉 trace_id: %v", err)
	}
	if !strings.Contains(err.Error(), "验证码无效") {
		t.Fatalf("应透传业务 message: %v", err)
	}
}

func TestCookieStoreDomainMatch(t *testing.T) {
	s := newCookieStore("")
	base, _ := url.Parse("https://baizhi.cloud/api/v1/user/login/phone")

	// 域 cookie(.baizhi.cloud)应随发所有子域;host-only 只随发本域
	s.update(base, []*http.Cookie{
		{Name: "shared", Value: "1", Domain: ".baizhi.cloud", Path: "/"},
		{Name: "hostonly", Value: "2", Path: "/"},
	})

	sub, _ := url.Parse("https://ai-api-gateway.app.baizhi.cloud/api/models")
	h := s.header(sub)
	if !strings.Contains(h, "shared=1") {
		t.Errorf("域 cookie 应随发子域: %q", h)
	}
	if strings.Contains(h, "hostonly=2") {
		t.Errorf("host-only cookie 不应随发子域: %q", h)
	}
	if h := s.header(base); !strings.Contains(h, "shared=1") || !strings.Contains(h, "hostonly=2") {
		t.Errorf("本域应带全部 cookie: %q", h)
	}

	// 过期删除
	s.update(base, []*http.Cookie{{Name: "shared", Value: "", Domain: ".baizhi.cloud", Path: "/", MaxAge: -1}})
	if h := s.header(sub); strings.Contains(h, "shared") {
		t.Errorf("MaxAge<0 应删除 cookie: %q", h)
	}

	// 无关域绝不携带
	other, _ := url.Parse("https://evil.example.com/")
	if h := s.header(other); h != "" {
		t.Errorf("无关域不应携带任何 cookie: %q", h)
	}
}

func TestCookieStoreExpiry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cookies.json")
	s := newCookieStore(path)
	base, _ := url.Parse("https://baizhi.cloud/")
	s.update(base, []*http.Cookie{
		{Name: "gone", Value: "1", Path: "/", Expires: time.Now().Add(-time.Hour)},
		{Name: "alive", Value: "2", Path: "/", Expires: time.Now().Add(time.Hour)},
	})
	// 重新加载:过期的不恢复
	s2 := newCookieStore(path)
	h := s2.header(base)
	if strings.Contains(h, "gone") {
		t.Errorf("过期 cookie 不应恢复: %q", h)
	}
	if !strings.Contains(h, "alive=2") {
		t.Errorf("未过期 cookie 应恢复: %q", h)
	}
}
