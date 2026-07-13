package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/chaitin/MonkeyCode/agent/internal/config"
	"github.com/chaitin/MonkeyCode/agent/internal/platform"
	"github.com/chaitin/MonkeyCode/agent/internal/skills"
)

func skillsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "skills",
		Short: "列出当前可用的技能(项目/全局/平台缓存)",
		RunE: func(cmd *cobra.Command, args []string) error {
			workdir := flags.dir
			if workdir == "" {
				workdir, _ = os.Getwd()
			}
			workdir, err := filepath.Abs(workdir)
			if err != nil {
				return err
			}

			local := skills.Discover(workdir)
			seen := map[string]bool{}
			printed := 0
			for _, s := range local {
				seen[s.Name] = true
				fmt.Println(s.Format())
				printed++
			}

			// 平台技能只列本地缓存(不发起网络请求,保持命令即时)
			cfg, err := config.Load()
			if err == nil && cfg.PlatformURL != "" {
				if mat, err := platform.LoadCached(cfg.PlatformURL); err == nil {
					for _, s := range mat.Skills {
						if seen[s.Name] {
							continue
						}
						fmt.Println(skills.Skill{
							Name: s.Name, Description: s.Description,
							Dir: s.Dir, Doc: s.Doc, Source: "platform",
						}.Format())
						printed++
					}
				}
			}

			if printed == 0 {
				fmt.Printf("未发现技能。可放置于:\n  项目: %s\n  全局: %s\n(每个技能一个目录,内含 SKILL.md)\n",
					filepath.Join(workdir, ".mc-agent", "skills"), skills.GlobalDir())
			}
			return nil
		},
	}
}
