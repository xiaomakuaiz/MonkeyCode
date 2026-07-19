package repo

import (
	"strings"
	"testing"
)

func TestInWSL(t *testing.T) {
	t.Setenv("WSL_DISTRO_NAME", "")
	if InWSL() {
		t.Fatal("无 WSL_DISTRO_NAME 时 InWSL 应为 false")
	}
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu")
	if !InWSL() {
		t.Fatal("有 WSL_DISTRO_NAME 时 InWSL 应为 true")
	}
}

func TestTranslateWindowsPath(t *testing.T) {
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu-22.04")
	// wslpath 在开发机不存在 → 盘符路径走手写回退分支,恰好可测
	t.Setenv("PATH", "")

	cases := []struct {
		name, in, want string
		wantErr        string
	}{
		{name: "UNC wsl$", in: `\\wsl$\Ubuntu-22.04\home\me\proj`, want: "/home/me/proj"},
		{name: "UNC wsl.localhost", in: `\\wsl.localhost\Ubuntu-22.04\home\me`, want: "/home/me"},
		{name: "UNC 正斜杠变体", in: `//wsl.localhost/Ubuntu-22.04/home/me`, want: "/home/me"},
		{name: "UNC 发行版名大小写不敏感", in: `\\wsl$\ubuntu-22.04\srv`, want: "/srv"},
		{name: "UNC 仅发行版根", in: `\\wsl$\Ubuntu-22.04`, want: "/"},
		{name: "UNC 发行版不匹配", in: `\\wsl$\Debian\home\me`, wantErr: "Debian"},
		{name: "盘符大写", in: `C:\Users\me\dev`, want: "/mnt/c/Users/me/dev"},
		{name: "盘符小写正斜杠", in: `d:/work/proj`, want: "/mnt/d/work/proj"},
		{name: "Linux 路径直通", in: "/home/me/proj", want: "/home/me/proj"},
		{name: "波浪线直通", in: "~/proj", want: "~/proj"},
		{name: "相对路径直通", in: "proj", want: "proj"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := TranslateWindowsPath(c.in)
			if c.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("期望错误含 %q,得到 got=%q err=%v", c.wantErr, got, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("意外错误: %v", err)
			}
			if got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}
