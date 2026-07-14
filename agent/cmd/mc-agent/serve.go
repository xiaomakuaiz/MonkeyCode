package main

import (
	_ "embed"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"

	"github.com/chaitin/MonkeyCode/agent/internal/config"
	"github.com/chaitin/MonkeyCode/agent/internal/contextmgr"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/server"
	"github.com/chaitin/MonkeyCode/agent/internal/session"
	"github.com/chaitin/MonkeyCode/agent/internal/skills"
)

// 内嵌 UI:agent/ui(React + Vite)构建的单文件产物,构建产物入库,
// go build 不依赖 node;改 UI 后在 agent/ui 下执行 npm run build 再编译内核。
//
//go:embed uidist/index.html
var embeddedUI []byte

func serveCmd() *cobra.Command {
	var addr, token string
	var noUI, watchStdin bool
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "启动 localhost WS 宿主(桌面/浏览器 UI 通过帧协议直连)",
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
			opts := server.Options{
				Addr:        addr,
				Token:       token,
				SessionRoot: session.DefaultRoot(),
			}

			// 宿主(桌面壳)下发模型清单时走多模型路径:每会话可绑定/切换
			// 不同模型;否则退回单配置(CLI 直连或平台登录)。
			profiles, err := config.LoadModels()
			if err != nil {
				return err
			}
			if len(profiles) > 0 {
				opts.Model = config.FindModel(profiles, "").Name
				opts.NewProvider = func(name string) (provider.Provider, error) {
					p := config.FindModel(profiles, name)
					if p == nil {
						return nil, fmt.Errorf("未知模型 %q", name)
					}
					if p.Provider == "openai" {
						return provider.NewOpenAI(p.BaseURL, p.APIKey, p.Model), nil
					}
					return provider.NewAnthropic(p.BaseURL, p.APIKey, p.Model), nil
				}
				opts.ListModels = func() []server.ModelInfo {
					out := make([]server.ModelInfo, len(profiles))
					for i, p := range profiles {
						out[i] = server.ModelInfo{Name: p.Name, Default: p.Default}
					}
					return out
				}
				opts.BuildExtras = func(workdir string) (*contextmgr.Extras, []string) {
					platExtras, platRoots := platformExtras(cfg)
					return skills.Assemble(workdir, platExtras, platRoots)
				}
			} else {
				if err := cfg.Validate(); err != nil {
					return err
				}
				// 平台模式:换运行时模型 key + 同步技能/规则
				platExtras, platRoots, err := applyPlatform(cfg)
				if err != nil {
					return err
				}
				opts.Model = cfg.Model
				opts.NewProvider = func(name string) (provider.Provider, error) {
					if name != "" && name != cfg.Model {
						return nil, fmt.Errorf("未知模型 %q(当前仅配置了 %q)", name, cfg.Model)
					}
					if cfg.Provider == "openai" {
						return provider.NewOpenAI(cfg.BaseURL, cfg.APIKey, cfg.Model), nil
					}
					return provider.NewAnthropic(cfg.BaseURL, cfg.APIKey, cfg.Model), nil
				}
				opts.BuildExtras = func(workdir string) (*contextmgr.Extras, []string) {
					return skills.Assemble(workdir, platExtras, platRoots)
				}
			}
			if !noUI {
				opts.UI = embeddedUI
			}
			srv, err := server.New(opts)
			if err != nil {
				return err
			}

			fmt.Printf("mc-agent serve %s\n", version)
			fmt.Printf("监听:      http://%s\n", srv.Addr())
			fmt.Printf("访问令牌:  %s\n", srv.Token())
			if !noUI {
				fmt.Printf("调试界面:  http://%s/#%s\n", srv.Addr(), srv.Token())
			}
			fmt.Fprintln(os.Stderr, "(Ctrl-C 停止)")

			ctx, cancel := signalContext()
			defer cancel()
			if watchStdin {
				// 宿主(桌面壳)持有本进程 stdin 管道;宿主任何方式退出
				// 都会关闭管道,内核随之退出,避免孤儿进程
				go func() {
					_, _ = io.Copy(io.Discard, os.Stdin)
					fmt.Fprintln(os.Stderr, "宿主已退出(stdin 关闭),内核随之退出")
					cancel()
				}()
			}
			return srv.ListenAndServe(ctx)
		},
	}
	cmd.Flags().StringVar(&addr, "addr", "127.0.0.1:7439", "监听地址(仅允许 loopback)")
	cmd.Flags().StringVar(&token, "token", "", "访问令牌(默认每次启动随机生成)")
	cmd.Flags().BoolVar(&noUI, "no-ui", false, "不挂载内嵌调试界面")
	cmd.Flags().BoolVar(&watchStdin, "watch-stdin", false, "stdin 关闭时退出(供桌面壳托管)")
	return cmd
}
