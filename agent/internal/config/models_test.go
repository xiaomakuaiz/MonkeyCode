package config

import (
	"os"
	"path/filepath"
	"testing"
)

func writeModels(t *testing.T, content string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MC_AGENT_MODELS", p)
}

func TestLoadModelsAbsent(t *testing.T) {
	t.Setenv("MC_AGENT_MODELS", "")
	profiles, err := LoadModels()
	if err != nil || profiles != nil {
		t.Fatalf("无清单应返回 nil,nil: %v %v", profiles, err)
	}
}

func TestLoadModelsValid(t *testing.T) {
	writeModels(t, `[
		{"name":"快速","provider":"openai","base_url":"https://a/v1","api_key":"k1","model":"gpt-x"},
		{"base_url":"https://b","api_key":"k2","model":"claude-y","default":true}
	]`)
	profiles, err := LoadModels()
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 2 {
		t.Fatalf("profiles: %+v", profiles)
	}
	// name 缺省取 model;default 唯一且在第二项
	if profiles[1].Name != "claude-y" || !profiles[1].Default || profiles[0].Default {
		t.Fatalf("default 归属错误: %+v", profiles)
	}
	if d := FindModel(profiles, ""); d == nil || d.Name != "claude-y" {
		t.Fatalf("FindModel 默认: %+v", d)
	}
	if p := FindModel(profiles, "快速"); p == nil || p.Model != "gpt-x" {
		t.Fatalf("FindModel 按名: %+v", p)
	}
	if FindModel(profiles, "不存在") != nil {
		t.Fatal("未知名应返回 nil")
	}
}

func TestLoadModelsNoDefaultTakesFirst(t *testing.T) {
	writeModels(t, `[
		{"name":"a","base_url":"u","api_key":"k","model":"m1"},
		{"name":"b","base_url":"u","api_key":"k","model":"m2"}
	]`)
	profiles, err := LoadModels()
	if err != nil || !profiles[0].Default || profiles[1].Default {
		t.Fatalf("未标记时应默认第一项: %+v err=%v", profiles, err)
	}
}

func TestLoadModelsErrors(t *testing.T) {
	cases := map[string]string{
		"字段不全":        `[{"name":"a","base_url":"u","model":"m"}]`,
		"名称重复":        `[{"name":"a","base_url":"u","api_key":"k","model":"m"},{"name":"a","base_url":"u","api_key":"k","model":"m2"}]`,
		"provider 非法": `[{"name":"a","provider":"gemini","base_url":"u","api_key":"k","model":"m"}]`,
		"非法 JSON":     `{`,
	}
	for name, content := range cases {
		writeModels(t, content)
		if _, err := LoadModels(); err == nil {
			t.Fatalf("%s 应报错", name)
		}
	}
}

// 空清单是合法状态(宿主接管配置但用户未添加模型):返回非 nil 空切片,
// 与"未设置清单"(nil)区分,serve 据此进入零模型模式而非退回单配置。
func TestLoadModelsEmptyManifest(t *testing.T) {
	writeModels(t, `[]`)
	profiles, err := LoadModels()
	if err != nil {
		t.Fatalf("空清单不应报错: %v", err)
	}
	if profiles == nil || len(profiles) != 0 {
		t.Fatalf("空清单应返回非 nil 空切片: %#v", profiles)
	}
}
