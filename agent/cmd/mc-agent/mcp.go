package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/chaitin/MonkeyCode/agent/internal/mcp"
)

func mcpCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "mcp",
		Short: "MCP server 管理",
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "连接已配置的 MCP server 并列出工具",
		RunE: func(cmd *cobra.Command, args []string) error {
			workdir := flags.dir
			if workdir == "" {
				workdir, _ = os.Getwd()
			}
			workdir, _ = filepath.Abs(workdir)

			mgr, err := mcp.Connect(context.Background(), workdir)
			if err != nil {
				return err
			}
			defer mgr.Close()

			if len(mgr.Servers) == 0 {
				fmt.Println("没有配置 MCP server。")
				fmt.Println("配置位置: ~/.config/mc-agent/mcp.json(全局)或 <项目>/.mc-agent/mcp.json(项目级)")
				fmt.Println(`格式: {"mcpServers": {"名称": {"command": "...", "args": []} 或 {"url": "..."}}}`)
				return nil
			}
			for _, s := range mgr.Servers {
				if s.Err != nil {
					fmt.Printf("✗ %s  连接失败: %v\n", s.Name, s.Err)
					continue
				}
				fmt.Printf("✓ %s  %d 个工具\n", s.Name, len(s.Tools))
				for _, t := range s.Tools {
					ro := ""
					if t.Annotations != nil && t.Annotations.ReadOnlyHint {
						ro = "(只读,自动放行)"
					}
					fmt.Printf("    %-40s %s\n", mcp.ToolName(s.Name, t.Name), ro)
				}
			}
			return nil
		},
	})
	return cmd
}
