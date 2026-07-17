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

func newSyncTestService(t *testing.T, gwURL string) *Service {
	t.Helper()
	s := NewServiceWithEndpoints(Endpoints{
		Account:      "http://127.0.0.1:1", // 不会被 sync 触及
		ModelGateway: gwURL,
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
