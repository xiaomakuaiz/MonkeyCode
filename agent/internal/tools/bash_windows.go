//go:build windows

package tools

import (
	"os/exec"
)

func setProcAttrs(_ *exec.Cmd) {}

func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
