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
	"github.com/chaitin/MonkeyCode/agent/internal/policy"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/session"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
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
	contextBudget int
	resumeID      string
	noSession     bool
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
	pf.StringVar(&flags.provider, "provider", "", "LLM 协议: anthropic | openai")
	pf.StringVar(&flags.baseURL, "base-url", "", "LLM base URL")
	pf.StringVar(&flags.apiKey, "api-key", "", "LLM API key")
	pf.StringVar(&flags.model, "model", "", "模型标识")
	pf.BoolVar(&flags.yolo, "yolo", false, "跳过所有权限审批(谨慎使用)")
	pf.StringSliceVar(&flags.allow, "allow", nil, "预授权的工具名(可多次指定,如 --allow write_file)")
	pf.IntVar(&flags.maxSteps, "max-steps", 0, "单轮最大步数(默认 80)")
	pf.IntVar(&flags.contextBudget, "context-budget", 0, "上下文 token 预算,超 80% 触发压缩(默认 180000)")
	pf.StringVar(&flags.resumeID, "resume", "", "恢复指定会话继续对话")
	pf.BoolVar(&flags.noSession, "no-session", false, "不持久化会话")

	root.AddCommand(runCmd(), chatCmd(), sessionsCmd(), configCmd(), serveCmd(), evalCmd())

	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		os.Exit(1)
	}
}

// ==================== 引擎装配 ====================

type app struct {
	engine   *loop.Engine
	sess     *session.Session
	renderer *Renderer
	workdir  string
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

	var p provider.Provider
	switch cfg.Provider {
	case "", "anthropic":
		p = provider.NewAnthropic(cfg.BaseURL, cfg.APIKey, cfg.Model)
	case "openai":
		p = provider.NewOpenAI(cfg.BaseURL, cfg.APIKey, cfg.Model)
	default:
		return nil, fmt.Errorf("未知 provider %q(支持 anthropic/openai)", cfg.Provider)
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
	for _, t := range flags.allow {
		pol.AllowTool(t)
	}

	reg := tools.NewRegistry()
	builder := &frame.Builder{}

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

	system := contextmgr.Build(workdir)
	engine := loop.New(p, reg, pol, emitters, builder, workdir, system,
		loop.Options{MaxSteps: flags.maxSteps, ContextBudget: flags.contextBudget})

	if sess != nil && flags.resumeID != "" {
		msgs, err := sess.LoadMessages()
		if err != nil {
			return nil, fmt.Errorf("恢复会话失败: %w", err)
		}
		engine.Messages = msgs
		engine.Usage = sess.Meta.Usage
	}

	return &app{engine: engine, sess: sess, renderer: renderer, workdir: workdir}, nil
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

			fmt.Printf("mc-agent %s | 工作区 %s | 模型 %s\n", version, a.workdir, "输入 /exit 退出\n")
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
	return &cobra.Command{
		Use:   "sessions",
		Short: "列出历史会话",
		RunE: func(cmd *cobra.Command, args []string) error {
			metas, err := session.List(session.DefaultRoot())
			if err != nil {
				return err
			}
			if len(metas) == 0 {
				fmt.Println("暂无会话")
				return nil
			}
			for _, m := range metas {
				fmt.Printf("%s  [%s]  %d 轮  %-40s  %s\n",
					m.ID, m.Status, m.Turns, truncate(m.Title, 40), m.Workdir)
			}
			return nil
		},
	}
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
			return nil
		},
	})
	return cmd
}

// ==================== 终端审批 ====================

func terminalAsker(r *Renderer) policy.Asker {
	reader := bufio.NewReader(os.Stdin)
	return func(ctx context.Context, req policy.Request) (bool, bool, error) {
		r.Flush()
		fmt.Printf("\n%s 需要执行: %s\n允许? [y]是 / [n]否 / [a]本会话始终允许 / [d]本会话始终拒绝: ", "⚠", req.Title)
		line, err := reader.ReadString('\n')
		if err != nil {
			return false, false, err
		}
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "y", "yes":
			return true, false, nil
		case "a", "always":
			return true, true, nil
		case "d", "deny":
			return false, true, nil
		default:
			return false, false, nil
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
