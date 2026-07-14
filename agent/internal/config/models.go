package config

import (
	"encoding/json"
	"fmt"
	"os"
)

// ModelProfile 一个可选模型。来源:宿主(桌面壳)经 MC_AGENT_MODELS 清单下发,
// 或由单配置(config.json/env)退化为唯一默认项。内核只消费,不管理。
type ModelProfile struct {
	Name     string `json:"name"`               // 展示名(会话绑定用它标识)
	Provider string `json:"provider,omitempty"` // anthropic | openai,空为 anthropic
	BaseURL  string `json:"base_url"`
	APIKey   string `json:"api_key"`
	Model    string `json:"model"` // 请求里的模型标识
	Default  bool   `json:"default,omitempty"`
}

// LoadModels 加载模型清单:MC_AGENT_MODELS 指向 JSON 数组文件。
// 未设置该环境变量时返回 nil(调用方退回单配置路径)。
// 保证:每项字段齐全、名称唯一、恰好一个 Default(未标记则取第一个)。
func LoadModels() ([]ModelProfile, error) {
	path := os.Getenv("MC_AGENT_MODELS")
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("模型清单 %s 读取失败: %w", path, err)
	}
	var profiles []ModelProfile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return nil, fmt.Errorf("模型清单 %s 解析失败: %w", path, err)
	}
	if len(profiles) == 0 {
		return nil, fmt.Errorf("模型清单 %s 为空", path)
	}

	seen := map[string]bool{}
	defaultIdx := -1
	for i := range profiles {
		p := &profiles[i]
		if p.Name == "" {
			p.Name = p.Model
		}
		if p.Name == "" || p.BaseURL == "" || p.APIKey == "" || p.Model == "" {
			return nil, fmt.Errorf("模型清单第 %d 项字段不全(需 name/base_url/api_key/model)", i+1)
		}
		switch p.Provider {
		case "", "anthropic", "openai", "openai_responses":
		default:
			return nil, fmt.Errorf("模型 %q 的 provider %q 不支持(anthropic/openai/openai_responses)", p.Name, p.Provider)
		}
		if seen[p.Name] {
			return nil, fmt.Errorf("模型清单名称重复: %q", p.Name)
		}
		seen[p.Name] = true
		if p.Default && defaultIdx < 0 {
			defaultIdx = i
		}
		p.Default = false
	}
	if defaultIdx < 0 {
		defaultIdx = 0
	}
	profiles[defaultIdx].Default = true
	return profiles, nil
}

// FindModel 按名取模型;空名返回默认项。找不到返回 nil。
func FindModel(profiles []ModelProfile, name string) *ModelProfile {
	for i := range profiles {
		if name == "" && profiles[i].Default {
			return &profiles[i]
		}
		if profiles[i].Name == name {
			return &profiles[i]
		}
	}
	return nil
}
