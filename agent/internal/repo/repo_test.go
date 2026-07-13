package repo

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitInit(t *testing.T, dir string) {
	t.Helper()
	for _, args := range [][]string{
		{"init", "-q"},
		{"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if err := cmd.Run(); err != nil {
			t.Fatal(err)
		}
	}
}

func commitFile(t *testing.T, dir, name, content string) {
	t.Helper()
	os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644)
	exec.Command("git", "-C", dir, "add", "-A").Run()
	exec.Command("git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add "+name).Run()
}

func TestListFilesAndReadFile(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o644)
	os.WriteFile(filepath.Join(dir, "sub", "b.txt"), []byte("world"), 0o644)
	b := New(dir)

	entries, err := b.ListFiles("")
	if err != nil {
		t.Fatal(err)
	}
	// 目录在前
	if entries[0].Name != "sub" || !entries[0].IsDir {
		t.Fatalf("排序错误: %+v", entries)
	}
	content, err := b.ReadFile("sub/b.txt")
	if err != nil || content != "world" {
		t.Fatalf("read = %q %v", content, err)
	}
	// 越界拒绝
	if _, err := b.ReadFile("../etc/passwd"); err == nil {
		t.Fatal("越界应拒绝")
	}
	if _, err := b.ListFiles("../.."); err == nil {
		t.Fatal("越界应拒绝")
	}
}

func TestFileChangesAndDiff(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	commitFile(t, dir, "tracked.txt", "v1\n")

	b := New(dir)
	// 无改动
	changes, err := b.FileChanges()
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 0 {
		t.Fatalf("应无改动: %+v", changes)
	}

	// 改一个跟踪文件 + 加一个未跟踪文件
	os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("v2\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "new.txt"), []byte("brand new\n"), 0o644)

	changes, _ = b.FileChanges()
	byPath := map[string]string{}
	for _, c := range changes {
		byPath[c.Path] = c.Status
	}
	if byPath["tracked.txt"] != "M" {
		t.Fatalf("tracked 状态 = %q", byPath["tracked.txt"])
	}
	if byPath["new.txt"] != "A" {
		t.Fatalf("new 状态 = %q", byPath["new.txt"])
	}

	// 已跟踪文件 diff
	diff, err := b.FileDiff("tracked.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff, "-v1") || !strings.Contains(diff, "+v2") {
		t.Fatalf("diff 内容异常:\n%s", diff)
	}
	// 未跟踪文件 diff(全新增)
	ndiff, err := b.FileDiff("new.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ndiff, "+brand new") {
		t.Fatalf("未跟踪 diff 异常:\n%s", ndiff)
	}
}

func TestNonGitRepo(t *testing.T) {
	b := New(t.TempDir())
	changes, err := b.FileChanges()
	if err != nil || changes != nil {
		t.Fatalf("非 git 仓库应返回空: %v %+v", err, changes)
	}
	if _, err := b.FileDiff("x.txt"); err == nil {
		t.Fatal("非 git 仓库 diff 应报错")
	}
}
