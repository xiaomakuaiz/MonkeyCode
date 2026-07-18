package mcp

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadConfigMerge(t *testing.T) {
	dir := t.TempDir()
	global := filepath.Join(dir, "global.json")
	os.WriteFile(global, []byte(`{"mcpServers":{"a":{"command":"x"},"b":{"url":"http://b"}}}`), 0o644)
	t.Setenv("MC_AGENT_MCP_CONFIG", global)

	workdir := t.TempDir()
	os.MkdirAll(filepath.Join(workdir, ".mc-agent"), 0o755)
	// 项目级覆盖 a,新增 c
	os.WriteFile(filepath.Join(workdir, ".mc-agent", "mcp.json"),
		[]byte(`{"mcpServers":{"a":{"command":"override"},"c":{"command":"z"}}}`), 0o644)

	cfg, err := LoadConfig(workdir)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Servers) != 3 {
		t.Fatalf("servers = %d", len(cfg.Servers))
	}
	if cfg.Servers["a"].Command != "override" {
		t.Fatalf("项目级未覆盖全局: %+v", cfg.Servers["a"])
	}
	if cfg.Servers["b"].URL != "http://b" || cfg.Servers["c"].Command != "z" {
		t.Fatalf("合并结果异常: %+v", cfg.Servers)
	}
}

// source 是 UI 的分组标记(百智云同步条目随 mcp.json 落盘):内核解析保留但不消费,
// 未知字段也不报错(向前兼容)。
func TestLoadConfigSourcePassthrough(t *testing.T) {
	dir := t.TempDir()
	global := filepath.Join(dir, "global.json")
	os.WriteFile(global, []byte(`{"mcpServers":{
		"bz":{"url":"http://gw/mcp","source":"baizhi"},
		"manual":{"command":"x","unknown_field":123}
	}}`), 0o644)
	t.Setenv("MC_AGENT_MCP_CONFIG", global)

	cfg, err := LoadConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Servers["bz"].Source != "baizhi" || cfg.Servers["manual"].Source != "" {
		t.Fatalf("source 透传错误: %+v", cfg.Servers)
	}
}

func TestConfigValidation(t *testing.T) {
	if _, err := (ServerConfig{}).transport(); err == nil {
		t.Fatal("空配置应报错")
	}
	if _, err := (ServerConfig{Command: "x", URL: "y"}).transport(); err == nil {
		t.Fatal("command+url 并存应报错")
	}
	if k, _ := (ServerConfig{Command: "x"}).transport(); k != "stdio" {
		t.Fatal("应为 stdio")
	}
	if k, _ := (ServerConfig{URL: "y"}).transport(); k != "http" {
		t.Fatal("应为 http")
	}
}

// buildEchoServer 编译测试用 stdio MCP server,返回二进制路径。
func buildEchoServer(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "echoserver")
	cmd := exec.Command("go", "build", "-o", bin, "./testdata/echoserver")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("编译测试 server 失败: %v", err)
	}
	return bin
}

func TestStdioServerEndToEnd(t *testing.T) {
	bin := buildEchoServer(t)
	global := filepath.Join(t.TempDir(), "mcp.json")
	cfg := `{"mcpServers":{"echo":{"command":"` + bin + `"}}}`
	os.WriteFile(global, []byte(cfg), 0o644)
	t.Setenv("MC_AGENT_MCP_CONFIG", global)

	mgr, err := Connect(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()

	if len(mgr.Servers) != 1 || mgr.Servers[0].Err != nil {
		t.Fatalf("server 连接失败: %+v", mgr.Servers[0])
	}

	agentTools := mgr.AgentTools()
	if len(agentTools) != 2 {
		t.Fatalf("工具数 = %d", len(agentTools))
	}

	byName := map[string]int{}
	for i, at := range agentTools {
		byName[at.Name()] = i
	}
	echoIdx, ok := byName["mcp__echo__echo"]
	if !ok {
		t.Fatalf("命名不符: %v", byName)
	}
	echoTool := agentTools[echoIdx]

	// InputSchema 透传
	if echoTool.InputSchema()["type"] != "object" {
		t.Fatalf("schema = %+v", echoTool.InputSchema())
	}
	// 只读注解检测
	if rt, ok := echoTool.(interface{ ReadOnly() bool }); !ok || !rt.ReadOnly() {
		t.Fatal("echo 应为只读")
	}

	// 调用 echo
	out, err := echoTool.Execute(context.Background(), nil, json.RawMessage(`{"text":"你好"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "echo: 你好") {
		t.Fatalf("echo 输出 = %q", out)
	}

	// 调用 boom → 工具返回错误
	boomIdx := byName["mcp__echo__boom"]
	if _, err := agentTools[boomIdx].Execute(context.Background(), nil, json.RawMessage(`{}`)); err == nil {
		t.Fatal("boom 应返回错误")
	}
}

func TestServerConnectFailure(t *testing.T) {
	global := filepath.Join(t.TempDir(), "mcp.json")
	os.WriteFile(global, []byte(`{"mcpServers":{"broken":{"command":"/nonexistent/xyz"}}}`), 0o644)
	t.Setenv("MC_AGENT_MCP_CONFIG", global)

	// 连接失败不应让 Connect 整体报错
	mgr, err := Connect(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	if len(mgr.Servers) != 1 || mgr.Servers[0].Err == nil {
		t.Fatal("坏 server 应记录 Err 但不阻塞")
	}
	if len(mgr.AgentTools()) != 0 {
		t.Fatal("坏 server 不应贡献工具")
	}
}

func TestDisabledServerSkipped(t *testing.T) {
	global := filepath.Join(t.TempDir(), "mcp.json")
	os.WriteFile(global, []byte(`{"mcpServers":{"x":{"command":"y","disabled":true}}}`), 0o644)
	t.Setenv("MC_AGENT_MCP_CONFIG", global)
	mgr, err := Connect(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Close()
	if len(mgr.Servers) != 0 {
		t.Fatal("disabled server 应被跳过")
	}
}
