package baizhi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// 同步:登录后从模型网关拉模型清单并确保有一把可用的推理密钥,产出内核可
// 直接落盘的清单(models.json 条目 + mcp.json servers)。UI 拿到后交用户确认再保存重启。
//
// 真机契约(2026-07-17 带真实 cookie 测绘,ai-api-gateway):
//   - console API 是扁平的,没有 spaces 概念(GET /api/console/spaces → 404);
//     团队 space 会话可直接列模型/管理密钥,无需任何切换
//   - GET   /api/console/models?page&pageSize → items[{name,interfaceType,enabled,healthStatus,…}]
//   - GET   /api/console/api-keys?page&pageSize → items[{id,name,maskedKey,enabled,…}](仅掩码)
//   - POST  /api/console/api-keys {name} → data{id,key(明文,仅此一次),enabled:false}
//   - PATCH /api/console/api-keys/{id} {name,enabled} 启用(name 必填,否则 400)
//   - 推理 base_url:<网关>/api/anthropic(x-api-key,拼 /v1/messages)与
//     <网关>/api/openai(Bearer,拼 /chat/completions);双协议真机冒烟 200
//
// 密钥策略:列表只给掩码,明文只在创建时返回一次 → 优先用调用方已持有的密钥
// (掩码前后缀匹配 + 必要时 PATCH 重新启用),都对不上才新建一把并启用。

// SyncedModel 同步产出的单个模型(字段与 UI 设置表单 / mc-desktop 清单同构)。
type SyncedModel struct {
	Name          string `json:"name"`
	Provider      string `json:"provider"` // anthropic | openai
	BaseURL       string `json:"base_url"`
	APIKey        string `json:"api_key"`
	Model         string `json:"model"`
	ContextWindow int    `json:"context_window,omitempty"`
	Vision        bool   `json:"vision,omitempty"`
	Source        string `json:"source"` // 恒为 "baizhi",供 UI 区分手工条目与同步条目
}

// SyncResult 一次同步的完整结果(UI 据此合并进设置表单)。
type SyncResult struct {
	Models []SyncedModel             `json:"models"`
	MCP    map[string]map[string]any `json:"mcp_servers"` // name → {url, headers}
	// KeyCreated 本次是否在网关新建了密钥(false = 复用了已有密钥)
	KeyCreated bool `json:"key_created"`
	// KeyName 使用的密钥在网关里的名字(同名被占时新建的是 MonkeyCode-N)
	KeyName string `json:"key_name,omitempty"`
	// Notes 非致命提示(如 MCP 为空、部分模型不健康),UI 可展示
	Notes []string `json:"notes,omitempty"`
}

// syncKeyName 同步新建密钥的名字(网关控制台里用户可见)。
const syncKeyName = "MonkeyCode"

// sourceBaizhi 同步条目的 source 标记(UI 按它分组/整组替换)。
// UI 侧对应常量:agent/ui/src/types.ts 的 SOURCE_BAIZHI,两侧改动需同步。
const sourceBaizhi = "baizhi"

// Sync 拉模型清单 + 确保推理密钥。要求已登录(有 cookie)。
// knownKeys 是调用方已持有的候选明文密钥(如设置表单里现有条目的 api_key),
// 能对上网关掩码列表就复用,避免每次同步都新建密钥。
func (s *Service) Sync(ctx context.Context, knownKeys []string) (*SyncResult, error) {
	res := &SyncResult{MCP: map[string]map[string]any{}}

	key, keyName, created, err := s.ensureAPIKey(ctx, knownKeys)
	if err != nil {
		return nil, err
	}
	res.KeyCreated = created
	res.KeyName = keyName

	models, notes, err := s.gatewayModels(ctx, key)
	if err != nil {
		return nil, err
	}
	res.Models = models
	res.Notes = append(res.Notes, notes...)

	mcp, mcpNotes := s.mcpServers(ctx)
	res.MCP = mcp
	res.Notes = append(res.Notes, mcpNotes...)

	return res, nil
}

// gwURL 模型网关(console)绝对地址。
func (s *Service) gwURL(path string) string { return s.ep.ModelGateway + path }

// getJSON 对模型网关发 GET 并解开 {code,data,message} 包壳到 out。
func (s *Service) getJSON(ctx context.Context, path string, out any) error {
	return s.consoleCall(ctx, http.MethodGet, path, nil, out)
}

// consoleCall 模型网关请求(带 cookie),解包 {code,data,message};out 收 data。
func (s *Service) consoleCall(ctx context.Context, method, path string, body, out any) error {
	data, status, err := s.do(ctx, method, s.gwURL(path), body)
	if err != nil {
		return err
	}
	var env struct {
		Code    *int            `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &env) != nil {
		if is2xx(status) {
			return nil
		}
		return httpError(status, string(data))
	}
	if !is2xx(status) || (env.Code != nil && *env.Code != 0) {
		msg := cleanMessage(env.Message)
		if msg == "" {
			return httpError(status, "")
		}
		if status == http.StatusUnauthorized {
			return &unauthorizedError{msg}
		}
		return fmt.Errorf("%s", msg)
	}
	if out != nil && len(env.Data) > 0 {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return fmt.Errorf("网关响应解析失败: %w", err)
		}
	}
	return nil
}

// apiKeyItem 网关密钥条目(列表仅掩码;创建响应额外带 key 明文)。
type apiKeyItem struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Key       string `json:"key"` // 仅创建响应有
	MaskedKey string `json:"maskedKey"`
	Enabled   bool   `json:"enabled"`
}

// ensureAPIKey 确保拿到一把可用(存在且启用)的明文推理密钥。
// 返回 (key, 网关里的密钥名, 是否本次新建, err)。
func (s *Service) ensureAPIKey(ctx context.Context, knownKeys []string) (string, string, bool, error) {
	var list struct {
		Items []apiKeyItem `json:"items"`
	}
	if err := s.getJSON(ctx, "/api/console/api-keys?page=1&pageSize=200", &list); err != nil {
		return "", "", false, fmt.Errorf("获取密钥列表失败: %w", err)
	}

	// 已持有的明文密钥能对上网关掩码 → 复用(停用的先重新启用)
	for _, k := range knownKeys {
		k = strings.TrimSpace(k)
		if !strings.HasPrefix(k, "sk-") {
			continue
		}
		for _, it := range list.Items {
			if !maskedMatch(it.MaskedKey, k) {
				continue
			}
			if !it.Enabled {
				if err := s.enableAPIKey(ctx, it); err != nil {
					return "", "", false, fmt.Errorf("重新启用密钥「%s」失败: %w", it.Name, err)
				}
			}
			return k, it.Name, false, nil
		}
	}

	// 新建 + 启用(新建的密钥默认停用)。密钥名全局唯一(真机 409"名称已存在"),
	// 且列表无明文、无 reveal:同名旧 key 的明文已不可恢复,只能换名新建
	// (不能动旧 key——它的明文可能正被别的设备使用)。
	name, err := s.pickKeyName(list.Items)
	if err != nil {
		return "", "", false, err
	}
	var created apiKeyItem
	if err := s.consoleCall(ctx, http.MethodPost, "/api/console/api-keys",
		map[string]string{"name": name}, &created); err != nil {
		return "", "", false, fmt.Errorf("创建密钥失败: %w", err)
	}
	if created.Key == "" {
		return "", "", false, fmt.Errorf("创建密钥成功但响应未含明文密钥")
	}
	if err := s.enableAPIKey(ctx, created); err != nil {
		return "", "", false, fmt.Errorf("启用新建密钥失败: %w", err)
	}
	return created.Key, name, true, nil
}

// pickKeyName 选一个与现有密钥不撞名的名字:MonkeyCode、MonkeyCode-2、…
func (s *Service) pickKeyName(existing []apiKeyItem) (string, error) {
	taken := map[string]bool{}
	for _, it := range existing {
		taken[it.Name] = true
	}
	if !taken[syncKeyName] {
		return syncKeyName, nil
	}
	for i := 2; i <= 99; i++ {
		if name := fmt.Sprintf("%s-%d", syncKeyName, i); !taken[name] {
			return name, nil
		}
	}
	return "", fmt.Errorf("网关中 %s 系列密钥过多,请在百智云控制台清理后重试", syncKeyName)
}

// enableAPIKey 启用密钥。PATCH 要求 name 必填(真机 400 实测)。
func (s *Service) enableAPIKey(ctx context.Context, it apiKeyItem) error {
	return s.consoleCall(ctx, http.MethodPatch, fmt.Sprintf("/api/console/api-keys/%d", it.ID),
		map[string]any{"name": it.Name, "enabled": true}, nil)
}

// maskedMatch 明文密钥与网关掩码是否指同一把 key。
// 掩码形如 sk-7c263***…***27e2:比对首段前缀 + 末段后缀。
func maskedMatch(masked, key string) bool {
	i := strings.IndexByte(masked, '*')
	j := strings.LastIndexByte(masked, '*')
	if i <= 0 || j < i {
		return masked == key
	}
	prefix, suffix := masked[:i], masked[j+1:]
	return len(key) >= len(prefix)+len(suffix) &&
		strings.HasPrefix(key, prefix) && strings.HasSuffix(key, suffix)
}

// gatewayModel 网关模型列表项(仅取同步所需字段)。
type gatewayModel struct {
	Name          string `json:"name"`
	InterfaceType string `json:"interfaceType"` // multi | openai | anthropic
	Enabled       bool   `json:"enabled"`
	HealthStatus  string `json:"healthStatus"`
}

// gatewayModels 拉模型列表并映射为 SyncedModel。协议优先 anthropic
// (multi/anthropic 走 anthropic 端点;纯 openai 走 openai 端点)。
// 停用模型跳过;不健康的仍同步但记 note(可能临时抖动)。
func (s *Service) gatewayModels(ctx context.Context, key string) ([]SyncedModel, []string, error) {
	var data struct {
		Items []gatewayModel `json:"items"`
	}
	if err := s.getJSON(ctx, "/api/console/models?page=1&pageSize=200", &data); err != nil {
		return nil, nil, fmt.Errorf("获取模型列表失败: %w", err)
	}
	var models []SyncedModel
	var notes []string
	unhealthy := 0
	for _, m := range data.Items {
		if !m.Enabled || m.Name == "" {
			continue
		}
		provider := "anthropic"
		baseURL := s.gwURL("/api/anthropic")
		if m.InterfaceType == "openai" {
			provider = "openai"
			baseURL = s.gwURL("/api/openai")
		}
		if m.HealthStatus != "" && m.HealthStatus != "healthy" {
			unhealthy++
		}
		models = append(models, SyncedModel{
			Name:     m.Name,
			Provider: provider,
			BaseURL:  baseURL,
			APIKey:   key,
			Model:    m.Name,
			Source:   sourceBaizhi,
		})
	}
	if len(models) == 0 {
		notes = append(notes, "网关下没有已启用的模型")
	}
	if unhealthy > 0 {
		notes = append(notes, fmt.Sprintf("其中 %d 个模型当前健康检查未通过(仍会同步,可能临时抖动)", unhealthy))
	}
	return models, notes, nil
}

// ==================== MCP(agent-toolkit)====================
//
// 契约(2026-07-17 从前端 bundle 测绘;账号未开通,响应结构待真实数据复核):
//   - 管理 API 同源 /api/v1/*,cookie 鉴权;包壳 {code,message,data},
//     code 为字符串 "ok"(或 0/200)表成功
//   - 每个 host 独立 sl-session:先 GET / 让服务端 set-cookie,再调 API
//   - 团队未开通 Agent 工具包时 /api/v1/* 一律 302 → 权限申请页
//   - GET  /api/v1/services → items[{name,description,catalog_code,…}]
//   - GET  /api/v1/api-keys → items[{id,name,masked_key,status,tool_codes}]
//   - GET  /api/v1/api-keys/{id}/reveal → {key}(明文可随时取回)
//   - POST /api/v1/api-keys {name,tool_codes} → 新建(响应含明文 key)
//   - POST /api/v1/api-keys/{id}/enable 启用
//   - 运行时:<MCP 网关>/mcp,Streamable HTTP,Authorization: Bearer <key>
//     (单端点承载全部服务,一把 key 即一个 mcp.json 条目)

// mcpEntryName 同步产出的 mcp.json 条目名(工具命名空间前缀 mcp__<name>__)。
const mcpEntryName = "baizhi-toolkit"

// errMCPNoAccess 团队未开通 Agent 工具包(管理 API 302 到权限申请页)。
var errMCPNoAccess = fmt.Errorf("当前团队未开通 Agent 工具包")

// mcpURL MCP 网关绝对地址。
func (s *Service) mcpURL(path string) string { return s.ep.MCPGateway + path }

// mcpCall agent-toolkit 管理 API 请求。与 consoleCall 的差异:
// code 可能是字符串 "ok";3xx 视为未开通(不跟随重定向,首响应即 302)。
func (s *Service) mcpCall(ctx context.Context, method, path string, body, out any) error {
	data, status, err := s.do(ctx, method, s.mcpURL(path), body)
	if err != nil {
		return err
	}
	if status >= 300 && status < 400 {
		return errMCPNoAccess
	}
	var env struct {
		Code    json.RawMessage `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &env) != nil {
		if is2xx(status) {
			return nil
		}
		return httpError(status, string(data))
	}
	if !is2xx(status) || !mcpCodeOK(env.Code) {
		msg := cleanMessage(env.Message)
		if msg == "" {
			return httpError(status, "")
		}
		if status == http.StatusUnauthorized {
			return &unauthorizedError{msg}
		}
		return fmt.Errorf("%s", msg)
	}
	if out != nil && len(env.Data) > 0 {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return fmt.Errorf("MCP 网关响应解析失败: %w", err)
		}
	}
	return nil
}

// mcpCodeOK 包壳 code 是否表示成功(缺省/"ok"/0/200)。
func mcpCodeOK(raw json.RawMessage) bool {
	switch strings.TrimSpace(string(raw)) {
	case "", "null", `"ok"`, "0", "200":
		return true
	}
	return false
}

// mcpService 服务目录项。
type mcpService struct {
	Name        string `json:"name"`
	CatalogCode string `json:"catalog_code"`
}

// mcpKeyItem MCP 访问密钥条目。id 类型未实测(数字或字符串),原样保留。
type mcpKeyItem struct {
	ID     json.RawMessage `json:"id"`
	Name   string          `json:"name"`
	Key    string          `json:"key"` // 仅 create/reveal 响应有
	Status string          `json:"status"`
}

func (k mcpKeyItem) idPath() string {
	return strings.Trim(strings.TrimSpace(string(k.ID)), `"`)
}

// mcpServers 拉 Agent 工具包服务并确保一把 MCP 密钥,映射为单个
// streamable-http 条目(运行时是单端点 /mcp)。
// 非致命:任何一步失败仅记 note,不阻断模型同步。
func (s *Service) mcpServers(ctx context.Context) (map[string]map[string]any, []string) {
	out := map[string]map[string]any{}

	// 握手:agent-toolkit 的 sl-session 按 host 独立,先 GET / 领取
	_, _, _ = s.do(ctx, http.MethodGet, s.mcpURL("/"), nil)

	var svc struct {
		Items []mcpService `json:"items"`
	}
	if err := s.mcpCall(ctx, http.MethodGet, "/api/v1/services", nil, &svc); err != nil {
		if err == errMCPNoAccess {
			return out, []string{"当前团队未开通 Agent 工具包,已跳过 MCP 同步(可在百智云控制台申请开通)"}
		}
		return out, []string{"获取 MCP 服务失败: " + err.Error()}
	}
	if len(svc.Items) == 0 {
		return out, []string{"Agent 工具包下没有可用的 MCP 服务"}
	}
	codes := make([]string, 0, len(svc.Items))
	names := make([]string, 0, len(svc.Items))
	for _, it := range svc.Items {
		if it.CatalogCode != "" {
			codes = append(codes, it.CatalogCode)
		}
		if it.Name != "" {
			names = append(names, it.Name)
		}
	}

	key, note := s.ensureMCPKey(ctx, codes)
	if key == "" {
		return out, []string{note}
	}
	out[mcpEntryName] = map[string]any{
		"url":     s.mcpURL("/mcp"),
		"headers": map[string]string{"Authorization": "Bearer " + key},
	}
	notes := []string{fmt.Sprintf("MCP 已同步(含 %d 个服务: %s)", len(svc.Items), strings.Join(names, "、"))}
	if note != "" {
		notes = append(notes, note)
	}
	return out, notes
}

// ensureMCPKey 确保拿到一把可用的 MCP 明文密钥;返回 (key, note)。
// 与模型网关不同,这里明文可经 reveal 随时取回,无需调用方回传候选。
func (s *Service) ensureMCPKey(ctx context.Context, toolCodes []string) (string, string) {
	var list struct {
		Items []mcpKeyItem `json:"items"`
	}
	if err := s.mcpCall(ctx, http.MethodGet, "/api/v1/api-keys", nil, &list); err != nil {
		return "", "获取 MCP 密钥列表失败: " + err.Error()
	}

	// 已有可用密钥(优先同名)→ reveal 取明文;停用的同名密钥先启用
	pick := -1
	for i, it := range list.Items {
		if it.Status == "enabled" && (pick < 0 || it.Name == syncKeyName) {
			pick = i
		}
	}
	if pick < 0 {
		for i, it := range list.Items {
			if it.Name == syncKeyName { // 只碰自家条目,不动用户手工停用的密钥
				if err := s.mcpCall(ctx, http.MethodPost, "/api/v1/api-keys/"+it.idPath()+"/enable", nil, nil); err != nil {
					return "", "重新启用 MCP 密钥失败: " + err.Error()
				}
				pick = i
				break
			}
		}
	}
	if pick >= 0 {
		it := list.Items[pick]
		var rev struct {
			Key string `json:"key"`
		}
		if err := s.mcpCall(ctx, http.MethodGet, "/api/v1/api-keys/"+it.idPath()+"/reveal", nil, &rev); err != nil {
			return "", "获取 MCP 密钥明文失败: " + err.Error()
		}
		if rev.Key == "" {
			return "", "MCP 密钥明文响应为空"
		}
		return rev.Key, ""
	}

	// 没有任何可用密钥 → 新建(授权全部服务)
	var created mcpKeyItem
	if err := s.mcpCall(ctx, http.MethodPost, "/api/v1/api-keys",
		map[string]any{"name": syncKeyName, "tool_codes": toolCodes}, &created); err != nil {
		return "", "创建 MCP 密钥失败: " + err.Error()
	}
	if created.Key == "" {
		return "", "创建 MCP 密钥成功但响应未含明文"
	}
	if created.Status != "" && created.Status != "enabled" {
		if err := s.mcpCall(ctx, http.MethodPost, "/api/v1/api-keys/"+created.idPath()+"/enable", nil, nil); err != nil {
			return "", "启用新建 MCP 密钥失败: " + err.Error()
		}
	}
	return created.Key, ""
}
