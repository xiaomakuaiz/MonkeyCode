// Package mcp 接入 MCP(Model Context Protocol)server,把其 tools 适配为
// 内核工具。仅支持 tools 能力;传输支持 stdio(command)与 Streamable HTTP(url)。
package mcp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// ServerConfig 单个 MCP server 配置。command 与 url 二选一。
type ServerConfig struct {
	// stdio 传输
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	// Streamable HTTP 传输
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	// Disabled 跳过该 server
	Disabled bool `json:"disabled,omitempty"`
}

// Config mcp.json 顶层结构(mcpServers 键与 Claude Code/opencode 同构)。
type Config struct {
	Servers map[string]ServerConfig `json:"mcpServers"`
}

func (c ServerConfig) transport() (string, error) {
	switch {
	case c.Command != "" && c.URL != "":
		return "", fmt.Errorf("command 与 url 不能同时配置")
	case c.Command != "":
		return "stdio", nil
	case c.URL != "":
		return "http", nil
	default:
		return "", fmt.Errorf("必须配置 command 或 url")
	}
}

// globalPath 全局配置路径。
func globalPath() string {
	if v := os.Getenv("MC_AGENT_MCP_CONFIG"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".config", "mc-agent", "mcp.json")
}

// projectPath 项目级配置路径。
func projectPath(workdir string) string {
	return filepath.Join(workdir, ".mc-agent", "mcp.json")
}

// LoadConfig 合并全局与项目级配置(项目级同名 server 覆盖全局)。
// 任一文件不存在都不算错误。
func LoadConfig(workdir string) (Config, error) {
	merged := Config{Servers: map[string]ServerConfig{}}
	for _, p := range []string{globalPath(), projectPath(workdir)} {
		cfg, err := readConfig(p)
		if err != nil {
			return merged, err
		}
		for name, sc := range cfg.Servers {
			merged.Servers[name] = sc
		}
	}
	return merged, nil
}

func readConfig(path string) (Config, error) {
	var cfg Config
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("MCP 配置 %s 解析失败: %w", path, err)
	}
	return cfg, nil
}
