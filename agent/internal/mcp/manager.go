package mcp

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/chaitin/MonkeyCode/agent/internal/tools"
)

const (
	connectTimeout = 15 * time.Second
	clientName     = "mc-agent"
	clientVersion  = "0.1.0"
)

// Server 一个已配置的 MCP server 的运行态。
type Server struct {
	Name    string
	Config  ServerConfig
	Session *sdk.ClientSession // 连接失败为 nil
	Tools   []*sdk.Tool
	Err     error // 连接/列举失败原因
}

// Manager 管理一次会话内的全部 MCP 连接。
type Manager struct {
	Servers []*Server
}

// Connect 加载配置并连接全部启用的 server。
// 单个 server 失败只记录在其 Err 上,不影响其它 server 与整体启动。
func Connect(ctx context.Context, workdir string) (*Manager, error) {
	cfg, err := LoadConfig(workdir)
	if err != nil {
		return nil, err
	}
	m := &Manager{}
	names := make([]string, 0, len(cfg.Servers))
	for name := range cfg.Servers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		sc := cfg.Servers[name]
		if sc.Disabled {
			continue
		}
		s := &Server{Name: name, Config: sc}
		s.Session, s.Tools, s.Err = connect(ctx, workdir, name, sc)
		m.Servers = append(m.Servers, s)
	}
	return m, nil
}

func connect(ctx context.Context, workdir, name string, sc ServerConfig) (*sdk.ClientSession, []*sdk.Tool, error) {
	kind, err := sc.transport()
	if err != nil {
		return nil, nil, fmt.Errorf("server %s 配置无效: %w", name, err)
	}

	var transport sdk.Transport
	switch kind {
	case "stdio":
		cmd := exec.Command(sc.Command, sc.Args...)
		cmd.Dir = workdir
		cmd.Env = os.Environ()
		for k, v := range sc.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		cmd.Stderr = os.Stderr // server 的诊断输出透传
		transport = &sdk.CommandTransport{Command: cmd}
	case "http":
		transport = &sdk.StreamableClientTransport{
			Endpoint: sc.URL,
			HTTPClient: &http.Client{
				Transport: &headerTransport{headers: sc.Headers, base: http.DefaultTransport},
			},
			// 只需请求-响应语义;规避不支持 GET SSE 的网关
			DisableStandaloneSSE: true,
		}
	}

	cctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	client := sdk.NewClient(&sdk.Implementation{Name: clientName, Version: clientVersion}, nil)
	session, err := client.Connect(cctx, transport, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("连接失败: %w", err)
	}

	var list []*sdk.Tool
	for tool, err := range session.Tools(cctx, nil) {
		if err != nil {
			_ = session.Close()
			return nil, nil, fmt.Errorf("获取工具列表失败: %w", err)
		}
		list = append(list, tool)
	}
	return session, list, nil
}

// AgentTools 把全部已连接 server 的工具适配为内核工具。
func (m *Manager) AgentTools() []tools.Tool {
	var out []tools.Tool
	for _, s := range m.Servers {
		if s.Session == nil {
			continue
		}
		for _, t := range s.Tools {
			out = append(out, &agentTool{server: s, tool: t})
		}
	}
	return out
}

// Close 断开全部连接(stdio server 子进程随之回收)。
func (m *Manager) Close() {
	for _, s := range m.Servers {
		if s.Session != nil {
			_ = s.Session.Close()
		}
	}
}

// headerTransport 给 HTTP 请求附加配置的固定头(如 Authorization)。
type headerTransport struct {
	headers map[string]string
	base    http.RoundTripper
}

func (t *headerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	return t.base.RoundTrip(req)
}
