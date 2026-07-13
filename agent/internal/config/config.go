// Package config 内核配置:优先级 flag > 环境变量 > 配置文件。
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config 运行配置。
type Config struct {
	Provider string `json:"provider"` // anthropic | openai
	BaseURL  string `json:"base_url"`
	APIKey   string `json:"api_key"`
	Model    string `json:"model"`
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

// Validate 检查必填项。
func (c *Config) Validate() error {
	if c.BaseURL == "" {
		return fmt.Errorf("未配置 base_url:用 --base-url、MC_AGENT_BASE_URL 或 `mc-agent config set` 设置")
	}
	if c.APIKey == "" {
		return fmt.Errorf("未配置 api_key:用 --api-key、MC_AGENT_API_KEY 或 `mc-agent config set` 设置")
	}
	if c.Model == "" {
		return fmt.Errorf("未配置 model:用 --model、MC_AGENT_MODEL 或 `mc-agent config set` 设置")
	}
	return nil
}
