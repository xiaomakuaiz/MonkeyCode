//go:build !windows

package tools

import (
	"os/exec"
	"syscall"
)

// setProcAttrs 让子进程独立进程组,便于整组终止。
func setProcAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup 终止整个进程组。
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
