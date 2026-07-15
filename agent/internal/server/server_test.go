package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/chaitin/MonkeyCode/agent/internal/frame"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/session"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
)

// stubProvider 按脚本依次返回结果。
type stubProvider struct {
	results []*provider.Result
	idx     int
}

func (s *stubProvider) Model() string { return "stub" }

func (s *stubProvider) Stream(ctx context.Context, req provider.Request, h *provider.StreamHandler) (*provider.Result, error) {
	if s.idx >= len(s.results) {
		return nil, fmt.Errorf("stub 脚本耗尽")
	}
	res := s.results[s.idx]
	s.idx++
	for _, b := range res.Message.Content {
		if b.Type == provider.BlockText && h != nil && h.OnText != nil {
			h.OnText(b.Text)
		}
	}
	return res, nil
}

func textResult(text string) *provider.Result {
	return &provider.Result{
		Message:    provider.Message{Role: provider.RoleAssistant, Content: []provider.ContentBlock{{Type: provider.BlockText, Text: text}}},
		StopReason: provider.StopEndTurn,
		Usage:      provider.Usage{InputTokens: 10, OutputTokens: 5},
	}
}

func toolUseResult(name, input string) *provider.Result {
	return &provider.Result{
		Message: provider.Message{Role: provider.RoleAssistant, Content: []provider.ContentBlock{
			{Type: provider.BlockToolUse, ID: "t1", Name: name, Input: []byte(input)},
		}},
		StopReason: provider.StopToolUse,
	}
}

func newTestServer(t *testing.T, stub *stubProvider) (*Server, *httptest.Server) {
	t.Helper()
	srv, err := New(Options{
		Token:       "test-token",
		SessionRoot: t.TempDir(),
		Model:       "stub",
		NewProvider: func(string) (provider.Provider, error) { return stub, nil },
		AskTimeout:  5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts
}

func apiReq(t *testing.T, ts *httptest.Server, method, path, token, body string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, data
}

func TestAuthRequired(t *testing.T) {
	_, ts := newTestServer(t, &stubProvider{})
	resp, _ := apiReq(t, ts, "GET", "/api/sessions", "", "")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	resp, _ = apiReq(t, ts, "GET", "/api/sessions", "wrong", "")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	// healthz 无需鉴权
	resp, _ = apiReq(t, ts, "GET", "/healthz", "", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz status = %d", resp.StatusCode)
	}
}

func createSession(t *testing.T, ts *httptest.Server, workdir string) string {
	t.Helper()
	resp, body := apiReq(t, ts, "POST", "/api/sessions", "test-token",
		fmt.Sprintf(`{"workdir":%q}`, workdir))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create status = %d: %s", resp.StatusCode, body)
	}
	var meta struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &meta); err != nil || meta.ID == "" {
		t.Fatalf("meta: %s", body)
	}
	return meta.ID
}

func TestCreateAndListSessions(t *testing.T) {
	_, ts := newTestServer(t, &stubProvider{})
	id := createSession(t, ts, t.TempDir())

	resp, body := apiReq(t, ts, "GET", "/api/sessions", "test-token", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d", resp.StatusCode)
	}
	if !strings.Contains(string(body), id) {
		t.Fatalf("list 缺少会话 %s: %s", id, body)
	}

	// 不存在的工作区
	resp, _ = apiReq(t, ts, "POST", "/api/sessions", "test-token", `{"workdir":"/no/such/dir"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

// wsFrames 收集下行帧直到满足条件或超时。
func wsCollect(t *testing.T, conn *websocket.Conn, until func([]frame.Frame) bool) []frame.Frame {
	t.Helper()
	var frames []frame.Frame
	deadline := time.After(10 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatalf("等待帧超时,已收到 %d 帧: %+v", len(frames), summary(frames))
		default:
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, data, err := conn.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("read: %v(已收 %v)", err, summary(frames))
		}
		var f frame.Frame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		frames = append(frames, f)
		if until(frames) {
			return frames
		}
	}
}

func summary(frames []frame.Frame) []string {
	out := make([]string, len(frames))
	for i, f := range frames {
		out[i] = string(f.Type)
	}
	return out
}

func hasType(frames []frame.Frame, t frame.Type) bool {
	for _, f := range frames {
		if f.Type == t {
			return true
		}
	}
	return false
}

func dialWS(t *testing.T, ts *httptest.Server, id string) *websocket.Conn {
	t.Helper()
	url := strings.Replace(ts.URL, "http://", "ws://", 1) +
		"/ws?session=" + id + "&token=test-token"
	conn, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(websocket.StatusNormalClosure, "") })
	return conn
}

func sendFrame(t *testing.T, conn *websocket.Conn, typ frame.Type, payload any) {
	t.Helper()
	data, _ := json.Marshal(payload)
	f := frame.Frame{Type: typ, Data: data, Timestamp: time.Now().UnixMilli()}
	raw, _ := json.Marshal(f)
	if err := conn.Write(context.Background(), websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
}

func TestWSTurnFlow(t *testing.T) {
	stub := &stubProvider{results: []*provider.Result{textResult("任务完成")}}
	_, ts := newTestServer(t, stub)
	id := createSession(t, ts, t.TempDir())
	conn := dialWS(t, ts, id)

	sendFrame(t, conn, frame.TypeUserInput, map[string][]byte{"content": []byte("做点事")})
	frames := wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasType(fs, frame.TypeTaskEnded)
	})
	if !hasType(frames, frame.TypeTaskStarted) || !hasType(frames, frame.TypeUserInput) {
		t.Fatalf("缺少预期帧: %v", summary(frames))
	}
	// agent 文本应出现在 acp_event 帧里
	var gotText bool
	for _, f := range frames {
		if f.Type == frame.TypeTaskRunning && f.Kind == frame.KindACPEvent &&
			strings.Contains(string(f.Data), "任务完成") {
			gotText = true
		}
	}
	if !gotText {
		t.Fatalf("未收到 agent 文本帧: %v", summary(frames))
	}
}

func TestWSReplayOnReconnect(t *testing.T) {
	stub := &stubProvider{results: []*provider.Result{textResult("第一轮回复")}}
	_, ts := newTestServer(t, stub)
	id := createSession(t, ts, t.TempDir())

	conn := dialWS(t, ts, id)
	sendFrame(t, conn, frame.TypeUserInput, map[string][]byte{"content": []byte("hi")})
	wsCollect(t, conn, func(fs []frame.Frame) bool { return hasType(fs, frame.TypeTaskEnded) })
	conn.Close(websocket.StatusNormalClosure, "")

	// 重连应回放全部历史
	conn2 := dialWS(t, ts, id)
	frames := wsCollect(t, conn2, func(fs []frame.Frame) bool {
		return hasType(fs, frame.TypeTaskEnded)
	})
	if !hasType(frames, frame.TypeUserInput) {
		t.Fatalf("回放缺少 user-input: %v", summary(frames))
	}
}

// TestWSReplayLargeHistory 回放帧数远超发送缓冲(1024)时必须完整送达,
// 不得按慢消费者断开(回归:长会话刷新后只渲染出一小段)。
func TestWSReplayLargeHistory(t *testing.T) {
	srv, ts := newTestServer(t, &stubProvider{})
	id := createSession(t, ts, t.TempDir())

	sess, err := session.Load(srv.opts.SessionRoot, id)
	if err != nil {
		t.Fatal(err)
	}
	b := &frame.Builder{}
	const total = 3000
	for range total {
		sess.Emit(b.AgentText("x"))
	}
	sess.Close()

	conn := dialWS(t, ts, id)
	// 回放压缩:3000 个文本增量合并为极少数帧,但文本必须完整送达
	frames := wsCollect(t, conn, func(fs []frame.Frame) bool { return replayTextLen(fs) >= total })
	if got := replayTextLen(frames); got < total {
		t.Fatalf("回放文本不完整: %d/%d", got, total)
	}
	if len(frames) > 50 {
		t.Fatalf("回放未压缩: %d 帧", len(frames))
	}
}

// replayTextLen 统计回放帧里 agent 文本增量的总长度。
func replayTextLen(fs []frame.Frame) int {
	n := 0
	for _, f := range fs {
		if f.Type != frame.TypeTaskRunning || f.Kind != frame.KindACPEvent {
			continue
		}
		var env struct {
			Update struct {
				SessionUpdate string `json:"sessionUpdate"`
				Content       struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"update"`
		}
		if json.Unmarshal(f.Data, &env) == nil && env.Update.SessionUpdate == "agent_message_chunk" {
			n += len(env.Update.Content.Text)
		}
	}
	return n
}

func TestWSPermissionFlow(t *testing.T) {
	stub := &stubProvider{results: []*provider.Result{
		toolUseResult("write_file", `{"path":"a.txt","content":"x"}`),
		textResult("好的,已停止"),
	}}
	_, ts := newTestServer(t, stub)
	id := createSession(t, ts, t.TempDir())
	conn := dialWS(t, ts, id)

	sendFrame(t, conn, frame.TypeUserInput, map[string][]byte{"content": []byte("写个文件")})

	// 等 permission-req
	frames := wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasType(fs, frame.TypePermissionReq)
	})
	var req struct {
		ID   string `json:"id"`
		Tool string `json:"tool"`
	}
	for _, f := range frames {
		if f.Type == frame.TypePermissionReq {
			if err := json.Unmarshal(f.Data, &req); err != nil {
				t.Fatal(err)
			}
		}
	}
	if req.ID == "" || req.Tool != "write_file" {
		t.Fatalf("permission-req 载荷异常: %+v", req)
	}

	// 拒绝 → 工具失败 → stub 第二个结果结束本轮
	sendFrame(t, conn, frame.TypePermissionResp,
		map[string]any{"id": req.ID, "approved": false, "remember": false})
	frames = wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasType(fs, frame.TypeTaskEnded)
	})
	var toolFailed bool
	for _, f := range frames {
		if f.Type == frame.TypeTaskRunning && strings.Contains(string(f.Data), "failed") {
			toolFailed = true
		}
	}
	if !toolFailed {
		t.Fatalf("拒绝后工具应标记 failed: %v", summary(frames))
	}
}

// TestWSPermissionApprove 批准后工具真实执行,轮次继续到结束。
func TestWSPermissionApprove(t *testing.T) {
	workdir := t.TempDir()
	stub := &stubProvider{results: []*provider.Result{
		toolUseResult("write_file", `{"path":"ok.txt","content":"approved"}`),
		textResult("已写入"),
	}}
	_, ts := newTestServer(t, stub)
	id := createSession(t, ts, workdir)
	conn := dialWS(t, ts, id)

	sendFrame(t, conn, frame.TypeUserInput, map[string][]byte{"content": []byte("写文件")})
	frames := wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasType(fs, frame.TypePermissionReq)
	})
	var req struct{ ID string }
	for _, f := range frames {
		if f.Type == frame.TypePermissionReq {
			_ = json.Unmarshal(f.Data, &req)
		}
	}
	sendFrame(t, conn, frame.TypePermissionResp,
		map[string]any{"id": req.ID, "approved": true, "remember": false})
	frames = wsCollect(t, conn, func(fs []frame.Frame) bool { return hasType(fs, frame.TypeTaskEnded) })

	data, err := os.ReadFile(filepath.Join(workdir, "ok.txt"))
	if err != nil || string(data) != "approved" {
		t.Fatalf("批准后文件未写入: %v %q", err, data)
	}
	// 审批终态必须广播且落日志
	var resolved bool
	for _, f := range frames {
		if f.Type == frame.TypePermissionResolved && strings.Contains(string(f.Data), "approved") {
			resolved = true
		}
	}
	if !resolved {
		t.Fatalf("缺少 permission-resolved(approved) 帧: %v", summary(frames))
	}
}

// TestPermissionTimeoutResolves 审批超时必须广播 timeout 终态且轮次继续。
func TestPermissionTimeoutResolves(t *testing.T) {
	stub := &stubProvider{results: []*provider.Result{
		toolUseResult("write_file", `{"path":"x.txt","content":"x"}`),
		textResult("好的,已跳过"),
	}}
	srv, err := New(Options{
		Token:       "test-token",
		SessionRoot: t.TempDir(),
		Model:       "stub",
		NewProvider: func(string) (provider.Provider, error) { return stub, nil },
		AskTimeout:  150 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	id := createSession(t, ts, t.TempDir())
	conn := dialWS(t, ts, id)
	sendFrame(t, conn, frame.TypeUserInput, map[string][]byte{"content": []byte("写文件")})

	frames := wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasType(fs, frame.TypeTaskEnded)
	})
	var timeoutResolved bool
	for _, f := range frames {
		if f.Type == frame.TypePermissionResolved && strings.Contains(string(f.Data), "timeout") {
			timeoutResolved = true
		}
	}
	if !timeoutResolved {
		t.Fatalf("缺少 permission-resolved(timeout) 帧: %v", summary(frames))
	}
}

// TestStaleRunningSessionClosedOnLoad 服务重启后,遗留 running 状态的会话
// 必须在回放尾部出现明确终态(task-error),避免客户端对着已死的审批等待。
func TestStaleRunningSessionClosedOnLoad(t *testing.T) {
	srv, ts := newTestServer(t, &stubProvider{})
	id := createSession(t, ts, t.TempDir())

	// 模拟旧进程遗留:running 状态 + 未答复的审批请求
	sess, err := session.Load(srv.opts.SessionRoot, id)
	if err != nil {
		t.Fatal(err)
	}
	b := &frame.Builder{}
	sess.Emit(b.TaskStarted())
	sess.Emit(b.PermissionReq("dead-ask", "write_file", "写入 x"))
	sess.Meta.Status = "running"
	if err := sess.SaveMeta(); err != nil {
		t.Fatal(err)
	}
	sess.Close()

	conn := dialWS(t, ts, id)
	frames := wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasType(fs, frame.TypeTaskError)
	})
	if !hasType(frames, frame.TypePermissionReq) {
		t.Fatalf("回放缺少历史审批帧: %v", summary(frames))
	}
	last := frames[len(frames)-1]
	if last.Type != frame.TypeTaskError || !strings.Contains(string(last.Data), "中断") {
		t.Fatalf("回放末尾缺少中断终态: %v", summary(frames))
	}

	metas, _ := session.List(srv.opts.SessionRoot)
	for _, m := range metas {
		if m.ID == id && m.Status != "interrupted" {
			t.Fatalf("meta 状态应为 interrupted,实际 %s", m.Status)
		}
	}
}

// TestStalePermissionRespGetsError 对失效审批的响应必须得到明确错误反馈,不再静默忽略。
func TestStalePermissionRespGetsError(t *testing.T) {
	_, ts := newTestServer(t, &stubProvider{})
	id := createSession(t, ts, t.TempDir())
	conn := dialWS(t, ts, id)

	sendFrame(t, conn, frame.TypePermissionResp,
		map[string]any{"id": "no-such-ask", "approved": true})
	frames := wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasType(fs, frame.TypeTaskError)
	})
	last := frames[len(frames)-1]
	if !strings.Contains(string(last.Data), "失效") {
		t.Fatalf("应回发失效提示: %s", last.Data)
	}
}

// TestWSCallFileChanges 通过 WS call 查询变更列表并读文件,验证同步查询链路。
func TestWSCallFileChanges(t *testing.T) {
	workdir := t.TempDir()
	os.WriteFile(filepath.Join(workdir, "hello.txt"), []byte("world"), 0o644)

	_, ts := newTestServer(t, &stubProvider{})
	id := createSession(t, ts, workdir)
	conn := dialWS(t, ts, id)

	// 读文件
	sendCall(t, conn, frame.KindRepoReadFile, map[string]string{"path": "hello.txt"})
	frames := wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasCallResponse(fs, frame.KindRepoReadFile)
	})
	resp := lastCallResponse(frames, frame.KindRepoReadFile)
	if !strings.Contains(string(resp.Data), "world") {
		t.Fatalf("read 结果异常: %s", resp.Data)
	}

	// 列目录
	sendCall(t, conn, frame.KindRepoFileList, map[string]string{"path": ""})
	frames = wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasCallResponse(fs, frame.KindRepoFileList)
	})
	if !strings.Contains(string(lastCallResponse(frames, frame.KindRepoFileList).Data), "hello.txt") {
		t.Fatal("file list 缺文件")
	}

	// 越界读文件应返回 error 字段
	sendCall(t, conn, frame.KindRepoReadFile, map[string]string{"path": "../../etc/passwd"})
	frames = wsCollect(t, conn, func(fs []frame.Frame) bool {
		r := lastCallResponse(fs, frame.KindRepoReadFile)
		return r != nil && strings.Contains(string(r.Data), "error")
	})
	_ = frames
}

func sendCall(t *testing.T, conn *websocket.Conn, kind string, payload any) {
	t.Helper()
	data, _ := json.Marshal(payload)
	f := frame.Frame{Type: frame.TypeCall, Kind: kind, Data: data, Timestamp: time.Now().UnixMilli()}
	raw, _ := json.Marshal(f)
	if err := conn.Write(context.Background(), websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
}

func hasCallResponse(fs []frame.Frame, kind string) bool {
	return lastCallResponse(fs, kind) != nil
}

func lastCallResponse(fs []frame.Frame, kind string) *frame.Frame {
	for i := len(fs) - 1; i >= 0; i-- {
		if fs[i].Type == frame.TypeCallResponse && fs[i].Kind == kind {
			return &fs[i]
		}
	}
	return nil
}

func TestNonLoopbackRefused(t *testing.T) {
	_, err := New(Options{
		Addr:        "0.0.0.0:7439",
		NewProvider: func(string) (provider.Provider, error) { return &stubProvider{}, nil },
	})
	if err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("err = %v", err)
	}
}

func TestChildSessionObserver(t *testing.T) {
	srv, ts := newTestServer(t, &stubProvider{})

	// 直接落盘一个"运行中"的子会话(模拟子代理创建)
	child, err := session.New(srv.opts.SessionRoot, t.TempDir(), "stub", "子探索")
	if err != nil {
		t.Fatal(err)
	}
	child.Meta.Parent = "parent-xyz"
	child.Meta.Status = "running"
	if err := child.SaveMeta(); err != nil {
		t.Fatal(err)
	}
	b := &frame.Builder{}
	f1 := b.TaskStarted()
	child.Emit(f1)

	// 列表默认隐藏子会话,?all=1 显示
	_, data := apiReq(t, ts, "GET", "/api/sessions", "test-token", "")
	if strings.Contains(string(data), child.Meta.ID) {
		t.Fatal("列表应默认隐藏子会话")
	}
	_, data = apiReq(t, ts, "GET", "/api/sessions?all=1", "test-token", "")
	if !strings.Contains(string(data), child.Meta.ID) {
		t.Fatal("?all=1 应包含子会话")
	}

	// 观察者连接:回放已有帧
	conn := dialWS(t, ts, child.Meta.ID)
	frames := wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasType(fs, frame.TypeTaskStarted)
	})
	if frames[0].Seq != f1.Seq {
		t.Fatalf("回放帧 seq: %d != %d", frames[0].Seq, f1.Seq)
	}

	// 上行帧被忽略(观察者只读),连接不断开
	sendFrame(t, conn, frame.TypeUserInput, map[string][]byte{"content": []byte("不该生效")})

	// 实时:落盘 + publishChild → 观察者收到且无重帧
	f2 := b.AgentText("实时增量")
	child.Emit(f2)
	srv.publishChild(child.Meta.ID, f2)
	frames = wsCollect(t, conn, func(fs []frame.Frame) bool {
		return len(fs) >= 1
	})
	if frames[0].Seq != f2.Seq || !strings.Contains(string(frames[0].Data), "实时增量") {
		t.Fatalf("实时帧错误: %+v", frames[0])
	}

	// 水位:重发旧帧(seq<=水位)不应到达观察者
	srv.publishChild(child.Meta.ID, f1)
	f3 := b.AgentText("第三帧")
	child.Emit(f3)
	srv.publishChild(child.Meta.ID, f3)
	frames = wsCollect(t, conn, func(fs []frame.Frame) bool { return len(fs) >= 1 })
	if frames[0].Seq != f3.Seq {
		t.Fatalf("水位去重失效,收到 seq=%d", frames[0].Seq)
	}
	child.Close()
}

// namedStub 带名字的脚本 provider(多模型测试用)。
type namedStub struct {
	stubProvider
	name string
}

func (n *namedStub) Model() string { return n.name }

func TestPerSessionModelAndSwitch(t *testing.T) {
	stubs := map[string]*namedStub{
		"a": {name: "a", stubProvider: stubProvider{results: []*provider.Result{textResult("来自A")}}},
		"b": {name: "b", stubProvider: stubProvider{results: []*provider.Result{textResult("来自B")}}},
	}
	srv, err := New(Options{
		Token:       "test-token",
		SessionRoot: t.TempDir(),
		Model:       "a",
		NewProvider: func(name string) (provider.Provider, error) {
			if name == "" {
				name = "a"
			}
			s, ok := stubs[name]
			if !ok {
				return nil, fmt.Errorf("未知模型 %q", name)
			}
			return s, nil
		},
		ListModels: func() []ModelInfo {
			return []ModelInfo{{Name: "a", Default: true}, {Name: "b"}}
		},
		AskTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// 模型清单端点
	resp, data := apiReq(t, ts, "GET", "/api/models", "test-token", "")
	if resp.StatusCode != 200 || !strings.Contains(string(data), `"a"`) || !strings.Contains(string(data), `"b"`) {
		t.Fatalf("models: %s", data)
	}

	// 未知模型建会话应 400
	resp, _ = apiReq(t, ts, "POST", "/api/sessions", "test-token",
		fmt.Sprintf(`{"workdir":%q,"model":"nope"}`, t.TempDir()))
	if resp.StatusCode != 400 {
		t.Fatalf("未知模型应 400,得 %d", resp.StatusCode)
	}

	// 指定模型 b 建会话,首轮走 B
	resp, data = apiReq(t, ts, "POST", "/api/sessions", "test-token",
		fmt.Sprintf(`{"workdir":%q,"model":"b"}`, t.TempDir()))
	if resp.StatusCode != 200 {
		t.Fatalf("create: %d %s", resp.StatusCode, data)
	}
	var meta session.Meta
	_ = json.Unmarshal(data, &meta)
	if meta.Model != "b" {
		t.Fatalf("meta.Model = %q", meta.Model)
	}

	conn := dialWS(t, ts, meta.ID)
	sendFrame(t, conn, frame.TypeUserInput, map[string][]byte{"content": []byte("hi")})
	frames := wsCollect(t, conn, func(fs []frame.Frame) bool { return hasType(fs, frame.TypeTaskEnded) })
	if !framesContain(frames, "来自B") {
		t.Fatalf("首轮应走模型 b: %v", summary(frames))
	}

	// 切到 a:call 返回 ok + model_update 帧 + meta 落盘
	sendCall(t, conn, frame.KindSessionSetModel, map[string]string{"model": "a"})
	frames = wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasType(fs, frame.TypeCallResponse) && framesContain(fs, "model_update")
	})
	if !framesContain(frames, `"model":"a"`) {
		t.Fatalf("set_model 响应: %v", summary(frames))
	}
	if m, err := session.ReadMeta(srv.opts.SessionRoot, meta.ID); err != nil || m.Model != "a" {
		t.Fatalf("meta 未更新: %+v err=%v", m, err)
	}

	// 下一轮走 A
	sendFrame(t, conn, frame.TypeUserInput, map[string][]byte{"content": []byte("again")})
	frames = wsCollect(t, conn, func(fs []frame.Frame) bool { return hasType(fs, frame.TypeTaskEnded) })
	if !framesContain(frames, "来自A") {
		t.Fatalf("切换后应走模型 a: %v", summary(frames))
	}

	// 执行中拒绝切换(直接驱动内部状态)
	ls, err := srv.liveSession(meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	ls.mu.Lock()
	ls.running = true
	ls.turnSeq++ // 模拟真实新轮次(防旧轮次延迟收尾干扰)
	ls.mu.Unlock()
	if _, err := ls.setModel("b"); err == nil {
		t.Fatal("执行中应拒绝切换")
	}
	ls.mu.Lock()
	ls.running = false
	ls.mu.Unlock()
}

// TestWSSetMode 切换权限模式:call 成功 + permission_mode_update 广播 + meta 落盘,
// 非法 mode 报错。
func TestWSSetMode(t *testing.T) {
	srv, ts := newTestServer(t, &stubProvider{})
	id := createSession(t, ts, t.TempDir())
	conn := dialWS(t, ts, id)

	sendCall(t, conn, frame.KindSessionSetMode, map[string]string{"mode": "yolo"})
	frames := wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasCallResponse(fs, frame.KindSessionSetMode) && framesContain(fs, "permission_mode_update")
	})
	if !framesContain(frames, `"mode":"yolo"`) {
		t.Fatalf("set_mode 响应异常: %v", summary(frames))
	}
	if m, err := session.ReadMeta(srv.opts.SessionRoot, id); err != nil || m.Mode != "yolo" {
		t.Fatalf("meta.Mode 未落盘: %+v err=%v", m, err)
	}

	// 切回 default:meta 存空串
	sendCall(t, conn, frame.KindSessionSetMode, map[string]string{"mode": "default"})
	wsCollect(t, conn, func(fs []frame.Frame) bool {
		r := lastCallResponse(fs, frame.KindSessionSetMode)
		return r != nil && strings.Contains(string(r.Data), `"mode":"default"`)
	})
	if m, _ := session.ReadMeta(srv.opts.SessionRoot, id); m.Mode != "" {
		t.Fatalf("切回 default 后 meta.Mode 应为空,实际 %q", m.Mode)
	}

	// 非法 mode
	sendCall(t, conn, frame.KindSessionSetMode, map[string]string{"mode": "chaos"})
	wsCollect(t, conn, func(fs []frame.Frame) bool {
		r := lastCallResponse(fs, frame.KindSessionSetMode)
		return r != nil && strings.Contains(string(r.Data), "error")
	})
}

// TestSetModeAutoApprovesPendingAsk 执行中切 YOLO:pending 审批自动批准,
// 工具真实执行,轮次跑完。
func TestSetModeAutoApprovesPendingAsk(t *testing.T) {
	workdir := t.TempDir()
	stub := &stubProvider{results: []*provider.Result{
		toolUseResult("write_file", `{"path":"yolo.txt","content":"auto"}`),
		textResult("已写入"),
	}}
	_, ts := newTestServer(t, stub)
	id := createSession(t, ts, workdir)
	conn := dialWS(t, ts, id)

	sendFrame(t, conn, frame.TypeUserInput, map[string][]byte{"content": []byte("写文件")})
	wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasType(fs, frame.TypePermissionReq)
	})

	// 不答复审批,直接切 YOLO
	sendCall(t, conn, frame.KindSessionSetMode, map[string]string{"mode": "yolo"})
	frames := wsCollect(t, conn, func(fs []frame.Frame) bool { return hasType(fs, frame.TypeTaskEnded) })

	var approved bool
	for _, f := range frames {
		if f.Type == frame.TypePermissionResolved && strings.Contains(string(f.Data), "approved") {
			approved = true
		}
	}
	if !approved {
		t.Fatalf("切 YOLO 后 pending 审批应自动批准: %v", summary(frames))
	}
	data, err := os.ReadFile(filepath.Join(workdir, "yolo.txt"))
	if err != nil || string(data) != "auto" {
		t.Fatalf("自动批准后文件未写入: %v %q", err, data)
	}
}

// TestSetModePersistsAcrossReload 模式落盘后,重建 liveSession 的引擎按 meta 恢复,
// 且重连回放含 permission_mode_update 帧。
func TestSetModePersistsAcrossReload(t *testing.T) {
	srv, ts := newTestServer(t, &stubProvider{})
	id := createSession(t, ts, t.TempDir())
	conn := dialWS(t, ts, id)

	sendCall(t, conn, frame.KindSessionSetMode, map[string]string{"mode": "yolo"})
	wsCollect(t, conn, func(fs []frame.Frame) bool {
		return hasCallResponse(fs, frame.KindSessionSetMode)
	})
	conn.Close(websocket.StatusNormalClosure, "")

	// 驱逐内存中的 liveSession,强制下次按 meta 重建(模拟内核重启)
	srv.mu.Lock()
	delete(srv.live, id)
	srv.mu.Unlock()

	conn2 := dialWS(t, ts, id)
	frames := wsCollect(t, conn2, func(fs []frame.Frame) bool {
		return framesContain(fs, "permission_mode_update")
	})
	if !framesContain(frames, `"mode":"yolo"`) {
		t.Fatalf("回放缺少 yolo 模式帧: %v", summary(frames))
	}
	ls, err := srv.liveSession(id)
	if err != nil {
		t.Fatal(err)
	}
	if got := ls.pol.Mode(); string(got) != "yolo" {
		t.Fatalf("重建后引擎模式应为 yolo,实际 %s", got)
	}
}

// 零模型模式(宿主接管配置但用户未添加模型):服务照常起,
// /api/models 返回空数组,建会话 400 且文案可引导配置,/healthz 外显版本。
func TestZeroModelServe(t *testing.T) {
	srv, err := New(Options{
		Token:       "test-token",
		SessionRoot: t.TempDir(),
		Version:     "test-1.0",
		NewProvider: func(string) (provider.Provider, error) {
			return nil, fmt.Errorf("尚未配置模型,请先在设置中添加")
		},
		ListModels: func() []ModelInfo { return []ModelInfo{} },
	})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, data := apiReq(t, ts, "GET", "/api/models", "test-token", "")
	if resp.StatusCode != 200 || strings.TrimSpace(string(data)) != "[]" {
		t.Fatalf("零模型 /api/models 应返回 []: %d %s", resp.StatusCode, data)
	}

	resp, data = apiReq(t, ts, "POST", "/api/sessions", "test-token",
		fmt.Sprintf(`{"workdir":%q}`, t.TempDir()))
	if resp.StatusCode != 400 || !strings.Contains(string(data), "尚未配置模型") {
		t.Fatalf("零模型建会话应 400 并引导配置: %d %s", resp.StatusCode, data)
	}

	hresp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer hresp.Body.Close()
	hdata, _ := io.ReadAll(hresp.Body)
	if !strings.Contains(string(hdata), `"version":"test-1.0"`) {
		t.Fatalf("/healthz 应外显版本: %s", hdata)
	}
}

func framesContain(fs []frame.Frame, substr string) bool {
	for _, f := range fs {
		if strings.Contains(string(f.Data), substr) {
			return true
		}
	}
	return false
}

// TestReplayCompaction 压缩规则:同类文本连续段合并、思考与正文互为边界、
// 非文本帧透传、usage 只留末帧、bash output 进度帧丢弃。
func TestReplayCompaction(t *testing.T) {
	dir := t.TempDir()
	sess, err := session.New(dir, t.TempDir(), "m", "")
	if err != nil {
		t.Fatal(err)
	}
	b := &frame.Builder{}
	sess.Emit(b.TaskStarted())
	sess.Emit(b.AgentThought("想一"))
	sess.Emit(b.AgentThought("想二"))
	sess.Emit(b.AgentText("答一"))
	sess.Emit(b.AgentText("答二"))
	sess.Emit(b.Usage(1000, 100))
	sess.Emit(b.ToolCall(frame.ToolCallUpdate{ToolCallID: "t1", Title: "执行 ls", Status: "in_progress"}))
	sess.Emit(b.ToolCallUpdate(frame.ToolCallUpdate{ToolCallID: "t1", Status: "in_progress",
		Progress: tools.ProgressUpdate{Kind: "output", Line: "实时输出"}}))
	sess.Emit(b.ToolCallUpdate(frame.ToolCallUpdate{ToolCallID: "t1", Status: "completed"}))
	sess.Emit(b.AgentText("答三"))
	sess.Emit(b.Usage(1000, 200))
	sess.Emit(b.TaskEnded())
	sess.Close()

	lines, lastSeq, err := loadCompactedReplay(session.EventsPathFor(dir, sess.Meta.ID))
	if err != nil {
		t.Fatal(err)
	}
	if lastSeq == 0 {
		t.Fatal("水位 seq 缺失")
	}

	var kinds []string
	joined := ""
	for _, line := range lines {
		var f frame.Frame
		if err := json.Unmarshal(line, &f); err != nil {
			t.Fatalf("压缩产物非法 JSON: %v", err)
		}
		joined += string(f.Data)
		if f.Type != frame.TypeTaskRunning {
			kinds = append(kinds, string(f.Type))
			continue
		}
		var env struct {
			Update struct {
				SessionUpdate string `json:"sessionUpdate"`
				Content       struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"update"`
		}
		_ = json.Unmarshal(f.Data, &env)
		kinds = append(kinds, env.Update.SessionUpdate+":"+env.Update.Content.Text)
	}

	want := []string{
		"task-started",
		"agent_thought_chunk:想一想二",
		"agent_message_chunk:答一答二",
		"tool_call:",
		"tool_call_update:",
		"agent_message_chunk:答三",
		"usage_update:",
		"task-ended",
	}
	if len(kinds) != len(want) {
		t.Fatalf("帧序列不符:\n got=%v\nwant=%v", kinds, want)
	}
	for i := range want {
		if kinds[i] != want[i] {
			t.Fatalf("第 %d 帧不符: got=%q want=%q", i, kinds[i], want[i])
		}
	}
	if strings.Contains(joined, "实时输出") {
		t.Fatal("output 进度帧未被丢弃")
	}
	if !strings.Contains(joined, `"used":200`) || strings.Contains(joined, `"used":100`) {
		t.Fatal("usage 应只保留末帧")
	}
}

// ==================== 删除与归档 ====================

func TestDeleteSession(t *testing.T) {
	srv, ts := newTestServer(t, &stubProvider{})
	id := createSession(t, ts, t.TempDir())

	// 未知 id → 404
	resp, _ := apiReq(t, ts, "DELETE", "/api/sessions/no-such", "test-token", "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("未知会话应 404,得 %d", resp.StatusCode)
	}

	// 运行中 → 409(直接驱动内部状态,参照 TestPerSessionModelAndSwitch)
	ls, err := srv.liveSession(id)
	if err != nil {
		t.Fatal(err)
	}
	ls.mu.Lock()
	ls.running = true
	ls.mu.Unlock()
	resp, body := apiReq(t, ts, "DELETE", "/api/sessions/"+id, "test-token", "")
	if resp.StatusCode != http.StatusConflict || !strings.Contains(string(body), "正在执行") {
		t.Fatalf("运行中删除应 409: %d %s", resp.StatusCode, body)
	}
	ls.mu.Lock()
	ls.running = false
	ls.mu.Unlock()

	// 正常删除:live 回收 + 目录消失 + 列表消失
	resp, body = apiReq(t, ts, "DELETE", "/api/sessions/"+id, "test-token", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("删除失败: %d %s", resp.StatusCode, body)
	}
	if _, err := os.Stat(filepath.Join(srv.opts.SessionRoot, id)); !os.IsNotExist(err) {
		t.Fatalf("会话目录应已删除: %v", err)
	}
	srv.mu.Lock()
	_, stillLive := srv.live[id]
	srv.mu.Unlock()
	if stillLive {
		t.Fatal("live 表应已摘除")
	}
	resp, body = apiReq(t, ts, "GET", "/api/sessions", "test-token", "")
	if resp.StatusCode != http.StatusOK || strings.Contains(string(body), id) {
		t.Fatalf("列表不应再含该会话: %s", body)
	}
}

func TestDeleteSessionCascadesChildren(t *testing.T) {
	srv, ts := newTestServer(t, &stubProvider{})
	parent := createSession(t, ts, t.TempDir())

	// 手工构造子会话(子代理产物形态:Parent 指向父会话)
	child, err := session.New(srv.opts.SessionRoot, t.TempDir(), "stub", "子任务")
	if err != nil {
		t.Fatal(err)
	}
	child.Meta.Parent = parent
	if err := child.SaveMeta(); err != nil {
		t.Fatal(err)
	}
	child.Close()

	resp, body := apiReq(t, ts, "DELETE", "/api/sessions/"+parent, "test-token", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("删除失败: %d %s", resp.StatusCode, body)
	}
	if _, err := os.Stat(filepath.Join(srv.opts.SessionRoot, child.Meta.ID)); !os.IsNotExist(err) {
		t.Fatalf("子会话目录应级联删除: %v", err)
	}
}

func TestArchiveSession(t *testing.T) {
	stub := &stubProvider{results: []*provider.Result{textResult("好的")}}
	srv, ts := newTestServer(t, stub)

	// 非 live 路径:磁盘直写
	idle := createSession(t, ts, t.TempDir())
	resp, body := apiReq(t, ts, "PATCH", "/api/sessions/"+idle, "test-token", `{"archived":true}`)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), `"archived":true`) {
		t.Fatalf("归档失败: %d %s", resp.StatusCode, body)
	}
	resp, body = apiReq(t, ts, "GET", "/api/sessions", "test-token", "")
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), `"archived":true`) {
		t.Fatalf("列表应带归档标记: %s", body)
	}

	// 缺字段 → 400;未知 id → 404
	resp, _ = apiReq(t, ts, "PATCH", "/api/sessions/"+idle, "test-token", `{}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("缺 archived 字段应 400,得 %d", resp.StatusCode)
	}
	resp, _ = apiReq(t, ts, "PATCH", "/api/sessions/no-such", "test-token", `{"archived":true}`)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("未知会话应 404,得 %d", resp.StatusCode)
	}

	// live 路径:内存副本生效,轮次收尾的 SaveMeta 不覆写归档标记
	live := createSession(t, ts, t.TempDir())
	conn := dialWS(t, ts, live)
	resp, _ = apiReq(t, ts, "PATCH", "/api/sessions/"+live, "test-token", `{"archived":true}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("live 归档失败: %d", resp.StatusCode)
	}
	sendFrame(t, conn, frame.TypeUserInput, map[string][]byte{"content": []byte("hi")})
	wsCollect(t, conn, func(fs []frame.Frame) bool { return hasType(fs, frame.TypeTaskEnded) })
	meta, err := session.ReadMeta(srv.opts.SessionRoot, live)
	if err != nil || !meta.Archived {
		t.Fatalf("轮次收尾后归档标记应保留: %+v err=%v", meta, err)
	}
}
