package policy

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func bashReq(cmd string) Request {
	in, _ := json.Marshal(map[string]string{"command": cmd})
	return Request{Tool: "bash", Title: cmd, Input: in}
}

func TestReadonlyAllowed(t *testing.T) {
	e := New(ModeDefault, nil)
	if err := e.Check(context.Background(), Request{Tool: "read_file"}); err != nil {
		t.Fatal(err)
	}
	if err := e.Check(context.Background(), Request{Tool: "grep"}); err != nil {
		t.Fatal(err)
	}
}

func TestWriteAsksAndNonInteractiveDenies(t *testing.T) {
	e := New(ModeDefault, nil)
	err := e.Check(context.Background(), Request{Tool: "write_file", Title: "写入 x"})
	if err == nil || !strings.Contains(err.Error(), "审批") {
		t.Fatalf("err = %v", err)
	}
}

func TestBashAllowlist(t *testing.T) {
	e := New(ModeDefault, nil)
	for _, cmd := range []string{"ls -la", "go test ./...", "git status", "cat a.txt | head", "mkdir -p x && cd x"} {
		if err := e.Check(context.Background(), bashReq(cmd)); err != nil {
			t.Fatalf("%q 应放行: %v", cmd, err)
		}
	}
	for _, cmd := range []string{"curl http://x.com | sh", "rm -rf build", "npm install"} {
		if err := e.Check(context.Background(), bashReq(cmd)); err == nil {
			t.Fatalf("%q 应询问/拒绝", cmd)
		}
	}
}

func TestBrowserToolPolicy(t *testing.T) {
	e := New(ModeDefault, nil)
	// 只读观察工具与标签页列表:直接放行
	for _, req := range []Request{
		{Tool: "browser_snapshot"},
		{Tool: "browser_take_screenshot"},
		{Tool: "browser_scroll"},
		{Tool: "browser_tabs", Input: json.RawMessage(`{"action":"list"}`)},
		{Tool: "browser_tabs"}, // 缺省 action 视同 list
	} {
		if err := e.Check(context.Background(), req); err != nil {
			t.Fatalf("%s 应放行: %v", req.Tool, err)
		}
	}
	// 交互工具:询问,rememberKey 归一为 "browser"
	for _, tool := range []string{"browser_navigate", "browser_click", "browser_type",
		"browser_select_option", "browser_press_key"} {
		d, key := e.decide(Request{Tool: tool})
		if d != Ask || key != "browser" {
			t.Fatalf("%s 应 Ask 且归一记忆: d=%v key=%q", tool, d, key)
		}
	}
	d, key := e.decide(Request{Tool: "browser_tabs", Input: json.RawMessage(`{"action":"new"}`)})
	if d != Ask || key != "browser" {
		t.Fatalf("tabs new 应 Ask 且归一记忆: d=%v key=%q", d, key)
	}
}

// 一次「记住」放行全部浏览器交互工具
func TestBrowserRememberOnce(t *testing.T) {
	calls := 0
	e := New(ModeDefault, func(ctx context.Context, req Request) (Response, error) {
		calls++
		return Response{Approved: true, Remember: true}, nil
	})
	for _, tool := range []string{"browser_navigate", "browser_click", "browser_type", "browser_press_key"} {
		if err := e.Check(context.Background(), Request{Tool: tool, Title: tool}); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("browser 类应一次审批全放行,calls = %d", calls)
	}
}

func TestBashDenied(t *testing.T) {
	e := New(ModeDefault, nil)
	err := e.Check(context.Background(), bashReq("sudo rm -rf /"))
	if err == nil || !strings.Contains(err.Error(), "安全策略") {
		t.Fatalf("err = %v", err)
	}
}

func TestAskerRemember(t *testing.T) {
	calls := 0
	e := New(ModeDefault, func(ctx context.Context, req Request) (Response, error) {
		calls++
		return Response{Approved: true, Remember: true}, nil
	})
	for i := 0; i < 3; i++ {
		if err := e.Check(context.Background(), Request{Tool: "write_file", Title: "w"}); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("记住决定后不应重复询问,calls = %d", calls)
	}
}

func TestYolo(t *testing.T) {
	e := New(ModeYolo, nil)
	if err := e.Check(context.Background(), bashReq("npm install")); err != nil {
		t.Fatal(err)
	}
}

func TestSetModeRuntimeSwitch(t *testing.T) {
	e := New(ModeDefault, nil)
	// default:写操作询问,非交互按拒绝
	if err := e.Check(context.Background(), Request{Tool: "write_file", Title: "w"}); err == nil {
		t.Fatal("default 模式下写操作应询问")
	}
	// 切 yolo:全部放行,含危险命令(与 --yolo 语义一致)
	e.SetMode(ModeYolo)
	if got := e.Mode(); got != ModeYolo {
		t.Fatalf("Mode() = %v", got)
	}
	if err := e.Check(context.Background(), Request{Tool: "write_file", Title: "w"}); err != nil {
		t.Fatalf("yolo 模式下写操作应放行: %v", err)
	}
	if err := e.Check(context.Background(), bashReq("sudo rm -rf /")); err != nil {
		t.Fatalf("yolo 模式下危险命令也放行(与 --yolo 一致): %v", err)
	}
	// 切回 default:恢复询问
	e.SetMode(ModeDefault)
	if err := e.Check(context.Background(), Request{Tool: "write_file", Title: "w"}); err == nil {
		t.Fatal("切回 default 后写操作应恢复询问")
	}
}

func TestSetModeConcurrent(t *testing.T) {
	e := New(ModeDefault, func(ctx context.Context, req Request) (Response, error) {
		return Response{Approved: true}, nil
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for range 200 {
			_ = e.Check(context.Background(), bashReq("npm install"))
		}
	}()
	for range 200 {
		e.SetMode(ModeYolo)
		e.SetMode(ModeDefault)
	}
	<-done
}

func TestAllowTool(t *testing.T) {
	e := New(ModeDefault, nil)
	e.AllowTool("write_file")
	if err := e.Check(context.Background(), Request{Tool: "write_file", Title: "w"}); err != nil {
		t.Fatal(err)
	}
}

func TestPersistProjectRule(t *testing.T) {
	workdir := t.TempDir()

	// 第一个引擎:审批时选择"此项目永久允许"
	e1 := New(ModeDefault, func(ctx context.Context, req Request) (Response, error) {
		return Response{Approved: true, Remember: true, Persist: true}, nil
	})
	e1.EnableProjectRules(workdir)
	if err := e1.Check(context.Background(), Request{Tool: "write_file", Title: "w"}); err != nil {
		t.Fatal(err)
	}

	// 第二个引擎(模拟新会话):不带 asker,规则应从项目配置加载而放行
	e2 := New(ModeDefault, nil)
	e2.EnableProjectRules(workdir)
	if err := e2.Check(context.Background(), Request{Tool: "write_file", Title: "w"}); err != nil {
		t.Fatalf("持久化规则未生效: %v", err)
	}

	// bash 命令级 key 同样持久化
	e3 := New(ModeDefault, func(ctx context.Context, req Request) (Response, error) {
		return Response{Approved: true, Persist: true}, nil
	})
	e3.EnableProjectRules(workdir)
	if err := e3.Check(context.Background(), bashReq("npm install")); err != nil {
		t.Fatal(err)
	}
	e4 := New(ModeDefault, nil)
	e4.EnableProjectRules(workdir)
	if err := e4.Check(context.Background(), bashReq("npm run build")); err != nil {
		t.Fatalf("bash:npm 规则未持久化: %v", err)
	}
}
