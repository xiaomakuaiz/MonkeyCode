package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/chaitin/MonkeyCode/agent/internal/session"
	"github.com/chaitin/MonkeyCode/agent/internal/workspace"
)

func worktreeCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "worktree",
		Short: "管理 --worktree 模式会话的隔离工作区",
	}

	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "列出带隔离工作区的会话",
		RunE: func(cmd *cobra.Command, args []string) error {
			metas, err := session.List(session.DefaultRoot())
			if err != nil {
				return err
			}
			found := false
			for _, m := range metas {
				if m.Worktree == nil {
					continue
				}
				found = true
				fmt.Printf("%s  [%s]  %-40s\n  仓库: %s\n  工作区: %s\n",
					m.ID, m.Status, truncate(m.Title, 40), m.Worktree.Repo, m.Worktree.Path)
			}
			if !found {
				fmt.Println("没有 worktree 模式的会话")
			}
			return nil
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "diff <会话ID>",
		Short: "查看会话工作区相对基线的改动",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			wt, err := loadWorktree(args[0])
			if err != nil {
				return err
			}
			stat, err := wt.DiffStat()
			if err != nil {
				return err
			}
			if stat == "" {
				fmt.Println("(无改动)")
				return nil
			}
			fmt.Println(stat)
			fmt.Printf("\n完整补丁: git -C %s diff HEAD\n", wt.Path)
			return nil
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "apply <会话ID>",
		Short: "把会话工作区的改动应用回原仓库(不产生提交)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			wt, err := loadWorktree(args[0])
			if err != nil {
				return err
			}
			if err := wt.Apply(); err != nil {
				return err
			}
			fmt.Printf("已应用到 %s(工作区保留,确认无误后可 mc-agent worktree drop %s)\n", wt.Repo, args[0])
			return nil
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "drop <会话ID>",
		Short: "丢弃会话工作区(改动一并删除,不可恢复)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			wt, err := loadWorktree(args[0])
			if err != nil {
				return err
			}
			if stat, err := wt.DiffStat(); err == nil && stat != "" {
				fmt.Fprintf(os.Stderr, "警告: 该工作区还有未应用的改动:\n%s\n", stat)
			}
			if err := wt.Remove(); err != nil {
				return err
			}
			fmt.Println("已删除工作区", wt.Path)
			return nil
		},
	})

	return cmd
}

func loadWorktree(id string) (*workspace.Worktree, error) {
	sess, err := session.Load(session.DefaultRoot(), id)
	if err != nil {
		return nil, err
	}
	defer sess.Close()
	if sess.Meta.Worktree == nil {
		return nil, fmt.Errorf("会话 %s 不是 worktree 模式", id)
	}
	return sess.Meta.Worktree, nil
}
