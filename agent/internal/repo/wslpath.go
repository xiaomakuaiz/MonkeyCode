// WSL 路径适配:内核跑在 WSL 里(桌面壳经 wsl.exe 拉起)时,UI 侧传来的
// 工作区路径可能是 Windows 表示——原生目录对话框选出的 \\wsl$\<发行版>\...
// UNC,或用户手动粘贴的 C:\... 盘符路径。这里统一翻译成 Linux 路径;
// 反向(Reveal 在资源管理器定位)则把 Linux 路径转回 Windows 表示。
package repo

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// InWSL 内核是否运行在 WSL 发行版内(wsl.exe 启动的环境必带 WSL_DISTRO_NAME)。
func InWSL() bool { return os.Getenv("WSL_DISTRO_NAME") != "" }

// \\wsl$\<distro>\... 或 \\wsl.localhost\<distro>\...(斜杠方向不限:
// UI 手动输入框里正反斜杠都可能出现)。
var wslUNCRe = regexp.MustCompile(`^[\\/]{2}wsl(\$|\.localhost)[\\/]([^\\/]+)([\\/].*)?$`)

// C:\... 或 C:/...
var driveRe = regexp.MustCompile(`^([A-Za-z]):[\\/]`)

// TranslateWindowsPath 把 Windows 表示的路径翻译为当前 WSL 发行版内的
// Linux 路径;Linux 路径原样返回。仅在 InWSL() 为真时有意义。
//   - \\wsl$\<distro>\home\x → /home/x(distro 必须是当前发行版,否则报错——
//     跨发行版的文件系统在本发行版内不可达)
//   - C:\Users\x → /mnt/c/Users/x(优先 wslpath 以兼容自定义挂载根,失败回退手写)
func TranslateWindowsPath(p string) (string, error) {
	if m := wslUNCRe.FindStringSubmatch(p); m != nil {
		distro, rest := m[2], m[3]
		if cur := os.Getenv("WSL_DISTRO_NAME"); !strings.EqualFold(distro, cur) {
			return "", fmt.Errorf("目录属于 WSL 发行版 %s,当前运行环境是 %s;请在设置中切换运行环境后重试", distro, cur)
		}
		if rest == "" {
			return "/", nil
		}
		return strings.ReplaceAll(rest, `\`, "/"), nil
	}
	if m := driveRe.FindStringSubmatch(p); m != nil {
		if out, err := runWslpath("-u", p); err == nil {
			return out, nil
		}
		// wslpath 不可用(极少数):按默认挂载根手写
		rest := strings.ReplaceAll(p[2:], `\`, "/")
		return "/mnt/" + strings.ToLower(m[1]) + rest, nil
	}
	return p, nil
}

// windowsPathOf 把 Linux 路径转回 Windows 表示(\\wsl.localhost\<distro>\...),
// 供 explorer.exe 使用。
func windowsPathOf(p string) (string, error) { return runWslpath("-w", p) }

func runWslpath(flag, p string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "wslpath", flag, p).Output()
	if err != nil {
		return "", fmt.Errorf("wslpath %s 失败: %w", flag, err)
	}
	s := strings.TrimSpace(string(out))
	if s == "" {
		return "", fmt.Errorf("wslpath %s 输出为空", flag)
	}
	return s, nil
}
