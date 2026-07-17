package baizhi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// fakeGateway 假模型网关(扁平 console API,对齐 2026-07-17 真机测绘):
// 模型列表 + 密钥列表(仅掩码)/创建(明文一次,默认停用)/PATCH 启用。
type fakeGateway struct {
	keys       []apiKeyItem // 服务端持有的密钥(Key 存明文,列表时只回掩码)
	nextID     int64
	createLog  int      // POST 创建次数
	patchLog   []string // PATCH 启用的密钥名
	patchNoNam bool     // 记录 PATCH 是否缺 name(真机契约:缺 name 400)
}

func mask(key string) string {
	if len(key) < 12 {
		return key
	}
	return key[:8] + strings.Repeat("*", 8) + key[len(key)-4:]
}

func (g *fakeGateway) handler() http.Handler {
	mux := http.NewServeMux()
	j := func(w http.ResponseWriter, v any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": v, "message": ""})
	}
	mux.HandleFunc("GET /api/console/models", func(w http.ResponseWriter, r *http.Request) {
		j(w, map[string]any{"items": []map[string]any{
			{"name": "feature/gpt-5.6-luna", "interfaceType": "multi", "enabled": true, "healthStatus": "healthy"},
			{"name": "general/bge-m3", "interfaceType": "openai", "enabled": true, "healthStatus": "healthy"},
			{"name": "vip/glm-5.2", "interfaceType": "multi", "enabled": true, "healthStatus": "unhealthy"},
			{"name": "disabled/old", "interfaceType": "multi", "enabled": false, "healthStatus": "healthy"},
		}})
	})
	mux.HandleFunc("GET /api/console/api-keys", func(w http.ResponseWriter, r *http.Request) {
		items := make([]map[string]any, 0, len(g.keys))
		for _, k := range g.keys {
			items = append(items, map[string]any{
				"id": k.ID, "name": k.Name, "maskedKey": mask(k.Key), "enabled": k.Enabled,
			})
		}
		j(w, map[string]any{"items": items})
	})
	mux.HandleFunc("POST /api/console/api-keys", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		for _, k := range g.keys { // 真机契约:密钥名全局唯一
			if k.Name == body["name"] {
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 409001, "message": "资源冲突: API Key 名称已存在"})
				return
			}
		}
		g.createLog++
		g.nextID++
		k := apiKeyItem{ID: g.nextID, Name: body["name"],
			Key: fmt.Sprintf("sk-created-%04d-tail", g.nextID), Enabled: false}
		g.keys = append(g.keys, k)
		// 创建响应带明文 key(仅此一次),enabled=false 对齐真机
		j(w, map[string]any{"id": k.ID, "name": k.Name, "key": k.Key,
			"maskedKey": mask(k.Key), "enabled": false})
	})
	mux.HandleFunc("PATCH /api/console/api-keys/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name    string `json:"name"`
			Enabled bool   `json:"enabled"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Name == "" { // 真机契约:name 必填
			g.patchNoNam = true
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 400001, "message": "请求参数错误: API Key 名称不能为空"})
			return
		}
		for i := range g.keys {
			if fmt.Sprint(g.keys[i].ID) == r.PathValue("id") {
				g.keys[i].Enabled = body.Enabled
				g.patchLog = append(g.patchLog, g.keys[i].Name)
				j(w, map[string]any{"id": g.keys[i].ID, "enabled": body.Enabled})
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
	})
	return mux
}

func newSyncTestService(t *testing.T, gwURL string, mcpURL ...string) *Service {
	t.Helper()
	mcp := "http://127.0.0.1:1" // 默认快速失败(拒连),模型用例只得到 MCP note
	if len(mcpURL) > 0 {
		mcp = mcpURL[0]
	}
	s := NewServiceWithEndpoints(Endpoints{
		Account:      "http://127.0.0.1:1", // 不会被 sync 触及
		ModelGateway: gwURL,
		MCPGateway:   mcp,
	}, "")
	// 造一个非空 cookie,让 Status/empty 逻辑不误判(sync 不查 Status,但保持真实)
	base, _ := url.Parse(gwURL)
	s.store.update(base, []*http.Cookie{{Name: "baizhi_session", Value: "x", Path: "/"}})
	return s
}

// 首次同步(无已知密钥):新建密钥并启用,模型协议/端点映射正确。
func TestSyncCreatesKey(t *testing.T) {
	gw := &fakeGateway{}
	srv := httptest.NewServer(gw.handler())
	defer srv.Close()

	s := newSyncTestService(t, srv.URL)
	res, err := s.Sync(context.Background(), nil)
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}

	// 新建 + 启用了一把密钥
	if gw.createLog != 1 || !res.KeyCreated {
		t.Errorf("应新建 1 把密钥(createLog=%d, KeyCreated=%v)", gw.createLog, res.KeyCreated)
	}
	if len(gw.patchLog) != 1 || gw.patchLog[0] != syncKeyName {
		t.Errorf("应 PATCH 启用新建密钥,实际: %v", gw.patchLog)
	}
	if gw.patchNoNam {
		t.Errorf("PATCH 缺 name(真机契约 name 必填)")
	}
	if len(gw.keys) != 1 || !gw.keys[0].Enabled {
		t.Fatalf("网关侧密钥应为已启用,实际: %+v", gw.keys)
	}
	plaintext := gw.keys[0].Key

	// 模型:enabled 的 3 个(跳过 disabled),全部用新建的明文密钥
	if len(res.Models) != 3 {
		t.Fatalf("应同步 3 个启用模型,实际 %d: %+v", len(res.Models), res.Models)
	}
	for _, m := range res.Models {
		if m.APIKey != plaintext {
			t.Errorf("模型 %s 应使用新建明文密钥,实际 %q", m.Name, m.APIKey)
		}
		if m.Source != "baizhi" {
			t.Errorf("模型 %s 缺少 source 标记", m.Name)
		}
	}
	// interfaceType=openai 的走 openai 协议+端点;multi 走 anthropic
	for _, m := range res.Models {
		switch m.Name {
		case "general/bge-m3":
			if m.Provider != "openai" || m.BaseURL != srv.URL+"/api/openai" {
				t.Errorf("openai 模型协议/端点映射错误: %+v", m)
			}
		case "feature/gpt-5.6-luna":
			if m.Provider != "anthropic" || m.BaseURL != srv.URL+"/api/anthropic" {
				t.Errorf("multi 模型应走 anthropic: %+v", m)
			}
		}
	}

	// 不健康模型仍同步但有 note
	hasUnhealthyNote := false
	for _, n := range res.Notes {
		if strings.Contains(n, "健康检查未通过") {
			hasUnhealthyNote = true
		}
	}
	if !hasUnhealthyNote {
		t.Errorf("应有不健康模型的 note,实际 notes: %v", res.Notes)
	}
}

// 网关已有同名密钥但明文不可得(别的设备建的):换名新建 MonkeyCode-2,不动旧 key。
func TestSyncCreateAvoidsNameConflict(t *testing.T) {
	gw := &fakeGateway{keys: []apiKeyItem{
		{ID: 1, Name: syncKeyName, Key: "sk-other-device-0000", Enabled: true},
	}, nextID: 1}
	srv := httptest.NewServer(gw.handler())
	defer srv.Close()

	s := newSyncTestService(t, srv.URL)
	res, err := s.Sync(context.Background(), nil) // 无已知密钥,掩码对不上
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if !res.KeyCreated || gw.createLog != 1 {
		t.Fatalf("应换名新建(KeyCreated=%v createLog=%d)", res.KeyCreated, gw.createLog)
	}
	if res.KeyName != syncKeyName+"-2" {
		t.Errorf("结果应带实际密钥名 %s-2,实际 %q", syncKeyName, res.KeyName)
	}
	if len(gw.keys) != 2 || gw.keys[1].Name != syncKeyName+"-2" {
		t.Errorf("新密钥应名为 %s-2,实际: %+v", syncKeyName, gw.keys)
	}
	if !gw.keys[0].Enabled || gw.keys[0].Key != "sk-other-device-0000" {
		t.Errorf("不应动别的设备的同名旧 key: %+v", gw.keys[0])
	}
}

// 再次同步(带已知密钥):掩码对上 → 复用不新建。
func TestSyncReusesKnownKey(t *testing.T) {
	existing := "sk-exist-abcdef-1234"
	gw := &fakeGateway{keys: []apiKeyItem{{ID: 7, Name: "MonkeyCode", Key: existing, Enabled: true}}, nextID: 7}
	srv := httptest.NewServer(gw.handler())
	defer srv.Close()

	s := newSyncTestService(t, srv.URL)
	res, err := s.Sync(context.Background(), []string{"sk-other-nomatch-9999", existing})
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if gw.createLog != 0 || res.KeyCreated {
		t.Errorf("已知密钥对上掩码应复用,不应新建(createLog=%d, KeyCreated=%v)", gw.createLog, res.KeyCreated)
	}
	if len(gw.patchLog) != 0 {
		t.Errorf("已启用密钥不应再 PATCH,实际: %v", gw.patchLog)
	}
	for _, m := range res.Models {
		if m.APIKey != existing {
			t.Fatalf("模型应复用已知密钥,实际 %q", m.APIKey)
		}
	}
}

// 已知密钥对上但网关侧被停用:自动重新启用后复用。
func TestSyncReenablesDisabledKnownKey(t *testing.T) {
	existing := "sk-exist-abcdef-1234"
	gw := &fakeGateway{keys: []apiKeyItem{{ID: 7, Name: "MonkeyCode", Key: existing, Enabled: false}}, nextID: 7}
	srv := httptest.NewServer(gw.handler())
	defer srv.Close()

	s := newSyncTestService(t, srv.URL)
	res, err := s.Sync(context.Background(), []string{existing})
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if gw.createLog != 0 || res.KeyCreated {
		t.Errorf("不应新建密钥(createLog=%d)", gw.createLog)
	}
	if len(gw.patchLog) != 1 || !gw.keys[0].Enabled {
		t.Errorf("应 PATCH 重新启用已停用密钥,实际 patchLog=%v enabled=%v", gw.patchLog, gw.keys[0].Enabled)
	}
}

// fakeToolkit 假 agent-toolkit(MCP 网关,契约来自前端 bundle 测绘):
// /api/v1/* 包壳 code="ok";每 host 独立 sl-session(GET / 下发,API 强校验);
// 未开通模式下 /api/v1/* 一律 302 到权限申请页。
type fakeToolkit struct {
	noAccess  bool
	keys      []map[string]any // {id,name,masked_key,status}
	plaintext map[string]string
	createLog []map[string]any // POST api-keys 的请求体
	enableLog []string
}

func (g *fakeToolkit) handler() http.Handler {
	mux := http.NewServeMux()
	j := func(w http.ResponseWriter, v any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"code": "ok", "message": "", "data": v})
	}
	guard := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if g.noAccess {
				http.Redirect(w, r, "https://baizhi.cloud/console/permission-apply?app_id=39", http.StatusFound)
				return
			}
			if c, err := r.Cookie("sl-session"); err != nil || c.Value != "toolkit-sess" {
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 401, "message": "未登录"})
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "sl-session", Value: "toolkit-sess", Path: "/"})
		w.Header().Set("content-type", "text/html")
		_, _ = w.Write([]byte("<!doctype html><title>Agent 工具包</title>"))
	})
	mux.HandleFunc("GET /api/v1/services", guard(func(w http.ResponseWriter, r *http.Request) {
		j(w, map[string]any{"items": []map[string]any{
			{"name": "Context7", "catalog_code": "context7"},
			{"name": "网页搜索", "catalog_code": "web-search"},
		}})
	}))
	mux.HandleFunc("GET /api/v1/api-keys", guard(func(w http.ResponseWriter, r *http.Request) {
		j(w, map[string]any{"items": g.keys})
	}))
	mux.HandleFunc("POST /api/v1/api-keys", guard(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		g.createLog = append(g.createLog, body)
		j(w, map[string]any{"id": "k-new", "name": body["name"], "key": "atk-created-plain", "status": "enabled"})
	}))
	mux.HandleFunc("GET /api/v1/api-keys/{id}/reveal", guard(func(w http.ResponseWriter, r *http.Request) {
		if k, ok := g.plaintext[r.PathValue("id")]; ok {
			j(w, map[string]any{"key": k})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	mux.HandleFunc("POST /api/v1/api-keys/{id}/enable", guard(func(w http.ResponseWriter, r *http.Request) {
		g.enableLog = append(g.enableLog, r.PathValue("id"))
		j(w, map[string]any{"ok": true})
	}))
	return mux
}

// 模型网关 + MCP 网关全链路:已有启用密钥 → 握手领 sl-session → reveal 明文 →
// 单条目 streamable-http 带 Bearer 头。
func TestSyncMCPRevealsExistingKey(t *testing.T) {
	gw := &fakeGateway{}
	gwSrv := httptest.NewServer(gw.handler())
	defer gwSrv.Close()
	tk := &fakeToolkit{
		keys:      []map[string]any{{"id": "k-7", "name": "别的key", "status": "enabled"}},
		plaintext: map[string]string{"k-7": "atk-plain-777"},
	}
	tkSrv := httptest.NewServer(tk.handler())
	defer tkSrv.Close()

	s := newSyncTestService(t, gwSrv.URL, tkSrv.URL)
	res, err := s.Sync(context.Background(), nil)
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	entry, ok := res.MCP[mcpEntryName]
	if !ok {
		t.Fatalf("应产出 %s 条目,实际: %+v(notes: %v)", mcpEntryName, res.MCP, res.Notes)
	}
	if entry["url"] != tkSrv.URL+"/mcp" {
		t.Errorf("MCP url 应为运行时单端点 /mcp,实际: %v", entry["url"])
	}
	hdr, _ := entry["headers"].(map[string]string)
	if hdr["Authorization"] != "Bearer atk-plain-777" {
		t.Errorf("应带 reveal 出的明文 Bearer 头,实际: %v", entry["headers"])
	}
	if len(tk.createLog) != 0 {
		t.Errorf("已有启用密钥不应新建,实际创建了 %d 次", len(tk.createLog))
	}
}

// 无任何密钥 → 新建(授权全部服务的 catalog_code)。
func TestSyncMCPCreatesKey(t *testing.T) {
	gw := &fakeGateway{}
	gwSrv := httptest.NewServer(gw.handler())
	defer gwSrv.Close()
	tk := &fakeToolkit{plaintext: map[string]string{}}
	tkSrv := httptest.NewServer(tk.handler())
	defer tkSrv.Close()

	s := newSyncTestService(t, gwSrv.URL, tkSrv.URL)
	res, err := s.Sync(context.Background(), nil)
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if len(tk.createLog) != 1 {
		t.Fatalf("应新建 1 把 MCP 密钥,实际 %d(notes: %v)", len(tk.createLog), res.Notes)
	}
	codes, _ := tk.createLog[0]["tool_codes"].([]any)
	if tk.createLog[0]["name"] != syncKeyName || len(codes) != 2 {
		t.Errorf("新建载荷应为 name=%s + 全部 tool_codes,实际: %+v", syncKeyName, tk.createLog[0])
	}
	hdr, _ := res.MCP[mcpEntryName]["headers"].(map[string]string)
	if hdr["Authorization"] != "Bearer atk-created-plain" {
		t.Errorf("应使用新建明文密钥,实际: %v", res.MCP[mcpEntryName])
	}
	// 创建响应 status=enabled,不应再 enable
	if len(tk.enableLog) != 0 {
		t.Errorf("已启用的新建密钥不应再 enable: %v", tk.enableLog)
	}
}

// 团队未开通 Agent 工具包:302 → 优雅降级为 note,模型同步不受影响。
func TestSyncMCPNoAccess(t *testing.T) {
	gw := &fakeGateway{}
	gwSrv := httptest.NewServer(gw.handler())
	defer gwSrv.Close()
	tk := &fakeToolkit{noAccess: true}
	tkSrv := httptest.NewServer(tk.handler())
	defer tkSrv.Close()

	s := newSyncTestService(t, gwSrv.URL, tkSrv.URL)
	res, err := s.Sync(context.Background(), nil)
	if err != nil {
		t.Fatalf("未开通 MCP 不应致死: %v", err)
	}
	if len(res.MCP) != 0 {
		t.Errorf("未开通不应产出 MCP 条目: %+v", res.MCP)
	}
	found := false
	for _, n := range res.Notes {
		if strings.Contains(n, "未开通") {
			found = true
		}
	}
	if !found {
		t.Errorf("应有未开通提示 note,实际: %v", res.Notes)
	}
	if len(res.Models) != 3 {
		t.Errorf("模型同步不应受 MCP 影响,实际 %d", len(res.Models))
	}
}

// 掩码匹配:前后缀比对,长度不足不误判。
func TestMaskedMatch(t *testing.T) {
	cases := []struct {
		masked, key string
		want        bool
	}{
		{"sk-7c263*******27e2", "sk-7c263-middle-part-27e2", true},
		{"sk-7c263*******27e2", "sk-9dda9-middle-part-76b0", false},
		{"sk-7c263*******27e2", "sk-7c263", false}, // 长度不足前缀+后缀
		{"sk-nostar", "sk-nostar", true},           // 无星号退化为全等
	}
	for _, c := range cases {
		if got := maskedMatch(c.masked, c.key); got != c.want {
			t.Errorf("maskedMatch(%q, %q) = %v, want %v", c.masked, c.key, got, c.want)
		}
	}
}
