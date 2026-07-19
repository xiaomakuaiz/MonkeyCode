package baizhi

// MonkeyCode 云端账号桥接:用已登录的百智云会话换取 monkeycode-ai.com 会话,
// 之后代理云端任务列表给 UI。流程与移动端 login.tsx 的 WebView 桥接一致,
// 只是把"WebView 导航拦截"换成内核里手动跟随重定向:
//
//	GET {mc}/api/v1/users/login → 302 → {baizhi}/oauth/authorize?...(授权页)
//	→ 改写为 {baizhi}/api/v1/oauth/authorize API(带百智 cookie,response_type=code)
//	→ 302 → {mc}/…/callback?code=… → Set-Cookie 落 monkeycode 会话 → 302 前端页
//
// cookie 按域分罐:百智账号域走 store,其余(monkeycode 一族)走 mc,
// 一方登出不影响另一方。云端任务数据对内核不透明(json.RawMessage 直通 UI),
// 字段契约以 backend/domain/task.go 与移动端 types.ts 为准。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// maxBridgeHops 桥接重定向链上限(实测 4~6 跳,留余量防环)。
const maxBridgeHops = 12

// LoginMonkeyCode 桥接登录:需已持有百智云会话。成功返回云端用户信息(原样)。
func (s *Service) LoginMonkeyCode(ctx context.Context) (json.RawMessage, error) {
	if s.store.empty() {
		return nil, fmt.Errorf("请先登录百智云账号")
	}
	cur := s.ep.MonkeyCode + "/api/v1/users/login?redirect=&inviter_id="
	for range maxBridgeHops {
		u, err := url.Parse(cur)
		if err != nil {
			return nil, fmt.Errorf("云端登录桥接地址异常: %w", err)
		}
		// 落到百智授权"页面"时改写为 API 端点(WebView 里这一跳由页面 JS 完成)
		if s.onAccountHost(u) && u.Path == "/oauth/authorize" {
			if cur, err = s.authorizePageToAPI(u); err != nil {
				return nil, err
			}
			u, _ = url.Parse(cur)
		}
		next, done, err := s.bridgeHop(ctx, u)
		if err != nil {
			return nil, err
		}
		if done {
			return s.confirmMonkeyCodeLogin(ctx)
		}
		cur = next
	}
	return nil, fmt.Errorf("云端登录桥接重定向次数过多")
}

// bridgeHop 执行桥接链上的一跳。done=true 表示重定向链走完(停在 2xx)。
func (s *Service) bridgeHop(ctx context.Context, u *url.URL) (next string, done bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", false, err
	}
	store := s.storeFor(u)
	if h := store.header(req.URL); h != "" {
		req.Header.Set("Cookie", h)
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("云端登录桥接失败: %w", err)
	}
	defer resp.Body.Close()
	store.update(resp.Request.URL, resp.Cookies())

	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		loc := resp.Header.Get("Location")
		if loc == "" {
			return "", false, fmt.Errorf("云端登录桥接失败: 重定向缺少目标地址")
		}
		nu, err := u.Parse(loc) // 相对地址按当前页解析
		if err != nil {
			return "", false, fmt.Errorf("云端登录桥接失败: 重定向地址异常: %w", err)
		}
		return nu.String(), false, nil
	}
	if !is2xx(resp.StatusCode) {
		if resp.StatusCode == http.StatusUnauthorized && s.onAccountHost(u) {
			return "", false, &unauthorizedError{"百智云会话已失效,请重新登录"}
		}
		return "", false, fmt.Errorf("云端登录桥接失败(HTTP %d,%s)", resp.StatusCode, u.Host)
	}
	return "", true, nil
}

// authorizePageToAPI 授权页 URL → 授权 API URL(参数校验对齐移动端)。
func (s *Service) authorizePageToAPI(page *url.URL) (string, error) {
	q := page.Query()
	clientID := q.Get("client_id")
	redirectURI := q.Get("redirect_uri")
	if redirectURI == "" {
		redirectURI = q.Get("redirect_url")
	}
	scope, state := q.Get("scope"), q.Get("state")
	if clientID == "" || redirectURI == "" || scope == "" || state == "" {
		return "", fmt.Errorf("云端登录桥接失败: 授权参数不完整")
	}
	responseType := q.Get("response_type")
	if responseType == "" {
		responseType = "code"
	}
	api := url.Values{}
	api.Set("client_id", clientID)
	api.Set("redirect_uri", redirectURI)
	api.Set("scope", scope)
	api.Set("state", state)
	api.Set("response_type", responseType)
	return s.ep.Account + "/api/v1/oauth/authorize?" + api.Encode(), nil
}

// storeFor 按目标域选 cookie 罐:百智账号域用登录会话罐,其余用云端罐。
// 比较含端口(httptest 场景两域同 IP 仅端口不同;线上域名不同、无端口,等价)。
func (s *Service) storeFor(u *url.URL) *cookieStore {
	if s.onAccountHost(u) {
		return s.store
	}
	return s.mc
}

func (s *Service) onAccountHost(u *url.URL) bool {
	au, err := url.Parse(s.ep.Account)
	if err != nil {
		return false
	}
	return u.Host == au.Host
}

// confirmMonkeyCodeLogin 桥接链走完后校验云端会话已建立,返回用户信息。
func (s *Service) confirmMonkeyCodeLogin(ctx context.Context) (json.RawMessage, error) {
	user, err := s.monkeyCodeUser(ctx)
	if err != nil {
		if isUnauthorized(err) {
			return nil, fmt.Errorf("云端登录未完成: 未获得 MonkeyCode 会话")
		}
		return nil, err
	}
	return user, nil
}

// monkeyCodeUser 拉取云端用户信息;会话无效返回 unauthorizedError。
func (s *Service) monkeyCodeUser(ctx context.Context) (json.RawMessage, error) {
	var out struct {
		User json.RawMessage `json:"user"`
	}
	if err := s.mcCall(ctx, "/api/v1/users/status", nil, &out); err != nil {
		return nil, err
	}
	// 空对象也算未登录(与移动端 hasUserIdentity 语义一致)
	var probe struct {
		ID, Name, Username, Email string
	}
	if json.Unmarshal(out.User, &probe) != nil ||
		(probe.ID == "" && probe.Name == "" && probe.Username == "" && probe.Email == "") {
		return nil, &unauthorizedError{"MonkeyCode 会话无效"}
	}
	return out.User, nil
}

// MonkeyCodeStatus 云端会话状态:有会话时返回用户信息(原样透传 UI)。
func (s *Service) MonkeyCodeStatus(ctx context.Context) (loggedIn bool, user json.RawMessage, err error) {
	if s.mc.empty() {
		return false, nil, nil
	}
	user, err = s.monkeyCodeUser(ctx)
	if err != nil {
		if isUnauthorized(err) {
			return false, nil, nil
		}
		return false, nil, err
	}
	return true, user, nil
}

// MonkeyCodeLogout 清除本地云端会话(与百智会话互不影响)。
func (s *Service) MonkeyCodeLogout() {
	s.mc.clear()
}

// monkeyCodeHost 云端服务地址(诊断展示 + UI 拼任务详情外链)。
func (s *Service) monkeyCodeHost() string {
	u, err := url.Parse(s.ep.MonkeyCode)
	if err != nil {
		return s.ep.MonkeyCode
	}
	return u.Host
}

// MonkeyCodeTasks 云端任务列表({tasks, page_info} 原样透传 UI)。
func (s *Service) MonkeyCodeTasks(ctx context.Context, page, size int) (json.RawMessage, error) {
	q := url.Values{}
	q.Set("page", strconv.Itoa(page))
	q.Set("size", strconv.Itoa(size))
	var out json.RawMessage
	if err := s.mcCall(ctx, "/api/v1/users/tasks?"+q.Encode(), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// mcCall 请求 MonkeyCode 云端接口并解开 {code,message,data} 包壳
// (语义对齐移动端 client.ts request:401 即会话失效,code!=0 即业务失败)。
func (s *Service) mcCall(ctx context.Context, path string, body, out any) error {
	method := http.MethodGet
	if body != nil {
		method = http.MethodPost
	}
	data, status, err := s.doStore(ctx, s.mc, method, s.ep.MonkeyCode+path, body)
	if err != nil {
		return err
	}
	if status == http.StatusUnauthorized {
		return &unauthorizedError{"MonkeyCode 会话已失效,请重新同步云端账号"}
	}
	var envelope struct {
		Code    *int            `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		if is2xx(status) {
			return nil
		}
		return fmt.Errorf("MonkeyCode 请求失败(HTTP %d)", status)
	}
	if (envelope.Code != nil && *envelope.Code != 0) || !is2xx(status) {
		msg := cleanMessage(envelope.Message)
		if msg == "" {
			return fmt.Errorf("MonkeyCode 请求失败(HTTP %d)", status)
		}
		return fmt.Errorf("%s", msg)
	}
	if out != nil && len(envelope.Data) > 0 {
		if err := json.Unmarshal(envelope.Data, out); err != nil {
			return fmt.Errorf("MonkeyCode 响应数据解析失败: %w", err)
		}
	}
	return nil
}
