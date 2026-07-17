package baizhi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"
)

// 微信扫码登录:内核扮演 qrconnect 页面的角色(网页版微信登录同款协议,
// 多年稳定):
//
//  1. baizhi /api/v1/user/oauth/login?platform=wechat → qrconnect 授权页 URL
//     (含 appid/redirect_uri/state)
//  2. GET 授权页,解析出二维码 uuid(/connect/qrcode/<uuid>)
//  3. 二维码图片下发 UI 展示;长轮询 lp.<授权页域名>/connect/l/qrconnect?uuid=
//     wx_errcode: 408 待扫码 / 404 已扫码待确认 / 403 已取消 / 402|500 过期 /
//     405 确认成功(附 wx_code)
//  4. 拿到 wx_code 后,内核带 cookie jar GET 百智云回调
//     redirect_uri?code=<wx_code>&state=<state> → 会话 cookie 落内核,持久化
//
// 已实测(无头):步骤 1-3 与真实服务端行为一致;步骤 4 依赖真机扫码验证。

// wechatLogin 单次扫码会话(Service 同一时刻只保留最新一次)。
type wechatLogin struct {
	uuid        string
	state       string
	callbackURL string // redirect_uri(不含 code/state)
	lpBase      string // 长轮询基址,如 https://lp.open.weixin.qq.com
}

var qrUUIDRe = regexp.MustCompile(`/connect/qrcode/([A-Za-z0-9_-]+)`)

// StartWechatLogin 发起扫码会话,返回二维码图片(data URL,UI 直接 <img>)。
func (s *Service) StartWechatLogin(ctx context.Context) (qrDataURL string, err error) {
	// 1. 授权页地址(redirect_url 用官网首页,语义同网页登录)
	var out struct {
		URL string `json:"url"`
	}
	if err := s.call(ctx, http.MethodGet,
		"/api/v1/user/oauth/login?platform=wechat&redirect_url="+url.QueryEscape(s.base+"/"), nil, &out); err != nil {
		return "", fmt.Errorf("获取微信授权地址失败: %w", err)
	}
	authURL, err := url.Parse(out.URL)
	if err != nil || authURL.Host == "" {
		return "", fmt.Errorf("微信授权地址异常: %q", out.URL)
	}
	state := authURL.Query().Get("state")
	callback := authURL.Query().Get("redirect_uri")
	if state == "" || callback == "" {
		return "", fmt.Errorf("微信授权地址缺少 state/redirect_uri: %q", out.URL)
	}

	// 2. 拉授权页解析二维码 uuid
	page, err := s.fetch(ctx, out.URL)
	if err != nil {
		return "", fmt.Errorf("加载微信授权页失败: %w", err)
	}
	m := qrUUIDRe.FindSubmatch(page)
	if m == nil {
		return "", fmt.Errorf("微信授权页里没找到二维码(页面结构可能已变化)")
	}
	uuid := string(m[1])

	// 3. 二维码图片
	img, err := s.fetch(ctx, authURL.Scheme+"://"+authURL.Host+"/connect/qrcode/"+uuid)
	if err != nil {
		return "", fmt.Errorf("获取微信二维码失败: %w", err)
	}

	login := &wechatLogin{
		uuid:        uuid,
		state:       state,
		callbackURL: callback,
		lpBase:      authURL.Scheme + "://lp." + authURL.Host,
	}
	if s.lpOverride != "" {
		login.lpBase = s.lpOverride
	}
	s.wxMu.Lock()
	s.wx = login
	s.wxMu.Unlock()
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(img), nil
}

// WechatPollResult 一次长轮询的结果。
type WechatPollResult struct {
	// Status: waiting 待扫码 | scanned 已扫码待确认 | canceled 手机端取消 |
	// expired 二维码过期(需重新获取) | ok 登录完成
	Status string `json:"status"`
}

var wxErrcodeRe = regexp.MustCompile(`wx_errcode=(\d+)`)
var wxCodeRe = regexp.MustCompile(`wx_code='([^']*)'`)

// PollWechatLogin 长轮询一次扫码状态(微信侧最长挂 ~25s;UI 收到结果后
// 立即再次调用)。确认成功时就地完成百智云回调,返回 ok 即已登录。
func (s *Service) PollWechatLogin(ctx context.Context) (*WechatPollResult, error) {
	s.wxMu.Lock()
	login := s.wx
	s.wxMu.Unlock()
	if login == nil {
		return nil, fmt.Errorf("没有进行中的扫码会话,请先获取二维码")
	}

	lpURL := fmt.Sprintf("%s/connect/l/qrconnect?uuid=%s&_=%d",
		login.lpBase, url.QueryEscape(login.uuid), time.Now().UnixMilli())
	body, err := s.fetch(ctx, lpURL)
	if err != nil {
		return nil, fmt.Errorf("查询扫码状态失败: %w", err)
	}
	mc := wxErrcodeRe.FindSubmatch(body)
	if mc == nil {
		return nil, fmt.Errorf("扫码状态响应异常: %s", truncate(string(body), 120))
	}
	errcode, _ := strconv.Atoi(string(mc[1]))
	switch errcode {
	case 408:
		return &WechatPollResult{Status: "waiting"}, nil
	case 404:
		return &WechatPollResult{Status: "scanned"}, nil
	case 403:
		return &WechatPollResult{Status: "canceled"}, nil
	case 402, 500:
		return &WechatPollResult{Status: "expired"}, nil
	case 405:
		code := ""
		if m := wxCodeRe.FindSubmatch(body); m != nil {
			code = string(m[1])
		}
		if code == "" {
			return nil, fmt.Errorf("扫码确认成功但未返回授权码")
		}
		if err := s.completeWechatCallback(ctx, login, code); err != nil {
			return nil, err
		}
		s.wxMu.Lock()
		s.wx = nil
		s.wxMu.Unlock()
		return &WechatPollResult{Status: "ok"}, nil
	default:
		return nil, fmt.Errorf("未知扫码状态 wx_errcode=%d", errcode)
	}
}

// completeWechatCallback 用 wx_code 走百智云回调换会话,并以 profile 探测确认。
func (s *Service) completeWechatCallback(ctx context.Context, login *wechatLogin, code string) error {
	cb, err := url.Parse(login.callbackURL)
	if err != nil {
		return fmt.Errorf("回调地址异常: %w", err)
	}
	q := cb.Query()
	q.Set("code", code)
	q.Set("state", login.state)
	cb.RawQuery = q.Encode()
	// 回调通常 302 到 redirect_url;do 不跟随重定向,Set-Cookie 在首响应即被吸收。
	// 4xx/5xx 才算失败(错误体尽力提取 message)。
	data, status, err := s.do(ctx, http.MethodGet, cb.String(), nil)
	if err != nil {
		return fmt.Errorf("微信登录回调失败: %w", err)
	}
	if status >= 400 {
		var e struct {
			Message string `json:"message"`
		}
		if jsonUnmarshal(data, &e) && e.Message != "" {
			return fmt.Errorf("微信登录回调被拒: %s", cleanMessage(e.Message))
		}
		return fmt.Errorf("微信登录回调被拒(HTTP %d)", status)
	}
	// 权威确认:会话真的建立了
	loggedIn, _, err := s.Status(ctx)
	if err != nil {
		return fmt.Errorf("登录状态确认失败: %w", err)
	}
	if !loggedIn {
		return fmt.Errorf("微信登录未生效(回调已走通但会话无效),请重试")
	}
	return nil
}

// fetch GET 任意 URL(带 cookie 存储,吸收 Set-Cookie),返回响应体。
// 微信侧页面/图片/长轮询都走这里;长轮询可能挂 ~25s,交由 ctx 控制。
func (s *Service) fetch(ctx context.Context, rawURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	if h := s.store.header(req.URL); h != "" {
		req.Header.Set("Cookie", h)
	}
	resp, err := s.lp.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	s.store.update(resp.Request.URL, resp.Cookies())
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 4<<20))
}

// ==================== 本地 HTTP ====================

func (s *Service) handleWechatStart(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	qr, err := s.StartWechatLogin(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"qr": qr})
}

func (s *Service) handleWechatPoll(w http.ResponseWriter, r *http.Request) {
	// 微信长轮询最长 ~25s,给 35s 余量;UI 拿到结果立即续轮询
	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()
	res, err := s.PollWechatLogin(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// ==================== 辅助 ====================

func jsonUnmarshal(data []byte, v any) bool {
	return len(data) > 0 && json.Unmarshal(data, v) == nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
