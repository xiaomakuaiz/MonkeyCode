package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateDirectMode(t *testing.T) {
	cfg := &Config{}
	if err := cfg.Validate(); err == nil {
		t.Fatal("空配置应校验失败")
	}
	cfg = &Config{BaseURL: "https://api.example.com", APIKey: "k", Model: "m"}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("直连三元组应通过: %v", err)
	}
}

func TestValidatePlatformMode(t *testing.T) {
	cfg := &Config{PlatformURL: "https://mc.example.com", PlatformToken: "mcd_x"}
	if !cfg.UsePlatform() {
		t.Fatal("UsePlatform 应为 true")
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("平台模式无需 LLM 三元组: %v", err)
	}
	cfg.PlatformToken = ""
	if cfg.UsePlatform() {
		t.Fatal("无 token 不算平台模式")
	}
}

func TestLoadPlatformEnvOverride(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(p, []byte(`{"platform_url":"https://file.example.com","platform_token":"mcd_file"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MC_AGENT_CONFIG", p)
	t.Setenv("MC_AGENT_PLATFORM_URL", "https://env.example.com")
	t.Setenv("MC_AGENT_PLATFORM_MODEL_ID", "model-1")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PlatformURL != "https://env.example.com" {
		t.Fatalf("env 应覆盖文件: %q", cfg.PlatformURL)
	}
	if cfg.PlatformToken != "mcd_file" {
		t.Fatalf("文件值应保留: %q", cfg.PlatformToken)
	}
	if cfg.PlatformModelID != "model-1" {
		t.Fatalf("platform_model_id: %q", cfg.PlatformModelID)
	}
}
