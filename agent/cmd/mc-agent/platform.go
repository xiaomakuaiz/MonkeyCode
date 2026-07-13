package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/chaitin/MonkeyCode/agent/internal/config"
	"github.com/chaitin/MonkeyCode/agent/internal/contextmgr"
	"github.com/chaitin/MonkeyCode/agent/internal/platform"
)

// applyPlatform 平台模式装配:LLM 三元组缺省时向平台换运行时模型 key
// (流量走 LLMProxy),并同步技能/规则。返回系统提示增量与技能只读根目录。
// 技能/规则同步失败降级用本地缓存,换 key 失败则报错(无 LLM 无法工作)。
func applyPlatform(cfg *config.Config) (*contextmgr.Extras, []string, error) {
	if !cfg.UsePlatform() {
		return nil, nil, nil
	}
	client := platform.New(cfg.PlatformURL, cfg.PlatformToken)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	if cfg.APIKey == "" {
		rk, err := client.FetchRuntimeKey(ctx, cfg.PlatformModelID)
		if err != nil {
			return nil, nil, fmt.Errorf("向平台换取运行时模型 key 失败: %w", err)
		}
		base := strings.TrimRight(cfg.PlatformURL, "/")
		switch rk.Protocol {
		case "anthropic":
			cfg.Provider, cfg.BaseURL = "anthropic", base
		case "openai_chat":
			cfg.Provider, cfg.BaseURL = "openai", base+"/v1"
		default:
			return nil, nil, fmt.Errorf("平台模型协议 %q 内核暂不支持(支持 anthropic/openai_chat)", rk.Protocol)
		}
		cfg.APIKey, cfg.Model = rk.APIKey, rk.Model
	}

	mat, err := client.Sync(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "警告: 平台技能/规则同步失败,尝试本地缓存:", err)
		if mat, err = platform.LoadCached(cfg.PlatformURL); err != nil {
			return nil, nil, nil // 无缓存:本次无平台规则/技能,不阻塞任务
		}
	}

	extras := &contextmgr.Extras{}
	var roots []string
	for _, r := range mat.Rules {
		extras.Rules = append(extras.Rules, contextmgr.PlatformRule{Name: r.Name, Content: r.Content})
	}
	for _, s := range mat.Skills {
		extras.Skills = append(extras.Skills, contextmgr.PlatformSkill{
			Name: s.Name, Description: s.Description, Doc: s.Doc, Dir: s.Dir,
		})
		roots = append(roots, s.Dir)
	}
	if len(extras.Rules) == 0 && len(extras.Skills) == 0 {
		return nil, nil, nil
	}
	return extras, roots, nil
}

func loginCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "login [平台地址]",
		Short: "浏览器登录 MonkeyCode 平台(接入 LLMProxy 与技能/规则下发)",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			platformURL := cfg.PlatformURL
			if len(args) > 0 {
				platformURL = args[0]
			}
			if platformURL == "" {
				return fmt.Errorf("请提供平台地址,如: mc-agent login https://monkeycode.example.com")
			}

			ctx, cancel := signalContext()
			defer cancel()
			tok, err := platform.LoginViaBrowser(ctx, platformURL)
			if err != nil {
				return err
			}

			cfg.PlatformURL = strings.TrimRight(platformURL, "/")
			cfg.PlatformToken = tok.AccessToken
			if err := config.Save(cfg); err != nil {
				return err
			}
			name := tok.User.Name
			if name == "" {
				name = tok.User.Email
			}
			fmt.Printf("登录成功: %s\n平台配置已写入 %s\n", name, config.Path())
			return nil
		},
	}
}

func logoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "清除平台登录态",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			if cfg.PlatformToken == "" {
				fmt.Println("当前未登录平台")
				return nil
			}
			cfg.PlatformToken = ""
			if err := config.Save(cfg); err != nil {
				return err
			}
			fmt.Println("已退出平台登录")
			return nil
		},
	}
}
