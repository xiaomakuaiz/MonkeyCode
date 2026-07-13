// Package server localhost WS 宿主:桌面/浏览器 UI 通过帧协议直连内核。
//
// 安全模型:仅绑定 loopback + 每次启动的随机 token(REST 用 Bearer,WS 用
// ?token= 查询参数);WS 握手校验同源 Origin(coder/websocket 默认行为)防 CSRF。
//
// 协议:
//
//	REST  GET  /healthz                     健康检查(无鉴权)
//	REST  GET  /api/sessions                会话列表
//	REST  POST /api/sessions {workdir}      创建会话
//	WS    GET  /ws?session=<id>&token=<t>   帧双向流
//
// WS 下行:回放 events.jsonl 后实时推送全部帧(含 permission-req)。
// WS 上行:user-input(data.content 为 base64 文本)、user-cancel、
// permission-resp(data: {id, approved, remember})。
package server

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/chaitin/MonkeyCode/agent/internal/contextmgr"
	"github.com/chaitin/MonkeyCode/agent/internal/frame"
	"github.com/chaitin/MonkeyCode/agent/internal/loop"
	mcpclient "github.com/chaitin/MonkeyCode/agent/internal/mcp"
	"github.com/chaitin/MonkeyCode/agent/internal/policy"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/repo"
	"github.com/chaitin/MonkeyCode/agent/internal/session"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
	"github.com/chaitin/MonkeyCode/agent/internal/workspace"
)

// Options 服务配置。
type Options struct {
	Addr        string // 监听地址,必须是 loopback
	Token       string // 访问令牌,空则自动生成
	SessionRoot string // 会话存储根目录
	Model       string // 展示用模型标识
	// NewProvider 创建 LLM 客户端(注入以便测试)。
	NewProvider func() provider.Provider
	// UI 内嵌调试页面(nil 则不挂载)。
	UI []byte
	// AskTimeout 权限审批等待上限(默认 10 分钟)。
	AskTimeout time.Duration
}

// Server localhost 宿主。
type Server struct {
	opts  Options
	mu    sync.Mutex
	live  map[string]*liveSession
	turns sync.WaitGroup // 进行中的轮次(优雅退出时等待落盘)
}

// New 创建 Server;token 为空时自动生成。
func New(opts Options) (*Server, error) {
	if opts.Addr == "" {
		opts.Addr = "127.0.0.1:7439"
	}
	host, _, err := net.SplitHostPort(opts.Addr)
	if err != nil {
		return nil, fmt.Errorf("监听地址无效: %w", err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("serve 仅允许绑定 loopback 地址(当前: %s)", opts.Addr)
	}
	if opts.Token == "" {
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		opts.Token = hex.EncodeToString(b)
	}
	if opts.SessionRoot == "" {
		opts.SessionRoot = session.DefaultRoot()
	}
	if opts.AskTimeout <= 0 {
		opts.AskTimeout = 10 * time.Minute
	}
	if opts.NewProvider == nil {
		return nil, fmt.Errorf("NewProvider 未设置")
	}
	return &Server{opts: opts, live: map[string]*liveSession{}}, nil
}

// Token 实际生效的访问令牌。
func (s *Server) Token() string { return s.opts.Token }

// Addr 监听地址。
func (s *Server) Addr() string { return s.opts.Addr }

// Handler 组装 HTTP 路由。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "model": s.opts.Model})
	})
	mux.HandleFunc("GET /api/sessions", s.auth(s.handleListSessions))
	mux.HandleFunc("POST /api/sessions", s.auth(s.handleCreateSession))
	mux.HandleFunc("GET /ws", s.auth(s.handleWS))
	if s.opts.UI != nil {
		mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("content-type", "text/html; charset=utf-8")
			_, _ = w.Write(s.opts.UI)
		})
	}
	return mux
}

// ListenAndServe 启动服务(阻塞),ctx 取消时优雅关闭。
func (s *Server) ListenAndServe(ctx context.Context) error {
	srv := &http.Server{Addr: s.opts.Addr, Handler: s.Handler()}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	select {
	case <-ctx.Done():
		// 先取消进行中的轮次并等待其保存中断状态,再关 HTTP
		s.mu.Lock()
		for _, ls := range s.live {
			ls.mu.Lock()
			if ls.cancelTurn != nil {
				ls.cancelTurn()
			}
			ls.mu.Unlock()
		}
		s.mu.Unlock()
		waitTimeout(&s.turns, 3*time.Second)
		s.mu.Lock()
		for _, ls := range s.live {
			if ls.mcp != nil {
				ls.mcp.Close()
			}
			ls.engine.Close()
		}
		s.mu.Unlock()

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		return nil
	case err := <-errCh:
		return err
	}
}

func waitTimeout(wg *sync.WaitGroup, d time.Duration) {
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(d):
	}
}

// ==================== 鉴权 ====================

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" {
			token = r.URL.Query().Get("token")
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(s.opts.Token)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next(w, r)
	}
}

// ==================== REST ====================

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	metas, err := session.List(s.opts.SessionRoot)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if metas == nil {
		metas = []session.Meta{}
	}
	writeJSON(w, http.StatusOK, metas)
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Workdir  string `json:"workdir"`
		Worktree bool   `json:"worktree"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求体无效"})
		return
	}
	workdir, err := filepath.Abs(req.Workdir)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if st, err := os.Stat(workdir); err != nil || !st.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "工作区目录不存在: " + workdir})
		return
	}
	sess, err := session.New(s.opts.SessionRoot, workdir, s.opts.Model, "")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if req.Worktree {
		wt, err := workspace.Create(workdir, sess.Meta.ID)
		if err != nil {
			sess.Close()
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		sess.Meta.Worktree = wt
		sess.Meta.Workdir = wt.Path
		if err := sess.SaveMeta(); err != nil {
			sess.Close()
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	sess.Close() // liveSession 打开时重新持有
	writeJSON(w, http.StatusOK, sess.Meta)
}

// ==================== WS ====================

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("session")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少 session 参数"})
		return
	}
	ls, err := s.liveSession(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	conn, err := websocket.Accept(w, r, nil) // 默认同源 Origin 校验
	if err != nil {
		return
	}
	client := newWSClient(conn)
	if err := ls.attach(client); err != nil {
		client.close(websocket.StatusInternalError, "attach failed")
		return
	}
	defer ls.detach(client)

	// 读循环(写由 client 的发送协程负责)
	ctx := r.Context()
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var f frame.Frame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		ls.handleClientFrame(client, &f)
	}
}

// liveSession 获取(或惰性创建)运行态会话。
func (s *Server) liveSession(id string) (*liveSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ls, ok := s.live[id]; ok {
		return ls, nil
	}
	sess, err := session.Load(s.opts.SessionRoot, id)
	if err != nil {
		return nil, err
	}
	ls, err := newLiveSession(s, sess)
	if err != nil {
		sess.Close()
		return nil, err
	}
	s.live[id] = ls
	return ls, nil
}

// ==================== 运行态会话 ====================

type askResp struct {
	approved, remember, persist bool
}

type liveSession struct {
	srv     *Server
	sess    *session.Session
	engine  *loop.Engine
	builder *frame.Builder
	mcp     *mcpclient.Manager

	emitMu  sync.Mutex // 保证回放与实时推送无缝衔接
	clients map[*wsClient]struct{}

	mu         sync.Mutex
	running    bool
	cancelTurn context.CancelFunc
	asks       map[string]chan askResp
}

func newLiveSession(s *Server, sess *session.Session) (*liveSession, error) {
	ls := &liveSession{
		srv: s, sess: sess,
		clients: map[*wsClient]struct{}{},
		asks:    map[string]chan askResp{},
	}
	ls.builder = &frame.Builder{}
	ls.builder.SetSeq(countEvents(sess.EventsPath()))

	reg := tools.NewRegistry()
	pol := policy.New(policy.ModeDefault, ls.asker)
	pol.EnableProjectRules(sess.Meta.Workdir)
	emitter := frame.EmitterFunc(ls.emit)

	// MCP 工具接入:单点失败仅告警,不阻塞会话
	if mgr, err := mcpclient.Connect(context.Background(), sess.Meta.Workdir); err != nil {
		slog.Warn("MCP 配置加载失败", "error", err)
	} else {
		ls.mcp = mgr
		for _, ms := range mgr.Servers {
			if ms.Err != nil {
				slog.Warn("MCP server 不可用", "server", ms.Name, "error", ms.Err)
			}
		}
		for _, t := range mgr.AgentTools() {
			reg.Register(t)
			if rt, ok := t.(interface{ ReadOnly() bool }); ok && rt.ReadOnly() {
				pol.AllowTool(t.Name())
			}
		}
	}
	if t, ok := reg.Get("todo"); ok {
		t.(*tools.Todo).OnUpdate = func(entries []tools.TodoEntry) {
			fe := make([]frame.PlanEntry, len(entries))
			for i, e := range entries {
				fe[i] = frame.PlanEntry{Content: e.Content, Status: e.Status}
			}
			ls.emit(ls.builder.Plan(fe))
		}
	}
	system := contextmgr.Build(sess.Meta.Workdir)
	ls.engine = loop.New(s.opts.NewProvider(), reg, pol, emitter, ls.builder,
		sess.Meta.Workdir, system, loop.Options{})

	msgs, err := sess.LoadMessages()
	if err != nil {
		return nil, err
	}
	ls.engine.Messages = msgs
	ls.engine.Usage = sess.Meta.Usage

	// 上一进程遗留的未完轮次(如重启时正在执行/等待审批):
	// 该轮的执行流已不存在,补一帧终态让回放有明确结尾,避免客户端
	// 对着已死的审批请求等待。
	if sess.Meta.Status == "running" {
		sess.Meta.Status = "interrupted"
		_ = sess.SaveMeta()
		sess.Emit(ls.builder.TaskError("服务已重启,上一轮执行已中断;历史已保留,请重新发送指令继续"))
	}
	return ls, nil
}

// emit 帧落日志并广播(与 attach 回放互斥,保证不丢帧不重帧)。
func (ls *liveSession) emit(f frame.Frame) {
	ls.emitMu.Lock()
	defer ls.emitMu.Unlock()
	ls.sess.Emit(f)
	data, err := json.Marshal(f)
	if err != nil {
		return
	}
	for c := range ls.clients {
		c.send(data)
	}
}

// attach 回放历史事件后加入广播列表。
func (ls *liveSession) attach(c *wsClient) error {
	ls.emitMu.Lock()
	defer ls.emitMu.Unlock()
	if err := replayEvents(ls.sess.EventsPath(), c); err != nil {
		return err
	}
	ls.clients[c] = struct{}{}
	return nil
}

func (ls *liveSession) detach(c *wsClient) {
	ls.emitMu.Lock()
	delete(ls.clients, c)
	ls.emitMu.Unlock()
	c.close(websocket.StatusNormalClosure, "")
}

// handleClientFrame 处理上行帧;c 为来源连接(用于回发仅与该客户端相关的错误)。
func (ls *liveSession) handleClientFrame(c *wsClient, f *frame.Frame) {
	switch f.Type {
	case frame.TypeCall:
		ls.handleCall(c, f)
	case frame.TypeUserInput:
		var payload struct {
			Content []byte `json:"content"` // base64 → 原文
		}
		if err := json.Unmarshal(f.Data, &payload); err != nil || len(payload.Content) == 0 {
			return
		}
		ls.startTurn(string(payload.Content))
	case frame.TypeUserCancel:
		ls.mu.Lock()
		if ls.cancelTurn != nil {
			ls.cancelTurn()
		}
		ls.mu.Unlock()
	case frame.TypePermissionResp:
		var payload struct {
			ID       string `json:"id"`
			Approved bool   `json:"approved"`
			Remember bool   `json:"remember"`
			Persist  bool   `json:"persist"`
		}
		if err := json.Unmarshal(f.Data, &payload); err != nil {
			return
		}
		ls.mu.Lock()
		ch, ok := ls.asks[payload.ID]
		if ok {
			delete(ls.asks, payload.ID)
		}
		ls.mu.Unlock()
		if ok {
			ch <- askResp{approved: payload.Approved, remember: payload.Remember, persist: payload.Persist}
		} else {
			// 审批已失效(超时/重启遗留/重复点击):明确告知该客户端,不落会话日志
			slog.Warn("收到失效的审批响应", "ask_id", payload.ID, "session", ls.sess.Meta.ID)
			data, _ := json.Marshal(map[string]string{"error": "该审批请求已失效(可能已超时或服务已重启),请重新发送指令"})
			raw, _ := json.Marshal(frame.Frame{Type: frame.TypeTaskError, Data: data, Timestamp: time.Now().UnixMilli()})
			c.send(raw)
		}
	}
}

// handleCall 处理只读同步查询,结果仅回发给发起连接(不落日志、不广播)。
func (ls *liveSession) handleCall(c *wsClient, f *frame.Frame) {
	browser := repo.New(ls.sess.Meta.Workdir)
	var result any
	var callErr error

	switch f.Kind {
	case frame.KindRepoFileList:
		var p struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(f.Data, &p)
		result, callErr = browser.ListFiles(p.Path)
	case frame.KindRepoReadFile:
		var p struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(f.Data, &p)
		var content string
		content, callErr = browser.ReadFile(p.Path)
		result = map[string]string{"path": p.Path, "content": content}
	case frame.KindRepoFileChanges:
		result, callErr = browser.FileChanges()
	case frame.KindRepoFileDiff:
		var p struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(f.Data, &p)
		var diff string
		diff, callErr = browser.FileDiff(p.Path)
		result = map[string]string{"path": p.Path, "diff": diff}
	default:
		callErr = fmt.Errorf("未知 call kind: %s", f.Kind)
	}

	payload := map[string]any{}
	if callErr != nil {
		payload["error"] = callErr.Error()
	} else {
		payload["result"] = result
	}
	data, _ := json.Marshal(payload)
	raw, _ := json.Marshal(frame.Frame{
		Type: frame.TypeCallResponse, Kind: f.Kind,
		Data: data, Timestamp: time.Now().UnixMilli(),
	})
	c.send(raw)
}

// startTurn 启动一轮(同会话同一时刻只允许一轮)。
func (ls *liveSession) startTurn(input string) {
	ls.mu.Lock()
	if ls.running {
		ls.mu.Unlock()
		ls.emit(ls.builder.TaskError("当前会话已有任务在执行,请等待完成或先取消"))
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	ls.running = true
	ls.cancelTurn = cancel
	ls.mu.Unlock()

	// 轮次开始即落 running:进程异常退出时留下可识别的遗留状态
	ls.sess.Meta.Status = "running"
	_ = ls.sess.SaveMeta()

	ls.srv.turns.Add(1)
	go func() {
		defer func() {
			cancel()
			ls.mu.Lock()
			ls.running = false
			ls.cancelTurn = nil
			ls.mu.Unlock()
			ls.srv.turns.Done()
		}()
		_, err := ls.engine.RunTurn(ctx, input)

		ls.sess.Meta.Turns++
		ls.sess.Meta.Usage = ls.engine.Usage
		switch {
		case errors.Is(err, loop.ErrInterrupted):
			ls.sess.Meta.Status = "interrupted"
		case err != nil:
			ls.sess.Meta.Status = "error"
		default:
			ls.sess.Meta.Status = "finished"
		}
		if ls.sess.Meta.Title == "" {
			ls.sess.Meta.Title = firstLine(input)
		}
		if err := ls.sess.SaveMessages(ls.engine.Messages); err != nil {
			ls.emit(ls.builder.TaskError("会话保存失败: " + err.Error()))
		}
		_ = ls.sess.SaveMeta()
	}()
}

// asker 权限审批:下发 permission-req 帧,等待 permission-resp。
func (ls *liveSession) asker(ctx context.Context, req policy.Request) (policy.Response, error) {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	ch := make(chan askResp, 1)

	ls.mu.Lock()
	ls.asks[id] = ch
	ls.mu.Unlock()
	defer func() {
		ls.mu.Lock()
		delete(ls.asks, id)
		ls.mu.Unlock()
	}()

	ls.emit(ls.builder.PermissionReq(id, req.Tool, req.Title))
	select {
	case r := <-ch:
		outcome := "denied"
		if r.approved {
			outcome = "approved"
		}
		ls.emit(ls.builder.PermissionResolved(id, outcome))
		return policy.Response{Approved: r.approved, Remember: r.remember, Persist: r.persist}, nil
	case <-ctx.Done():
		ls.emit(ls.builder.PermissionResolved(id, "cancelled"))
		return policy.Response{}, ctx.Err()
	case <-time.After(ls.srv.opts.AskTimeout):
		ls.emit(ls.builder.PermissionResolved(id, "timeout"))
		return policy.Response{}, fmt.Errorf("等待审批超时(%s),已按拒绝处理", ls.srv.opts.AskTimeout)
	}
}

// ==================== WS 客户端(串行发送) ====================

type wsClient struct {
	conn *websocket.Conn
	out  chan []byte
	once sync.Once
	done chan struct{}
}

func newWSClient(conn *websocket.Conn) *wsClient {
	// 缓冲需容纳流式输出的突发帧;满仍未消费则按慢消费者断开(见 send)
	c := &wsClient{conn: conn, out: make(chan []byte, 8192), done: make(chan struct{})}
	go func() {
		for {
			select {
			case data := <-c.out:
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				err := conn.Write(ctx, websocket.MessageText, data)
				cancel()
				if err != nil {
					c.close(websocket.StatusAbnormalClosure, "write failed")
					return
				}
			case <-c.done:
				return
			}
		}
	}()
	return c
}

// send 非阻塞投递(实时广播用);慢消费者(缓冲满)直接断开,由客户端重连回放。
func (c *wsClient) send(data []byte) {
	select {
	case c.out <- data:
	case <-c.done:
	default:
		slog.Warn("WS 客户端消费过慢,已断开(客户端会自动重连回放)")
		c.close(websocket.StatusPolicyViolation, "client too slow")
	}
}

// sendBlocking 阻塞投递(历史回放用):回放帧数可远超缓冲大小,不能按慢消费者处理。
func (c *wsClient) sendBlocking(data []byte) error {
	select {
	case c.out <- data:
		return nil
	case <-c.done:
		return fmt.Errorf("连接已关闭")
	case <-time.After(30 * time.Second):
		c.close(websocket.StatusPolicyViolation, "replay write timeout")
		return fmt.Errorf("回放写超时")
	}
}

func (c *wsClient) close(code websocket.StatusCode, reason string) {
	c.once.Do(func() {
		close(c.done)
		_ = c.conn.Close(code, reason)
	})
}

// ==================== 辅助 ====================

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// replayEvents 把历史事件逐行发给新连接。
func replayEvents(path string, c *wsClient) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if err := c.sendBlocking([]byte(line)); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func countEvents(path string) uint64 {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	var n uint64
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) != "" {
			n++
		}
	}
	return n
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	r := []rune(s)
	if len(r) > 60 {
		s = string(r[:60]) + "..."
	}
	return s
}
