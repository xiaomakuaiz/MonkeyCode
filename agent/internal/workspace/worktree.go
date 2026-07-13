// Package workspace 任务工作区隔离:基于 git worktree,
// 任务改动发生在独立目录,结束后一键应用回原仓库或整体丢弃。
package workspace

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Worktree 一次任务的隔离工作区。
type Worktree struct {
	Repo string `json:"repo"` // 原仓库根(绝对路径)
	Path string `json:"path"` // worktree 目录(绝对路径)
}

// Root worktree 存储根目录。
func Root() string {
	if v := os.Getenv("MC_AGENT_DATA_DIR"); v != "" {
		return filepath.Join(v, "worktrees")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".local", "share", "mc-agent", "worktrees")
}

func git(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %v\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// Create 在 repo 的当前 HEAD 上创建 detached worktree(id 通常为会话 ID)。
func Create(repo, id string) (*Worktree, error) {
	repoRoot, err := git(repo, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, fmt.Errorf("%s 不是 git 仓库(worktree 模式需要 git 仓库): %w", repo, err)
	}
	if _, err := git(repoRoot, "rev-parse", "HEAD"); err != nil {
		return nil, fmt.Errorf("仓库还没有任何提交,无法创建 worktree: %w", err)
	}
	path := filepath.Join(Root(), id)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if _, err := git(repoRoot, "worktree", "add", "--detach", path, "HEAD"); err != nil {
		return nil, err
	}
	return &Worktree{Repo: repoRoot, Path: path}, nil
}

// Diff 返回 worktree 相对其基线(HEAD)的完整补丁,含新增文件。
func (w *Worktree) Diff() (string, error) {
	// intent-to-add 让未跟踪文件进入 diff;幂等,可重复调用
	if _, err := git(w.Path, "add", "-A", "-N"); err != nil {
		return "", err
	}
	out, err := gitRaw(w.Path, "diff", "--binary", "HEAD")
	if err != nil {
		return "", err
	}
	return out, nil
}

// DiffStat 变更摘要(git diff --stat)。
func (w *Worktree) DiffStat() (string, error) {
	if _, err := git(w.Path, "add", "-A", "-N"); err != nil {
		return "", err
	}
	return git(w.Path, "diff", "--stat", "HEAD")
}

// Apply 把 worktree 的改动以补丁方式应用回原仓库工作区(不产生提交)。
func (w *Worktree) Apply() error {
	patch, err := w.Diff()
	if err != nil {
		return err
	}
	if strings.TrimSpace(patch) == "" {
		return fmt.Errorf("worktree 没有任何改动")
	}
	cmd := exec.Command("git", "apply", "--3way", "--whitespace=nowarn")
	cmd.Dir = w.Repo
	cmd.Stdin = strings.NewReader(patch)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("应用补丁失败(原仓库可能有冲突的本地改动): %v\n%s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Remove 删除 worktree(改动一并丢弃)。
func (w *Worktree) Remove() error {
	if _, err := git(w.Repo, "worktree", "remove", "--force", w.Path); err != nil {
		// worktree 目录可能已被手动删除,做一次 prune 兜底
		if _, perr := git(w.Repo, "worktree", "prune"); perr != nil {
			return err
		}
	}
	return nil
}

// gitRaw 与 git 相同但不 Trim(补丁内容需保留原样,含结尾换行)。
func gitRaw(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %v", strings.Join(args, " "), err)
	}
	return string(out), nil
}
