// Package config 内核配置:优先级 flag > 环境变量 > 配置文件。
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config 运行配置。LLM 接入两种形态:
//   - 直连:base_url + api_key + model 三元组
//   - 平台:platform_url + platform_token(mc-agent login 写入),运行时向
//     MonkeyCode 换短时效模型 key,LLM 流量走平台 LLMProxy
type Config struct {
	Provider string `json:"provider"` // anthropic | openai
	BaseURL  string `json:"base_url"`
	APIKey   string `json:"api_key"`
	Model    string `json:"model"`
	// SkipTLSVerify 跳过 TLS 证书校验(不安全,仅自签名内网网关)。
	SkipTLSVerify bool `json:"skip_tls_verify,omitempty"`

	PlatformURL     string `json:"platform_url,omitempty"`
	PlatformToken   string `json:"platform_token,omitempty"`
	PlatformModelID string `json:"platform_model_id,omitempty"` // 缺省用平台默认模型
}

// Path 配置文件路径。
func Path() string {
	if v := os.Getenv("MC_AGENT_CONFIG"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".config", "mc-agent", "config.json")
}

// Load 读取配置文件并叠加环境变量。文件不存在不算错误。
func Load() (*Config, error) {
	cfg := &Config{Provider: "anthropic"}
	data, err := os.ReadFile(Path())
	if err == nil {
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("配置文件 %s 解析失败: %w", Path(), err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	if v := os.Getenv("MC_AGENT_PROVIDER"); v != "" {
		cfg.Provider = v
	}
	if v := os.Getenv("MC_AGENT_BASE_URL"); v != "" {
		cfg.BaseURL = v
	}
	if v := os.Getenv("MC_AGENT_API_KEY"); v != "" {
		cfg.APIKey = v
	}
	if v := os.Getenv("MC_AGENT_MODEL"); v != "" {
		cfg.Model = v
	}
	if v := os.Getenv("MC_AGENT_PLATFORM_URL"); v != "" {
		cfg.PlatformURL = v
	}
	if v := os.Getenv("MC_AGENT_PLATFORM_TOKEN"); v != "" {
		cfg.PlatformToken = v
	}
	if v := os.Getenv("MC_AGENT_PLATFORM_MODEL_ID"); v != "" {
		cfg.PlatformModelID = v
	}
	return cfg, nil
}

// Save 写入配置文件(mc-agent config set 用)。
func Save(cfg *Config) error {
	p := Path()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	// 含 API key,权限收紧
	return os.WriteFile(p, data, 0o600)
}

// UsePlatform 是否走 MonkeyCode 平台(登录态)。
func (c *Config) UsePlatform() bool {
	return c.PlatformURL != "" && c.PlatformToken != ""
}

// Validate 检查必填项。平台模式下 LLM 三元组在运行时换取,不要求预先配置。
func (c *Config) Validate() error {
	if c.UsePlatform() {
		return nil
	}
	if c.BaseURL == "" {
		return fmt.Errorf("未配置 base_url:用 --base-url、MC_AGENT_BASE_URL、`mc-agent config set` 设置,或 `mc-agent login <平台地址>` 接入 MonkeyCode 平台")
	}
	if c.APIKey == "" {
		return fmt.Errorf("未配置 api_key:用 --api-key、MC_AGENT_API_KEY 或 `mc-agent config set` 设置")
	}
	if c.Model == "" {
		return fmt.Errorf("未配置 model:用 --model、MC_AGENT_MODEL 或 `mc-agent config set` 设置")
	}
	return nil
}
