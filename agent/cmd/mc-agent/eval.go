package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/spf13/cobra"

	"github.com/chaitin/MonkeyCode/agent/internal/config"
	"github.com/chaitin/MonkeyCode/agent/internal/contextmgr"
	"github.com/chaitin/MonkeyCode/agent/internal/frame"
	"github.com/chaitin/MonkeyCode/agent/internal/loop"
	"github.com/chaitin/MonkeyCode/agent/internal/policy"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
)

// evalTask 评测任务定义(eval/tasks/<name>/task.json)。
type evalTask struct {
	Name        string `json:"-"`
	Description string `json:"description"`
	Prompt      string `json:"prompt"`
	Check       string `json:"check"`       // 在任务工作区执行的判分命令,退出码 0 视为通过
	TimeoutSec  int    `json:"timeout_sec"` // 单任务超时(默认 600)
}

// evalResult 单任务评测结果。
type evalResult struct {
	Name         string  `json:"name"`
	Passed       bool    `json:"passed"`
	Error        string  `json:"error,omitempty"`
	Steps        int     `json:"steps"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	DurationSec  float64 `json:"duration_sec"`
	CheckOutput  string  `json:"check_output,omitempty"`
}

type evalReport struct {
	Model     string       `json:"model"`
	Provider  string       `json:"provider"`
	StartedAt time.Time    `json:"started_at"`
	Results   []evalResult `json:"results"`
	Passed    int          `json:"passed"`
	Total     int          `json:"total"`
}

func evalCmd() *cobra.Command {
	var tasksDir, only, reportPath string
	cmd := &cobra.Command{
		Use:   "eval",
		Short: "运行评测任务集并出分",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			if flags.provider != "" {
				cfg.Provider = flags.provider
			}
			if flags.baseURL != "" {
				cfg.BaseURL = flags.baseURL
			}
			if flags.apiKey != "" {
				cfg.APIKey = flags.apiKey
			}
			if flags.model != "" {
				cfg.Model = flags.model
			}
			if err := cfg.Validate(); err != nil {
				return err
			}

			tasks, err := loadEvalTasks(tasksDir, only)
			if err != nil {
				return err
			}
			if len(tasks) == 0 {
				return fmt.Errorf("在 %s 下没有找到评测任务", tasksDir)
			}

			report := evalReport{Model: cfg.Model, Provider: cfg.Provider, StartedAt: time.Now(), Total: len(tasks)}
			for _, t := range tasks {
				fmt.Printf("== 任务 %s: %s\n", t.Name, t.Description)
				res := runEvalTask(cfg, tasksDir, t)
				report.Results = append(report.Results, res)
				status := "FAIL"
				if res.Passed {
					report.Passed++
					status = "PASS"
				}
				fmt.Printf("   %s  步数=%d tokens=%d/%d 用时=%.1fs %s\n",
					status, res.Steps, res.InputTokens, res.OutputTokens, res.DurationSec, firstLine(res.Error))
			}

			fmt.Printf("\n总计: %d/%d 通过(模型 %s)\n", report.Passed, report.Total, report.Model)
			if reportPath != "" {
				data, _ := json.MarshalIndent(report, "", "  ")
				if err := os.WriteFile(reportPath, data, 0o644); err != nil {
					return err
				}
				fmt.Println("报告已写入", reportPath)
			}
			if report.Passed < report.Total {
				return fmt.Errorf("%d 个任务未通过", report.Total-report.Passed)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&tasksDir, "tasks", "eval/tasks", "任务集目录")
	cmd.Flags().StringVar(&only, "task", "", "只运行指定名称的任务")
	cmd.Flags().StringVar(&reportPath, "report", "", "JSON 报告输出路径")
	return cmd
}

func loadEvalTasks(dir, only string) ([]evalTask, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var tasks []evalTask
	for _, e := range entries {
		if !e.IsDir() || (only != "" && e.Name() != only) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name(), "task.json"))
		if err != nil {
			continue
		}
		var t evalTask
		if err := json.Unmarshal(data, &t); err != nil {
			return nil, fmt.Errorf("任务 %s 定义无效: %w", e.Name(), err)
		}
		t.Name = e.Name()
		tasks = append(tasks, t)
	}
	return tasks, nil
}

func runEvalTask(cfg *config.Config, tasksDir string, t evalTask) (res evalResult) {
	res = evalResult{Name: t.Name}
	start := time.Now()
	// 命名返回值:defer 在 return 之后仍能写入耗时
	defer func() { res.DurationSec = time.Since(start).Seconds() }()

	// 1. 准备隔离工作区
	workdir, err := os.MkdirTemp("", "mc-eval-"+t.Name+"-")
	if err != nil {
		res.Error = err.Error()
		return res
	}
	defer os.RemoveAll(workdir)
	fixture := filepath.Join(tasksDir, t.Name, "files")
	if _, err := os.Stat(fixture); err == nil {
		if err := copyDir(fixture, workdir); err != nil {
			res.Error = "复制任务文件失败: " + err.Error()
			return res
		}
	}
	initGitRepo(workdir) // 真实工作区都是 git 仓库;失败不影响评测

	// 2. 运行 agent(yolo,无审批,无会话)
	var p provider.Provider
	if cfg.Provider == "openai" {
		p = provider.NewOpenAI(cfg.BaseURL, cfg.APIKey, cfg.Model)
	} else {
		p = provider.NewAnthropic(cfg.BaseURL, cfg.APIKey, cfg.Model)
	}
	builder := &frame.Builder{}
	renderer := NewRenderer()
	renderer.Quiet = true
	engine := loop.New(p, tools.NewRegistry(), policy.New(policy.ModeYolo, nil),
		renderer, builder, workdir, contextmgr.Build(workdir), loop.Options{})

	timeout := time.Duration(t.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 600 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	_, runErr := engine.RunTurn(ctx, t.Prompt)
	renderer.Flush()
	res.Steps = countSteps(engine)
	res.InputTokens = engine.Usage.InputTokens
	res.OutputTokens = engine.Usage.OutputTokens
	if runErr != nil {
		res.Error = "agent 执行失败: " + runErr.Error()
		return res
	}

	// 3. 判分
	checkCtx, checkCancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer checkCancel()
	var check *exec.Cmd
	if runtime.GOOS == "windows" {
		check = exec.CommandContext(checkCtx, "powershell", "-NoProfile", "-Command", t.Check)
	} else {
		check = exec.CommandContext(checkCtx, "bash", "-c", t.Check)
	}
	check.Dir = workdir
	// 判分环境:禁用 Go 的 VCS stamping(临时仓库的 git 状态不应影响构建)
	check.Env = append(os.Environ(), "GOFLAGS=-buildvcs=false", "GIT_TERMINAL_PROMPT=0")
	out, checkErr := check.CombinedOutput()
	res.CheckOutput = string(out)
	if checkErr != nil {
		res.Error = "判分未通过: " + firstLine(string(out))
		return res
	}
	res.Passed = true
	return res
}

func countSteps(e *loop.Engine) int {
	n := 0
	for _, m := range e.Messages {
		if m.Role == provider.RoleAssistant {
			n++
		}
	}
	return n
}

// initGitRepo 把评测工作区初始化为带首次提交的 git 仓库。
func initGitRepo(dir string) {
	for _, args := range [][]string{
		{"init", "-q"},
		{"-c", "user.email=eval@mc-agent", "-c", "user.name=mc-eval", "add", "-A"},
		{"-c", "user.email=eval@mc-agent", "-c", "user.name=mc-eval", "commit", "-qm", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if err := cmd.Run(); err != nil {
			return
		}
	}
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.Create(target)
		if err != nil {
			return err
		}
		defer out.Close()
		_, err = io.Copy(out, in)
		return err
	})
}
