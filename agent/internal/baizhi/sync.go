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
	// Notes 非致命提示(如 MCP 为空、部分模型不健康),UI 可展示
	Notes []string `json:"notes,omitempty"`
}

// syncKeyName 同步新建密钥的名字(网关控制台里用户可见)。
const syncKeyName = "MonkeyCode"

// Sync 拉模型清单 + 确保推理密钥。要求已登录(有 cookie)。
// knownKeys 是调用方已持有的候选明文密钥(如设置表单里现有条目的 api_key),
// 能对上网关掩码列表就复用,避免每次同步都新建密钥。
func (s *Service) Sync(ctx context.Context, knownKeys []string) (*SyncResult, error) {
	res := &SyncResult{MCP: map[string]map[string]any{}}

	key, created, err := s.ensureAPIKey(ctx, knownKeys)
	if err != nil {
		return nil, err
	}
	res.KeyCreated = created

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
// 返回 (key, 是否本次新建, err)。
func (s *Service) ensureAPIKey(ctx context.Context, knownKeys []string) (string, bool, error) {
	var list struct {
		Items []apiKeyItem `json:"items"`
	}
	if err := s.getJSON(ctx, "/api/console/api-keys?page=1&pageSize=200", &list); err != nil {
		return "", false, fmt.Errorf("获取密钥列表失败: %w", err)
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
					return "", false, fmt.Errorf("重新启用密钥「%s」失败: %w", it.Name, err)
				}
			}
			return k, false, nil
		}
	}

	// 新建 + 启用(新建的密钥默认停用)
	var created apiKeyItem
	if err := s.consoleCall(ctx, http.MethodPost, "/api/console/api-keys",
		map[string]string{"name": syncKeyName}, &created); err != nil {
		return "", false, fmt.Errorf("创建密钥失败: %w", err)
	}
	if created.Key == "" {
		return "", false, fmt.Errorf("创建密钥成功但响应未含明文密钥")
	}
	if err := s.enableAPIKey(ctx, created); err != nil {
		return "", false, fmt.Errorf("启用新建密钥失败: %w", err)
	}
	return created.Key, true, nil
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
			Source:   "baizhi",
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

// mcpServers 拉 MCP 服务并映射为 mcp.json 的 http 条目。
// agent-toolkit 网关的 API 契约尚未测绘(全路径回 SPA HTML,前缀未知),
// 暂不同步,仅记 note;契约到手后在此实现,SyncResult 结构不变。
func (s *Service) mcpServers(_ context.Context) (map[string]map[string]any, []string) {
	return map[string]map[string]any{}, []string{"MCP 同步暂未开放(agent-toolkit 网关接口测绘中)"}
}
