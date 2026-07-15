// mc-agent MonkeyCode 本地 agent 内核(headless CLI)。
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/chaitin/MonkeyCode/agent/internal/config"
	"github.com/chaitin/MonkeyCode/agent/internal/contextmgr"
	"github.com/chaitin/MonkeyCode/agent/internal/frame"
	"github.com/chaitin/MonkeyCode/agent/internal/loop"
	"github.com/chaitin/MonkeyCode/agent/internal/mcp"
	"github.com/chaitin/MonkeyCode/agent/internal/policy"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/session"
	"github.com/chaitin/MonkeyCode/agent/internal/skills"
	"github.com/chaitin/MonkeyCode/agent/internal/subagent"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
	"github.com/chaitin/MonkeyCode/agent/internal/workspace"
)

var version = "0.1.0-dev"

type rootFlags struct {
	dir           string
	provider      string
	baseURL       string
	apiKey        string
	model         string
	yolo          bool
	allow         []string
	maxSteps      int
	subagentSteps int
	contextBudget int
	resumeID      string
	noSession     bool
	worktree      bool
}

var flags rootFlags

func main() {
	root := &cobra.Command{
		Use:           "mc-agent",
		Short:         "MonkeyCode 本地编码 agent 内核",
		Version:       version,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	pf := root.PersistentFlags()
	pf.StringVarP(&flags.dir, "dir", "d", "", "工作区目录(默认当前目录)")
	pf.StringVar(&flags.provider, "provider", "", "LLM 协议: anthropic | openai | openai_responses")
	pf.StringVar(&flags.baseURL, "base-url", "", "LLM base URL")
	pf.StringVar(&flags.apiKey, "api-key", "", "LLM API key")
	pf.StringVar(&flags.model, "model", "", "模型标识")
	pf.BoolVar(&flags.yolo, "yolo", false, "跳过所有权限审批(谨慎使用)")
	pf.StringSliceVar(&flags.allow, "allow", nil, "预授权的工具名(可多次指定,如 --allow write_file)")
	pf.IntVar(&flags.maxSteps, "max-steps", 0, "单轮最大步数(默认 500)")
	pf.IntVar(&flags.subagentSteps, "subagent-max-steps", 0, "子代理单任务最大步数(默认 200)")
	pf.IntVar(&flags.contextBudget, "context-budget", 0, "上下文 token 预算,超 80% 触发压缩(默认 180000)")
	pf.StringVar(&flags.resumeID, "resume", "", "恢复指定会话继续对话")
	pf.BoolVar(&flags.noSession, "no-session", false, "不持久化会话")
	pf.BoolVar(&flags.worktree, "worktree", false, "在隔离的 git worktree 中执行(结束后用 mc-agent worktree apply/drop 处理改动)")

	root.AddCommand(runCmd(), chatCmd(), sessionsCmd(), configCmd(), serveCmd(), evalCmd(), worktreeCmd(), mcpCmd(), loginCmd(), logoutCmd(), skillsCmd())

	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		os.Exit(1)
	}
}

// newProviderByName 按协议名构造 LLM 客户端。
func newProviderByName(name, baseURL, apiKey, model string) (provider.Provider, error) {
	switch name {
	case "", "anthropic":
		return provider.NewAnthropic(baseURL, apiKey, model), nil
	case "openai":
		return provider.NewOpenAI(baseURL, apiKey, model), nil
	case "openai_responses":
		return provider.NewOpenAIResponses(baseURL, apiKey, model), nil
	default:
		return nil, fmt.Errorf("未知 provider %q(支持 anthropic/openai/openai_responses)", name)
	}
}

// ==================== 引擎装配 ====================

type app struct {
	engine   *loop.Engine
	sess     *session.Session
	renderer *Renderer
	workdir  string
	mcp      *mcp.Manager
}

func buildApp(interactive bool) (*app, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	if flags.provider != "" {
		cfg.Provider = flags.provider
	}
	if flags.baseURL != "" {
		cfg.BaseURL = flags.baseURL
	}
	if flags.apiKey != "" {
		cfg.APIKey = flags.apiKey
	}
	if flags.model != "" {
		cfg.Model = flags.model
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	// 平台模式:换运行时模型 key + 同步技能/规则(填充 cfg 的 LLM 三元组)
	platExtras, platRoots, err := applyPlatform(cfg)
	if err != nil {
		return nil, err
	}

	workdir := flags.dir
	if workdir == "" {
		workdir, _ = os.Getwd()
	}
	workdir, err = filepath.Abs(workdir)
	if err != nil {
		return nil, err
	}
	if st, err := os.Stat(workdir); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("工作区目录不存在: %s", workdir)
	}

	p, err := newProviderByName(cfg.Provider, cfg.BaseURL, cfg.APIKey, cfg.Model)
	if err != nil {
		return nil, err
	}

	renderer := NewRenderer()

	mode := policy.ModeDefault
	if flags.yolo {
		mode = policy.ModeYolo
	}
	var asker policy.Asker
	if interactive {
		asker = terminalAsker(renderer)
	}
	pol := policy.New(mode, asker)
	pol.EnableProjectRules(workdir)
	for _, t := range flags.allow {
		pol.AllowTool(t)
	}

	reg := tools.NewRegistry()
	builder := &frame.Builder{}

	// MCP server 工具接入(配置缺失/单点失败均不阻塞启动)
	mcpMgr, err := mcp.Connect(context.Background(), workdir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "警告: MCP 配置加载失败:", err)
	} else {
		registerMCPTools(mcpMgr, reg, pol)
	}

	emitters := frame.MultiEmitter{renderer}
	var sess *session.Session
	if !flags.noSession {
		root := session.DefaultRoot()
		if flags.resumeID != "" {
			sess, err = session.Load(root, flags.resumeID)
		} else {
			sess, err = session.New(root, workdir, cfg.Model, "")
		}
		if err != nil {
			return nil, err
		}
		emitters = append(emitters, sess)

		switch {
		case flags.worktree && flags.resumeID == "":
			// 新会话 + worktree:执行目录切到隔离 worktree
			wt, err := workspace.Create(workdir, sess.Meta.ID)
			if err != nil {
				return nil, err
			}
			sess.Meta.Worktree = wt
			sess.Meta.Workdir = wt.Path
			workdir = wt.Path
			if err := sess.SaveMeta(); err != nil {
				return nil, err
			}
		case sess.Meta.Worktree != nil:
			// resume 到 worktree 会话:沿用其执行目录
			if st, err := os.Stat(sess.Meta.Workdir); err != nil || !st.IsDir() {
				return nil, fmt.Errorf("会话的 worktree 目录已不存在: %s", sess.Meta.Workdir)
			}
			workdir = sess.Meta.Workdir
		}
	} else if flags.worktree {
		return nil, fmt.Errorf("--worktree 需要会话持久化,不能与 --no-session 同用")
	}

	// todo 工具的计划更新外显为 plan 帧
	if t, ok := reg.Get("todo"); ok {
		emitAll := emitters
		t.(*tools.Todo).OnUpdate = func(entries []tools.TodoEntry) {
			fe := make([]frame.PlanEntry, len(entries))
			for i, e := range entries {
				fe[i] = frame.PlanEntry{Content: e.Content, Status: e.Status}
			}
			emitAll.Emit(builder.Plan(fe))
		}
	}

	// 网关缓存亲和:同一会话带同一 Session-Id/Thread-Id,命中前缀缓存
	if hs, ok := p.(provider.HeaderSetter); ok && sess != nil {
		hs.SetExtraHeaders(map[string]string{
			"Session-Id": sess.Meta.ID,
			"Thread-Id":  sess.Meta.ID,
		})
	}

	// 只读探索子代理(task 工具):工具集只读故自动放行;
	// 会话持久化开启时,子代理过程落盘为子会话(可独立回放)
	sub := &subagent.Tool{Provider: p, MaxSteps: flags.subagentSteps}
	if sess != nil {
		sub.SessionRoot = session.DefaultRoot()
		sub.ParentID = sess.Meta.ID
	}
	reg.Register(sub)
	pol.AllowTool(sub.Name())

	// 本地技能(项目/全局)与平台资源合并注入;workdir 此时已是最终执行目录(含 worktree)
	extras, readRoots := skills.Assemble(workdir, platExtras, platRoots)
	system := contextmgr.Build(workdir, extras)
	engine := loop.New(p, reg, pol, emitters, builder, workdir, system,
		loop.Options{MaxSteps: flags.maxSteps, ContextBudget: flags.contextBudget, ReadRoots: readRoots})
	sub.OnUsage = engine.AddUsage

	if sess != nil && flags.resumeID != "" {
		msgs, err := sess.LoadMessages()
		if err != nil {
			return nil, fmt.Errorf("恢复会话失败: %w", err)
		}
		engine.Messages = msgs
		engine.Usage = sess.Meta.Usage
	}

	return &app{engine: engine, sess: sess, renderer: renderer, workdir: workdir, mcp: mcpMgr}, nil
}

// registerMCPTools 注册 MCP 工具:只读注解的自动放行,其余走审批。
func registerMCPTools(mgr *mcp.Manager, reg *tools.Registry, pol *policy.Engine) {
	for _, s := range mgr.Servers {
		if s.Err != nil {
			fmt.Fprintf(os.Stderr, "警告: MCP server %s 不可用: %v\n", s.Name, s.Err)
		}
	}
	for _, t := range mgr.AgentTools() {
		reg.Register(t)
		if rt, ok := t.(interface{ ReadOnly() bool }); ok && rt.ReadOnly() {
			pol.AllowTool(t.Name())
		}
	}
}

// runTurn 执行一轮并处理会话落盘。
func (a *app) runTurn(ctx context.Context, input string) error {
	if a.sess != nil {
		a.sess.Meta.Status = "running"
		_ = a.sess.SaveMeta()
	}
	_, err := a.engine.RunTurn(ctx, input)
	a.renderer.Flush()

	if a.sess != nil {
		if serr := a.sess.SaveMessages(a.engine.Messages); serr != nil {
			fmt.Fprintln(os.Stderr, "警告: 会话保存失败:", serr)
		}
		a.sess.Meta.Turns++
		a.sess.Meta.Usage = a.engine.Usage
		switch {
		case errors.Is(err, loop.ErrInterrupted):
			a.sess.Meta.Status = "interrupted"
		case err != nil:
			a.sess.Meta.Status = "error"
		default:
			a.sess.Meta.Status = "finished"
		}
		if a.sess.Meta.Title == "" {
			a.sess.Meta.Title = firstLine(input)
		}
		if serr := a.sess.SaveMeta(); serr != nil {
			fmt.Fprintln(os.Stderr, "警告: 会话元信息保存失败:", serr)
		}
	}
	return err
}

func (a *app) close() {
	if a.sess != nil {
		a.sess.Close()
	}
	if a.mcp != nil {
		a.mcp.Close()
	}
	a.engine.Close()
}

// signalContext SIGINT/SIGTERM 触发取消。
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

// ==================== 子命令 ====================

func runCmd() *cobra.Command {
	var prompt string
	var quiet bool
	cmd := &cobra.Command{
		Use:   "run",
		Short: "执行单个任务(非交互)",
		RunE: func(cmd *cobra.Command, args []string) error {
			if prompt == "" && len(args) > 0 {
				prompt = strings.Join(args, " ")
			}
			if strings.TrimSpace(prompt) == "" {
				return fmt.Errorf("请通过 -p 或位置参数提供任务描述")
			}
			a, err := buildApp(isTerminal(os.Stdin))
			if err != nil {
				return err
			}
			defer a.close()
			a.renderer.Quiet = quiet

			ctx, cancel := signalContext()
			defer cancel()
			if err := a.runTurn(ctx, prompt); err != nil {
				return err
			}
			if a.sess != nil && !quiet {
				fmt.Fprintf(os.Stderr, "\n会话: %s(继续对话: mc-agent chat --resume %s)\n",
					a.sess.Meta.ID, a.sess.Meta.ID)
				if wt := a.sess.Meta.Worktree; wt != nil {
					if stat, err := wt.DiffStat(); err == nil && stat != "" {
						fmt.Fprintf(os.Stderr, "\n改动发生在隔离工作区 %s:\n%s\n应用: mc-agent worktree apply %s  丢弃: mc-agent worktree drop %s\n",
							wt.Path, stat, a.sess.Meta.ID, a.sess.Meta.ID)
					}
				}
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&prompt, "prompt", "p", "", "任务描述")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "只输出模型正文")
	return cmd
}

func chatCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "chat",
		Short: "交互式对话(REPL)",
		RunE: func(cmd *cobra.Command, args []string) error {
			a, err := buildApp(true)
			if err != nil {
				return err
			}
			defer a.close()

			fmt.Printf("mc-agent %s | 工作区 %s | 模型 %s\n输入 /exit 退出\n",
				version, a.workdir, a.engine.ModelName())
			reader := bufio.NewReader(os.Stdin)
			for {
				fmt.Print("\n> ")
				line, err := reader.ReadString('\n')
				if err != nil {
					return nil // EOF
				}
				input := strings.TrimSpace(line)
				switch input {
				case "":
					continue
				case "/exit", "/quit":
					return nil
				}
				ctx, cancel := signalContext()
				err = a.runTurn(ctx, input)
				cancel()
				if err != nil && !errors.Is(err, loop.ErrInterrupted) {
					fmt.Fprintln(os.Stderr, "错误:", err)
				}
			}
		},
	}
}

func sessionsCmd() *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:   "sessions",
		Short: "列出历史会话",
		RunE: func(cmd *cobra.Command, args []string) error {
			metas, err := session.List(session.DefaultRoot())
			if err != nil {
				return err
			}
			shown := 0
			for _, m := range metas {
				if m.Parent != "" && !all {
					continue
				}
				indent := ""
				if m.Parent != "" {
					indent = "  ↳ "
				}
				fmt.Printf("%s%s  [%s]  %d 轮  %-40s  %s\n",
					indent, m.ID, m.Status, m.Turns, truncate(m.Title, 40), m.Workdir)
				shown++
			}
			if shown == 0 {
				fmt.Println("暂无会话")
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "包含子代理的子会话")
	return cmd
}

func configCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "config", Short: "查看/写入配置文件"}
	cmd.AddCommand(&cobra.Command{
		Use:   "set",
		Short: "把 --provider/--base-url/--api-key/--model 写入配置文件",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			if flags.provider != "" {
				cfg.Provider = flags.provider
			}
			if flags.baseURL != "" {
				cfg.BaseURL = flags.baseURL
			}
			if flags.apiKey != "" {
				cfg.APIKey = flags.apiKey
			}
			if flags.model != "" {
				cfg.Model = flags.model
			}
			if err := config.Save(cfg); err != nil {
				return err
			}
			fmt.Println("已写入", config.Path())
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "get",
		Short: "显示当前配置(API key 打码)",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			key := cfg.APIKey
			if len(key) > 8 {
				key = key[:6] + "..." + key[len(key)-4:]
			}
			fmt.Printf("provider: %s\nbase_url: %s\napi_key:  %s\nmodel:    %s\n配置文件: %s\n",
				cfg.Provider, cfg.BaseURL, key, cfg.Model, config.Path())
			if cfg.PlatformURL != "" {
				status := "未登录"
				if cfg.PlatformToken != "" {
					status = "已登录"
				}
				fmt.Printf("平台:     %s(%s)\n", cfg.PlatformURL, status)
			}
			return nil
		},
	})
	return cmd
}

// ==================== 终端审批 ====================

func terminalAsker(r *Renderer) policy.Asker {
	reader := bufio.NewReader(os.Stdin)
	return func(ctx context.Context, req policy.Request) (policy.Response, error) {
		r.Flush()
		fmt.Printf("\n%s 需要执行: %s\n允许? [y]是 / [n]否 / [a]本会话始终允许 / [p]此项目永久允许 / [d]本会话始终拒绝: ", "⚠", req.Title)
		line, err := reader.ReadString('\n')
		if err != nil {
			return policy.Response{}, err
		}
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "y", "yes":
			return policy.Response{Approved: true}, nil
		case "a", "always":
			return policy.Response{Approved: true, Remember: true}, nil
		case "p":
			return policy.Response{Approved: true, Remember: true, Persist: true}, nil
		case "d", "deny":
			return policy.Response{Remember: true}, nil
		default:
			return policy.Response{}, nil
		}
	}
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}
