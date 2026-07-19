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
	if err := s.mcCall(ctx, http.MethodGet, "/api/v1/users/status", nil, &out); err != nil {
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
// status 可选,逗号分隔多值(pending,processing,error,finished),空为全部。
func (s *Service) MonkeyCodeTasks(ctx context.Context, page, size int, status string) (json.RawMessage, error) {
	q := url.Values{}
	q.Set("page", strconv.Itoa(page))
	q.Set("size", strconv.Itoa(size))
	if status != "" {
		q.Set("status", status)
	}
	var out json.RawMessage
	if err := s.mcCall(ctx, http.MethodGet, "/api/v1/users/tasks?"+q.Encode(), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// MonkeyCodeTaskInfo 云端任务详情(ProjectTask 原样透传 UI)。
func (s *Service) MonkeyCodeTaskInfo(ctx context.Context, id string) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.mcCall(ctx, http.MethodGet, "/api/v1/users/tasks/"+url.PathEscape(id), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// MonkeyCodeTaskRounds 云端任务历史回放(一次一轮或多轮)。
// 归一为 UI 帧词汇:chunk 的 event→type,时间戳纳秒→毫秒;data(base64)原样透传,
// 与本地会话的 Frame 结构同构,UI 的帧归约层可直接消费。
func (s *Service) MonkeyCodeTaskRounds(ctx context.Context, id, cursor string, limit int) (map[string]any, error) {
	q := url.Values{}
	q.Set("id", id)
	q.Set("limit", strconv.Itoa(limit))
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	var out struct {
		Chunks []struct {
			Data      json.RawMessage `json:"data"`
			Event     string          `json:"event"`
			Kind      string          `json:"kind"`
			Timestamp int64           `json:"timestamp"`
			Seq       uint64          `json:"seq"`
			TurnSeq   uint32          `json:"turn_seq"`
		} `json:"chunks"`
		NextCursor string `json:"next_cursor"`
		HasMore    bool   `json:"has_more"`
	}
	if err := s.mcCall(ctx, http.MethodGet, "/api/v1/users/tasks/rounds?"+q.Encode(), nil, &out); err != nil {
		return nil, err
	}
	frames := make([]map[string]any, 0, len(out.Chunks))
	for _, c := range out.Chunks {
		ts := c.Timestamp
		if ts > 1e14 { // 纳秒级(rounds 落盘粒度)转毫秒,对齐 WS 下行
			ts /= 1e6
		}
		f := map[string]any{"type": c.Event, "timestamp": ts}
		if c.Kind != "" {
			f["kind"] = c.Kind
		}
		if len(c.Data) > 0 {
			f["data"] = c.Data
		}
		if c.Seq > 0 {
			f["seq"] = c.Seq
		}
		frames = append(frames, f)
	}
	return map[string]any{"frames": frames, "next_cursor": out.NextCursor, "has_more": out.HasMore}, nil
}

// MonkeyCodeTaskStop 终止云端任务(区别于 WS 上行 user-cancel:那只中断当前执行)。
func (s *Service) MonkeyCodeTaskStop(ctx context.Context, id string) error {
	return s.mcCall(ctx, http.MethodPut, "/api/v1/users/tasks/stop", map[string]string{"id": id}, nil)
}

// ==================== 云端建任务 ====================

// 云端建任务默认值,与 mobile TASK_DEFAULTS / DEFAULT_SKILL_IDS 及 Web 端一致:
// 个人云端固定公共宿主机 + opencode CLI + 2 核 8G 3 小时 + 官方四技能。
var mcDefaultSkillIDs = []string{
	"MonkeyCodeOfficialPlugins/main/skills/feature-design",
	"MonkeyCodeOfficialPlugins/main/skills/project-wiki",
	"MonkeyCodeOfficialPlugins/main/skills/feature-implementer",
	"MonkeyCodeOfficialPlugins/main/skills/implementation-planner",
}

// MCCreateTaskReq UI 提交的最小建任务请求;其余字段内核补默认值。
type MCCreateTaskReq struct {
	Content   string `json:"content"`
	ModelID   string `json:"model_id"`
	ImageID   string `json:"image_id"`
	RepoURL   string `json:"repo_url"`   // 空 = 不关联仓库(快速开始)
	Branch    string `json:"branch"`     // 仅 RepoURL 非空时有意义
	ProjectID string `json:"project_id"` // 选了已有项目时带上
}

// MonkeyCodeCreateTask 创建云端任务;返回云端 ProjectTask(含 id)。
// 首轮由服务端用 content 自动启动,客户端建完直接 attach 看流即可。
func (s *Service) MonkeyCodeCreateTask(ctx context.Context, req MCCreateTaskReq) (json.RawMessage, error) {
	if req.Content == "" || req.ModelID == "" || req.ImageID == "" {
		return nil, fmt.Errorf("任务描述、模型与镜像不能为空")
	}
	repo := map[string]string{}
	if req.RepoURL != "" {
		repo["repo_url"] = req.RepoURL
		if req.Branch != "" {
			repo["branch"] = req.Branch
		}
	}
	extra := map[string]any{"skill_ids": mcDefaultSkillIDs}
	if req.ProjectID != "" {
		extra["project_id"] = req.ProjectID
	}
	payload := map[string]any{
		"content":   req.Content,
		"host_id":   "public_host",
		"image_id":  req.ImageID,
		"model_id":  req.ModelID,
		"repo":      repo,
		"cli_name":  "opencode",
		"resource":  map[string]any{"core": 2, "memory": uint64(8) << 30, "life": 3 * 60 * 60},
		"task_type": "develop",
		"extra":     extra,
	}
	var out json.RawMessage
	if err := s.mcCall(ctx, http.MethodPost, "/api/v1/users/tasks", payload, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// MonkeyCodeTaskOptions 建任务所需的下拉数据:模型/镜像/项目/订阅档。
// 项目与订阅失败可容忍(与 mobile 一致:catch 后置空),模型/镜像失败即报错。
func (s *Service) MonkeyCodeTaskOptions(ctx context.Context) (map[string]any, error) {
	var models struct {
		Models json.RawMessage `json:"models"`
	}
	if err := s.mcCall(ctx, http.MethodGet, "/api/v1/users/models", nil, &models); err != nil {
		return nil, err
	}
	var images struct {
		Images json.RawMessage `json:"images"`
	}
	if err := s.mcCall(ctx, http.MethodGet, "/api/v1/users/images", nil, &images); err != nil {
		return nil, err
	}
	res := map[string]any{
		"models":   orEmptyArray(models.Models),
		"images":   orEmptyArray(images.Images),
		"projects": json.RawMessage("[]"),
		"plan":     "",
	}
	var projects struct {
		Projects json.RawMessage `json:"projects"`
	}
	if err := s.mcCall(ctx, http.MethodGet, "/api/v1/users/projects?limit=50", nil, &projects); err == nil {
		res["projects"] = orEmptyArray(projects.Projects)
	}
	var sub struct {
		Plan string `json:"plan"`
	}
	if err := s.mcCall(ctx, http.MethodGet, "/api/v1/users/subscription", nil, &sub); err == nil {
		res["plan"] = sub.Plan
	}
	return res, nil
}

func orEmptyArray(v json.RawMessage) json.RawMessage {
	if len(v) == 0 || string(v) == "null" {
		return json.RawMessage("[]")
	}
	return v
}

// mcCall 请求 MonkeyCode 云端接口并解开 {code,message,data} 包壳
// (语义对齐移动端 client.ts request:401 即会话失效,code!=0 即业务失败)。
func (s *Service) mcCall(ctx context.Context, method, path string, body, out any) error {
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
