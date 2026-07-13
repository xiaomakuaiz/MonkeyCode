package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// initRepo 建一个带首次提交的临时仓库。
func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q"},
		{"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"},
	} {
		if _, err := git(dir, args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := git(dir, "add", "-A"); err != nil {
		t.Fatal(err)
	}
	if _, err := git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add base"); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestCreateModifyApplyRemove(t *testing.T) {
	t.Setenv("MC_AGENT_DATA_DIR", t.TempDir())
	repo := initRepo(t)

	wt, err := Create(repo, "sess-1")
	if err != nil {
		t.Fatal(err)
	}
	// worktree 内改已有文件 + 新增文件
	if err := os.WriteFile(filepath.Join(wt.Path, "base.txt"), []byte("modified\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wt.Path, "new.txt"), []byte("brand new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	stat, err := wt.DiffStat()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stat, "base.txt") || !strings.Contains(stat, "new.txt") {
		t.Fatalf("diff stat 缺文件: %s", stat)
	}

	// 原仓库此时不受影响
	data, _ := os.ReadFile(filepath.Join(repo, "base.txt"))
	if string(data) != "base\n" {
		t.Fatal("原仓库不应被改动")
	}

	// 应用回原仓库
	if err := wt.Apply(); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(filepath.Join(repo, "base.txt"))
	if string(data) != "modified\n" {
		t.Fatalf("base.txt 未应用: %q", data)
	}
	data, _ = os.ReadFile(filepath.Join(repo, "new.txt"))
	if string(data) != "brand new\n" {
		t.Fatalf("new.txt 未应用: %q", data)
	}

	// 清理
	if err := wt.Remove(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Fatal("worktree 目录应已删除")
	}
}

func TestApplyEmptyDiff(t *testing.T) {
	t.Setenv("MC_AGENT_DATA_DIR", t.TempDir())
	repo := initRepo(t)
	wt, err := Create(repo, "sess-2")
	if err != nil {
		t.Fatal(err)
	}
	defer wt.Remove()
	if err := wt.Apply(); err == nil || !strings.Contains(err.Error(), "没有任何改动") {
		t.Fatalf("err = %v", err)
	}
}

func TestCreateOnNonRepo(t *testing.T) {
	t.Setenv("MC_AGENT_DATA_DIR", t.TempDir())
	if _, err := Create(t.TempDir(), "sess-3"); err == nil {
		t.Fatal("非 git 仓库应报错")
	}
}

func TestRemoveAfterManualDelete(t *testing.T) {
	t.Setenv("MC_AGENT_DATA_DIR", t.TempDir())
	repo := initRepo(t)
	wt, err := Create(repo, "sess-4")
	if err != nil {
		t.Fatal(err)
	}
	// 模拟用户手动删了目录
	if err := os.RemoveAll(wt.Path); err != nil {
		t.Fatal(err)
	}
	if err := wt.Remove(); err != nil {
		t.Fatalf("手动删除后 Remove 应可兜底: %v", err)
	}
}
