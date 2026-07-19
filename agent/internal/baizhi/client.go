package baizhi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// DefaultBaseURL 百智云官方账号域(向后兼容导出;新代码用 Endpoints)。
const DefaultBaseURL = defaultAccount

// Service 百智云账号服务:验证码、手机号/微信扫码登录、会话探测、
// 登录后同步模型与 MCP。全部请求走内核(UI 在 127.0.0.1 origin 上带凭证
// 跨域会被 CORS 拦),cookie 会话由 store 持久化。
type Service struct {
	ep    Endpoints
	base  string       // = ep.Account,账号域;绝大多数登录请求打这里
	http  *http.Client // API 短请求
	lp    *http.Client // 微信授权页/二维码/长轮询(长轮询最长挂 ~25s)
	store *cookieStore
	mc    *cookieStore // MonkeyCode 云端会话,与百智会话独立(登出互不牵连)

	wxMu       sync.Mutex
	wx         *wechatLogin // 进行中的扫码会话(只保留最新)
	lpOverride string       // 测试注入长轮询基址
}

// NewService 创建服务(账号域可配,模型/MCP 网关取默认或环境变量)。
// baseURL 空用官方账号域;cookiePath 空则会话仅存内存。
func NewService(baseURL, cookiePath string) *Service {
	return NewServiceWithEndpoints(Endpoints{Account: baseURL}, cookiePath)
}

// NewServiceWithEndpoints 三地址均可配(私有化部署入口)。
func NewServiceWithEndpoints(ep Endpoints, cookiePath string) *Service {
	ep = resolveEndpoints(ep)
	// 不自动跟随重定向:微信回调等 302 的 Set-Cookie 要在首响应就吸收,
	// 跟随会丢中间响应的 cookie(现有 API 端点均为 2xx JSON,不受影响)
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// MonkeyCode 会话与百智会话同目录、分文件:凭证语义不同(云端账号 vs
	// 百智账号),一方登出不应顺带丢另一方
	mcPath := ""
	if cookiePath != "" {
		mcPath = filepath.Join(filepath.Dir(cookiePath), "monkeycode-cookies.json")
	}
	return &Service{
		ep:    ep,
		base:  ep.Account,
		http:  &http.Client{Timeout: 30 * time.Second, CheckRedirect: noRedirect},
		lp:    &http.Client{Timeout: 40 * time.Second, CheckRedirect: noRedirect},
		store: newCookieStore(cookiePath),
		mc:    newCookieStore(mcPath),
	}
}

// ==================== 登录流程 ====================

// SendPhoneCode 发送登录短信验证码(内部先完成 PoW 验证码)。
func (s *Service) SendPhoneCode(ctx context.Context, phone string) error {
	captchaToken, err := s.obtainCaptchaToken(ctx)
	if err != nil {
		return err
	}
	return s.call(ctx, http.MethodPost, "/api/v1/user/phone_code",
		map[string]string{"phone": phone, "kind": "login", "captcha_token": captchaToken}, nil)
}

// LoginPhone 手机号 + 短信验证码登录;成功后会话 cookie 已持久化。
func (s *Service) LoginPhone(ctx context.Context, phone, code string) error {
	captchaToken, err := s.obtainCaptchaToken(ctx)
	if err != nil {
		return err
	}
	return s.call(ctx, http.MethodPost, "/api/v1/user/login/phone",
		map[string]string{"phone": phone, "code": code, "captcha_token": captchaToken}, nil)
}

// Status 会话状态:有 cookie 时探测 /api/v1/user/profile,
// 200 视为已登录并返回原样 profile(字段对内核不透明,UI 自行展示)。
func (s *Service) Status(ctx context.Context) (loggedIn bool, profile json.RawMessage, err error) {
	if s.store.empty() {
		return false, nil, nil
	}
	var out json.RawMessage
	err = s.call(ctx, http.MethodGet, "/api/v1/user/profile", nil, &out)
	if err != nil {
		if isUnauthorized(err) {
			return false, nil, nil
		}
		return false, nil, err
	}
	return true, out, nil
}

// Logout 清除本地会话(服务端登出端点未测绘,本地清 cookie 已达目的:
// 凭证即 cookie,清掉即失效)。
func (s *Service) Logout() {
	s.store.clear()
}

// ==================== PoW 验证码 ====================

type challengeResp struct {
	Challenge Challenge `json:"challenge"`
	Token     string    `json:"token"`
}

type redeemResp struct {
	Success bool   `json:"success"`
	Token   string `json:"token"`
	Message string `json:"message"`
}

// obtainCaptchaToken 完整跑一遍 PoW 验证码,返回登录接口所需 captcha_token。
// challenge/redeem 两个端点返回裸结构,不套 {code,message,data} 包壳。
func (s *Service) obtainCaptchaToken(ctx context.Context) (string, error) {
	var ch challengeResp
	if err := s.callRaw(ctx, http.MethodPost, "/api/v1/public/captcha/challenge", nil, &ch); err != nil {
		return "", fmt.Errorf("获取验证码质询失败: %w", err)
	}
	if ch.Token == "" || ch.Challenge.C <= 0 {
		return "", fmt.Errorf("验证码质询响应格式异常")
	}
	solutions, err := SolveChallenges(ch.Token, ch.Challenge)
	if err != nil {
		return "", err
	}
	var rd redeemResp
	if err := s.callRaw(ctx, http.MethodPost, "/api/v1/public/captcha/redeem",
		map[string]any{"token": ch.Token, "solutions": solutions}, &rd); err != nil {
		return "", fmt.Errorf("验证码校验失败: %w", err)
	}
	if !rd.Success || rd.Token == "" {
		msg := rd.Message
		if msg == "" {
			msg = "验证码校验未通过"
		}
		return "", fmt.Errorf("%s", cleanMessage(msg))
	}
	return rd.Token, nil
}

// ==================== HTTP 基座 ====================

// errUnauthorized 会话失效的哨兵语义(Status 转成"未登录"而非报错)。
type unauthorizedError struct{ msg string }

func (e *unauthorizedError) Error() string { return e.msg }

func isUnauthorized(err error) bool {
	var ue *unauthorizedError
	return errors.As(err, &ue)
}

// call 请求百智云业务接口并解开 {code,message,success,data} 包壳。
// out 非 nil 时填入 data(缺 data 字段时填整个响应体,对齐移动端语义)。
func (s *Service) call(ctx context.Context, method, path string, body, out any) error {
	data, status, err := s.do(ctx, method, path, body)
	if err != nil {
		return err
	}
	var envelope struct {
		Code    *int            `json:"code"`
		Message string          `json:"message"`
		Success *bool           `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		if is2xx(status) {
			return nil // 非 JSON 但 2xx,视为成功无数据
		}
		return httpError(status, string(data))
	}
	failed := !is2xx(status) ||
		(envelope.Code != nil && *envelope.Code != 0) ||
		(envelope.Success != nil && !*envelope.Success)
	if failed {
		msg := cleanMessage(envelope.Message)
		if msg == "" {
			return httpError(status, "")
		}
		if status == http.StatusUnauthorized {
			return &unauthorizedError{msg}
		}
		return fmt.Errorf("%s", msg)
	}
	if out != nil {
		payload := envelope.Data
		if len(payload) == 0 {
			payload = data
		}
		if err := json.Unmarshal(payload, out); err != nil {
			return fmt.Errorf("百智云响应数据解析失败: %w", err)
		}
	}
	return nil
}

// callRaw 请求裸结构端点(验证码 challenge/redeem 不套包壳)。
func (s *Service) callRaw(ctx context.Context, method, path string, body, out any) error {
	data, status, err := s.do(ctx, method, path, body)
	if err != nil {
		return err
	}
	// 真实服务端的 challenge 返回 201,按整个 2xx 判成功(对齐移动端 res.ok)
	if !is2xx(status) {
		// 失败时尽力提取 message
		var e struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &e) == nil && e.Message != "" {
			return fmt.Errorf("%s", cleanMessage(e.Message))
		}
		return httpError(status, string(data))
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("百智云响应解析失败: %w", err)
		}
	}
	return nil
}

// do 发请求:携带存储的 cookie,吸收响应的 Set-Cookie。
// path 以 http 开头时视为绝对 URL(微信回调),否则拼在 base 后。
func (s *Service) do(ctx context.Context, method, path string, body any) ([]byte, int, error) {
	target := path
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		target = s.base + path
	}
	return s.doStore(ctx, s.store, method, target, body)
}

// doStore do 的底座:cookie 罐可指定(百智会话 / MonkeyCode 会话)。
func (s *Service) doStore(ctx context.Context, store *cookieStore, method, target string, body any) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if h := store.header(req.URL); h != "" {
		req.Header.Set("Cookie", h)
	}

	resp, err := s.http.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("请求 %s 失败: %w", req.URL.Hostname(), err)
	}
	defer resp.Body.Close()
	store.update(resp.Request.URL, resp.Cookies())

	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, 0, err
	}
	return data, resp.StatusCode, nil
}

// ==================== 辅助 ====================

func is2xx(status int) bool { return status >= 200 && status < 300 }

var traceIDRe = regexp.MustCompile(`(?i)\s*\[trace_id:[^\]]+\]\s*$`)

// cleanMessage 去掉服务端 message 尾部的 trace_id 标注(对齐移动端)。
func cleanMessage(msg string) string {
	return strings.TrimSpace(traceIDRe.ReplaceAllString(msg, ""))
}

func httpError(status int, body string) error {
	if status == http.StatusUnauthorized {
		return &unauthorizedError{"百智云会话已失效,请重新登录"}
	}
	body = strings.TrimSpace(body)
	if body != "" && len(body) <= 200 && !strings.HasPrefix(body, "<") {
		return fmt.Errorf("百智云请求失败(HTTP %d): %s", status, body)
	}
	return fmt.Errorf("百智云请求失败(HTTP %d)", status)
}

// baseHost 服务地址(诊断展示用)。
func (s *Service) baseHost() string {
	u, err := url.Parse(s.base)
	if err != nil {
		return s.base
	}
	return u.Host
}
