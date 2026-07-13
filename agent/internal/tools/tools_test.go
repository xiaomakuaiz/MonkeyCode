package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testEnv(t *testing.T) *Env {
	t.Helper()
	return &Env{Workdir: t.TempDir()}
}

func TestResolveInWorkspace(t *testing.T) {
	env := testEnv(t)
	if _, err := ResolveInWorkspace(env, "sub/file.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveInWorkspace(env, "../outside"); err == nil {
		t.Fatal("应拒绝越界路径")
	}
	if _, err := ResolveInWorkspace(env, "/etc/passwd"); err == nil {
		t.Fatal("应拒绝工作区外绝对路径")
	}
	if _, err := ResolveInWorkspace(env, "a/../../b"); err == nil {
		t.Fatal("应拒绝 .. 逃逸")
	}
}

func TestEditFile(t *testing.T) {
	env := testEnv(t)
	p := filepath.Join(env.Workdir, "a.go")
	if err := os.WriteFile(p, []byte("func A() {}\nfunc B() {}\nfunc A2() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tool := &EditFile{}

	// 正常替换
	in, _ := json.Marshal(editFileInput{Path: "a.go", OldString: "func B() {}", NewString: "func B() { return }"})
	if _, err := tool.Execute(context.Background(), env, in); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	if !strings.Contains(string(data), "func B() { return }") {
		t.Fatal("替换未生效")
	}

	// 找不到
	in, _ = json.Marshal(editFileInput{Path: "a.go", OldString: "不存在的内容", NewString: "x"})
	if _, err := tool.Execute(context.Background(), env, in); err == nil || !strings.Contains(err.Error(), "找不到") {
		t.Fatalf("err = %v", err)
	}

	// 不唯一
	os.WriteFile(p, []byte("dup\ndup\n"), 0o644)
	in, _ = json.Marshal(editFileInput{Path: "a.go", OldString: "dup", NewString: "x"})
	if _, err := tool.Execute(context.Background(), env, in); err == nil || !strings.Contains(err.Error(), "2 次") {
		t.Fatalf("err = %v", err)
	}

	// replace_all
	in, _ = json.Marshal(editFileInput{Path: "a.go", OldString: "dup", NewString: "x", ReplaceAll: true})
	out, err := tool.Execute(context.Background(), env, in)
	if err != nil || !strings.Contains(out, "2 处") {
		t.Fatalf("out=%q err=%v", out, err)
	}
}

func TestReadWriteFile(t *testing.T) {
	env := testEnv(t)
	w := &WriteFile{}
	in, _ := json.Marshal(writeFileInput{Path: "dir/new.txt", Content: "line1\nline2\n"})
	if _, err := w.Execute(context.Background(), env, in); err != nil {
		t.Fatal(err)
	}

	r := &ReadFile{}
	in, _ = json.Marshal(readFileInput{Path: "dir/new.txt"})
	out, err := r.Execute(context.Background(), env, in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "1\tline1") {
		t.Fatalf("out = %q", out)
	}
}

func TestBashCwdPersistence(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix only")
	}
	env := testEnv(t)
	os.MkdirAll(filepath.Join(env.Workdir, "subdir"), 0o755)
	b := &Bash{}

	in, _ := json.Marshal(bashInput{Command: "cd subdir && touch here.txt"})
	if _, err := b.Execute(context.Background(), env, in); err != nil {
		t.Fatal(err)
	}
	// cd 效果保持
	in, _ = json.Marshal(bashInput{Command: "ls"})
	out, err := b.Execute(context.Background(), env, in)
	if err != nil || !strings.Contains(out, "here.txt") {
		t.Fatalf("out=%q err=%v", out, err)
	}
	// cd 出工作区被拉回
	in, _ = json.Marshal(bashInput{Command: "cd /tmp"})
	out, _ = b.Execute(context.Background(), env, in)
	if !strings.Contains(out, "重置") {
		t.Fatalf("越界 cd 未被拦截: %q", out)
	}
}

func TestBashEnvPersistence(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix only")
	}
	env := testEnv(t)
	b := &Bash{}
	defer b.Close()

	in, _ := json.Marshal(bashInput{Command: "export MC_TEST_VAR=hello42"})
	if _, err := b.Execute(context.Background(), env, in); err != nil {
		t.Fatal(err)
	}
	in, _ = json.Marshal(bashInput{Command: "echo val=$MC_TEST_VAR"})
	out, err := b.Execute(context.Background(), env, in)
	if err != nil || !strings.Contains(out, "val=hello42") {
		t.Fatalf("env 未跨调用保持: out=%q err=%v", out, err)
	}
	// 退出码仍是用户命令的
	in, _ = json.Marshal(bashInput{Command: "exit 7"})
	out, err = b.Execute(context.Background(), env, in)
	if err != nil || !strings.Contains(out, "命令失败") {
		t.Fatalf("退出码语义被破坏: out=%q err=%v", out, err)
	}
}

func TestBashNonZeroExit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix only")
	}
	env := testEnv(t)
	b := &Bash{}
	in, _ := json.Marshal(bashInput{Command: "echo oops >&2; exit 3"})
	out, err := b.Execute(context.Background(), env, in)
	if err != nil {
		t.Fatalf("非零退出码不应是系统错误: %v", err)
	}
	if !strings.Contains(out, "命令失败") || !strings.Contains(out, "oops") {
		t.Fatalf("out = %q", out)
	}
}

func TestGitReadonly(t *testing.T) {
	env := testEnv(t)
	g := &Git{}
	in, _ := json.Marshal(gitInput{Subcommand: "push"})
	if _, err := g.Execute(context.Background(), env, in); err == nil {
		t.Fatal("push 应被拒绝")
	}
}

func TestGrepFallback(t *testing.T) {
	env := testEnv(t)
	os.WriteFile(filepath.Join(env.Workdir, "x.go"), []byte("package main\nfunc Hello() {}\n"), 0o644)
	g := &Grep{}
	in, _ := json.Marshal(grepInput{Pattern: "func Hello", Include: "*.go"})
	out, err := g.Execute(context.Background(), env, in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "x.go:2") {
		t.Fatalf("out = %q", out)
	}
}

func TestGlob(t *testing.T) {
	env := testEnv(t)
	os.MkdirAll(filepath.Join(env.Workdir, "a/b"), 0o755)
	os.WriteFile(filepath.Join(env.Workdir, "a/b/c.ts"), []byte("x"), 0o644)
	g := &Glob{}
	in, _ := json.Marshal(globInput{Pattern: "**/*.ts"})
	out, err := g.Execute(context.Background(), env, in)
	if err != nil || !strings.Contains(out, "a/b/c.ts") {
		t.Fatalf("out=%q err=%v", out, err)
	}
}
