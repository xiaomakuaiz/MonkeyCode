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
	"github.com/chaitin/MonkeyCode/agent/internal/subagent"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
	"github.com/chaitin/MonkeyCode/agent/internal/workspace"
)

// Options 服务配置。
type Options struct {
	Addr        string // 监听地址,必须是 loopback
	Token       string // 访问令牌,空则自动生成
	SessionRoot string // 会话存储根目录
	Model       string // 默认模型展示名(新会话缺省绑定它)
	// NewProvider 按模型名创建 LLM 客户端(空名 = 默认模型)。
	// 每会话创建/切换模型时调用;未知名应返回错误。
	NewProvider func(model string) (provider.Provider, error)
	// ListModels 可选模型清单(展示名 + 默认标记);nil 表示单模型。
	ListModels func() []ModelInfo
	// UI 内嵌调试页面(nil 则不挂载)。
	UI []byte
	// AskTimeout 权限审批等待上限(默认 10 分钟)。
	AskTimeout time.Duration
	// BuildExtras 按会话工作区装配系统提示增量(本地/平台技能与规则)
	// 及工具只读附加根;nil 表示无增量。
	BuildExtras func(workdir string) (*contextmgr.Extras, []string)
}

// Server localhost 宿主。
type Server struct {
	opts  Options
	mu    sync.Mutex
	live  map[string]*liveSession
	turns sync.WaitGroup // 进行中的轮次(优雅退出时等待落盘)

	// 子会话观察者:childID → (client → 回放水位 seq)。子代理帧落盘后经
	// publishChild 实时分发,seq 水位避免"回放 + 实时"缝隙处重帧。
	childMu    sync.Mutex
	childWatch map[string]map[*wsClient]uint64
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
	return &Server{
		opts:       opts,
		live:       map[string]*liveSession{},
		childWatch: map[string]map[*wsClient]uint64{},
	}, nil
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
	mux.HandleFunc("GET /api/models", s.auth(s.handleListModels))
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
	// 子代理的子会话默认隐藏(经 task 卡片的 childSessionId 定位),?all=1 显示
	if r.URL.Query().Get("all") == "" {
		filtered := metas[:0]
		for _, m := range metas {
			if m.Parent == "" {
				filtered = append(filtered, m)
			}
		}
		metas = filtered
	}
	if metas == nil {
		metas = []session.Meta{}
	}
	writeJSON(w, http.StatusOK, metas)
}

// ModelInfo 对外暴露的可选模型(名称即会话绑定的标识)。
type ModelInfo struct {
	Name    string `json:"name"`
	Default bool   `json:"default"`
}

func (s *Server) handleListModels(w http.ResponseWriter, r *http.Request) {
	var models []ModelInfo
	if s.opts.ListModels != nil {
		models = s.opts.ListModels()
	}
	if models == nil {
		models = []ModelInfo{{Name: s.opts.Model, Default: true}}
	}
	writeJSON(w, http.StatusOK, models)
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Workdir   string `json:"workdir"`
		Worktree  bool   `json:"worktree"`
		Model     string `json:"model"`      // 空 = 默认模型
		CreateDir bool   `json:"create_dir"` // 目录不存在时创建(新项目)
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求体无效"})
		return
	}
	// 模型名先行校验,避免建出无法解析 provider 的会话
	if _, err := s.opts.NewProvider(req.Model); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	workdir, err := filepath.Abs(req.Workdir)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if st, err := os.Stat(workdir); err != nil || !st.IsDir() {
		if !req.CreateDir {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "工作区目录不存在: " + workdir})
			return
		}
		if err := os.MkdirAll(workdir, 0o755); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "创建目录失败: " + err.Error()})
			return
		}
	}
	sess, err := session.New(s.opts.SessionRoot, workdir, s.modelNameOrDefault(req.Model), "")
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
	// 子代理的子会话走只读观察者路径:回放 + 实时跟看,不建引擎、不收上行
	if meta, err := session.ReadMeta(s.opts.SessionRoot, id); err == nil && meta.Parent != "" {
		s.handleChildWS(w, r, id)
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

// handleChildWS 子会话只读观察者:回放事件日志后订阅实时帧(publishChild),
// seq 水位衔接。上行帧一律忽略(子会话不可交互)。
func (s *Server) handleChildWS(w http.ResponseWriter, r *http.Request, id string) {
	conn, err := websocket.Accept(w, r, nil) // 默认同源 Origin 校验
	if err != nil {
		return
	}
	client := newWSClient(conn)

	// 回放与订阅原子化:持锁期间 publishChild 阻塞,水位保证无缝无重
	s.childMu.Lock()
	lastSeq, err := replayEventsWatermark(session.EventsPathFor(s.opts.SessionRoot, id), client)
	if err != nil {
		s.childMu.Unlock()
		client.close(websocket.StatusInternalError, "replay failed")
		return
	}
	if s.childWatch[id] == nil {
		s.childWatch[id] = map[*wsClient]uint64{}
	}
	s.childWatch[id][client] = lastSeq
	s.childMu.Unlock()

	defer func() {
		s.childMu.Lock()
		delete(s.childWatch[id], client)
		if len(s.childWatch[id]) == 0 {
			delete(s.childWatch, id)
		}
		s.childMu.Unlock()
		client.close(websocket.StatusNormalClosure, "")
	}()

	// 读循环仅用于感知断开;观察者上行帧忽略
	ctx := r.Context()
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			return
		}
	}
}

// publishChild 子会话帧实时分发给观察者(帧已由子会话 emitter 落盘)。
func (s *Server) publishChild(childID string, f frame.Frame) {
	s.childMu.Lock()
	defer s.childMu.Unlock()
	watchers := s.childWatch[childID]
	if len(watchers) == 0 {
		return
	}
	data, err := json.Marshal(f)
	if err != nil {
		return
	}
	for c, watermark := range watchers {
		if f.Seq > watermark {
			c.send(data)
		}
	}
}

// replayEventsWatermark 压缩回放并返回原始最大 seq(观察者衔接水位)。
func replayEventsWatermark(path string, c *wsClient) (uint64, error) {
	lines, lastSeq, err := loadCompactedReplay(path)
	if err != nil {
		return 0, err
	}
	for _, line := range lines {
		if err := c.sendBlocking(line); err != nil {
			return lastSeq, err
		}
	}
	return lastSeq, nil
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
	sub     *subagent.Tool // 切换模型时同步子代理的 provider

	emitMu  sync.Mutex // 保证回放与实时推送无缝衔接
	clients map[*wsClient]struct{}

	mu         sync.Mutex
	running    bool
	turnSeq    uint64 // 轮次代号:防旧轮次的延迟收尾清掉新轮次的 running
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
	// 按会话绑定的模型解析 provider;模型已下线时降级默认并回写 meta
	prov, err := s.opts.NewProvider(sess.Meta.Model)
	if err != nil {
		prov, err = s.opts.NewProvider("")
		if err != nil {
			return nil, fmt.Errorf("会话模型 %q 不可用: %w", sess.Meta.Model, err)
		}
		sess.Meta.Model = s.modelNameOrDefault("")
		_ = sess.SaveMeta()
	}
	applySessionHeaders(prov, sess.Meta.ID)

	// 只读探索子代理(task 工具):工具集只读故自动放行;
	// 子代理过程落盘为子会话,帧经 publishChild 分发给观察者
	sub := &subagent.Tool{
		Provider:     prov,
		SessionRoot:  s.opts.SessionRoot,
		ParentID:     sess.Meta.ID,
		OnChildFrame: s.publishChild,
	}
	ls.sub = sub
	reg.Register(sub)
	pol.AllowTool(sub.Name())

	var extras *contextmgr.Extras
	var readRoots []string
	if s.opts.BuildExtras != nil {
		extras, readRoots = s.opts.BuildExtras(sess.Meta.Workdir)
	}
	system := contextmgr.Build(sess.Meta.Workdir, extras)
	ls.engine = loop.New(prov, reg, pol, emitter, ls.builder,
		sess.Meta.Workdir, system, loop.Options{ReadRoots: readRoots})
	sub.OnUsage = func(u provider.Usage) { ls.engine.Usage.Add(u) }

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
	// task-ended 是轮次终态契约:客户端看到它即可发起轮次间操作(如切模型),
	// 所以 running 必须先于帧可见复位。task-error 可能非终态(压缩失败续跑),
	// 不在此复位,由 startTurn 的 defer 收尾。
	if f.Type == frame.TypeTaskEnded {
		ls.mu.Lock()
		ls.running = false
		ls.mu.Unlock()
	}
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

// setModel 切换会话模型:轮次间生效,执行中拒绝;成功后 provider 原地替换
// (消息历史为归一化格式,跨 provider 续聊安全),meta 落盘并广播 model_update 帧。
func (ls *liveSession) setModel(name string) (any, error) {
	if name == "" {
		return nil, fmt.Errorf("缺少 model")
	}
	// task-error 终态与 running 复位之间有极短窗口,轻等兜底;
	// 真正执行中的轮次等不到复位,仍拒绝
	deadline := time.Now().Add(time.Second)
	ls.mu.Lock()
	for ls.running {
		ls.mu.Unlock()
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("当前轮次执行中,结束后再切换模型")
		}
		time.Sleep(20 * time.Millisecond)
		ls.mu.Lock()
	}
	prov, err := ls.srv.opts.NewProvider(name)
	if err != nil {
		ls.mu.Unlock()
		return nil, err
	}
	applySessionHeaders(prov, ls.sess.Meta.ID)
	ls.engine.SetProvider(prov)
	if ls.sub != nil {
		ls.sub.Provider = prov
	}
	ls.sess.Meta.Model = name
	_ = ls.sess.SaveMeta()
	ls.mu.Unlock()

	ls.emit(ls.builder.ModelUpdate(name))
	return map[string]string{"model": name}, nil
}

// applySessionHeaders 注入网关缓存亲和标识:同一会话的请求带同一
// Session-Id/Thread-Id,网关可据此路由到同一实例并命中前缀缓存。
func applySessionHeaders(p provider.Provider, sessionID string) {
	if hs, ok := p.(provider.HeaderSetter); ok {
		hs.SetExtraHeaders(map[string]string{
			"Session-Id": sessionID,
			"Thread-Id":  sessionID,
		})
	}
}

// modelNameOrDefault 空名时返回默认模型展示名。
func (s *Server) modelNameOrDefault(name string) string {
	if name != "" {
		return name
	}
	if s.opts.ListModels != nil {
		for _, m := range s.opts.ListModels() {
			if m.Default {
				return m.Name
			}
		}
	}
	return s.opts.Model
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
	case frame.KindSessionSetModel:
		var p struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(f.Data, &p)
		result, callErr = ls.setModel(p.Model)
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
	ls.turnSeq++
	seq := ls.turnSeq
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
			// task-ended 经 emit 已提前复位 running;此处仅在仍是本轮时收尾,
			// 避免延迟的 defer 清掉紧接着启动的新轮次状态
			if ls.turnSeq == seq {
				ls.running = false
				ls.cancelTurn = nil
			}
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

// replayEvents 把历史事件压缩后发给新连接。
func replayEvents(path string, c *wsClient) error {
	lines, _, err := loadCompactedReplay(path)
	if err != nil {
		return err
	}
	for _, line := range lines {
		if err := c.sendBlocking(line); err != nil {
			return err
		}
	}
	return nil
}

// loadCompactedReplay 读取事件日志并做回放压缩,返回待发帧与原始最大 seq
// (观察者水位)。长会话的原始帧以流式文本增量为主(每个增量一帧),逐帧
// 回放会让客户端加载数千帧;合并后帧数下降 1~2 个数量级:
//   - 连续的 agent_message_chunk / agent_thought_chunk 合并为单帧(文本拼接)
//   - usage_update 只保留最后一帧(历史用量对回放无意义)
//   - bash 实时输出的进度帧(in_progress + progress.kind=output)丢弃
//
// 其余帧原样透传(权限/计划/工具/子代理进度等语义帧不动)。
func loadCompactedReplay(path string) ([][]byte, uint64, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, nil
		}
		return nil, 0, err
	}
	defer f.Close()

	type parsed struct {
		raw []byte
		fr  frame.Frame
		// acp 载荷的浅解析(仅压缩所需字段)
		update string
		text   string
	}
	var frames []parsed
	var lastSeq uint64
	lastUsage := -1

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		raw := []byte(line)
		p := parsed{raw: append([]byte(nil), raw...)}
		if json.Unmarshal(raw, &p.fr) != nil {
			frames = append(frames, p)
			continue
		}
		if p.fr.Seq > lastSeq {
			lastSeq = p.fr.Seq
		}
		if p.fr.Type == frame.TypeTaskRunning && p.fr.Kind == frame.KindACPEvent {
			var env struct {
				Update struct {
					SessionUpdate string `json:"sessionUpdate"`
					Content       struct {
						Text string `json:"text"`
					} `json:"content"`
					Status   string `json:"status"`
					Progress struct {
						Kind string `json:"kind"`
					} `json:"progress"`
				} `json:"update"`
			}
			if json.Unmarshal(p.fr.Data, &env) == nil {
				u := env.Update
				p.update = u.SessionUpdate
				p.text = u.Content.Text
				if u.SessionUpdate == "tool_call_update" && u.Status == "in_progress" && u.Progress.Kind == "output" {
					continue // 实时输出行对回放无意义
				}
				if u.SessionUpdate == "usage_update" {
					lastUsage = len(frames) // 记录位置,输出时只留最后一个
				}
			}
		}
		frames = append(frames, p)
	}
	if err := scanner.Err(); err != nil {
		return nil, 0, err
	}

	var out [][]byte
	// 合并缓冲:同类文本增量连续段
	runUpdate := ""
	var runText strings.Builder
	var runLast frame.Frame
	runCount := 0
	var runFirstRaw []byte
	flush := func() {
		if runCount == 0 {
			return
		}
		if runCount == 1 {
			out = append(out, runFirstRaw)
		} else {
			merged := runLast
			data, err := json.Marshal(map[string]any{
				"update": map[string]any{
					"sessionUpdate": runUpdate,
					"content":       map[string]any{"type": "text", "text": runText.String()},
				},
			})
			if err == nil {
				merged.Data = data
				if line, err := json.Marshal(merged); err == nil {
					out = append(out, line)
				}
			}
		}
		runUpdate, runCount = "", 0
		runText.Reset()
	}

	for i, p := range frames {
		isChunk := p.update == "agent_message_chunk" || p.update == "agent_thought_chunk"
		if isChunk {
			if runCount > 0 && p.update != runUpdate {
				flush()
			}
			if runCount == 0 {
				runUpdate = p.update
				runFirstRaw = p.raw
			}
			runText.WriteString(p.text)
			runLast = p.fr
			runCount++
			continue
		}
		flush()
		if p.update == "usage_update" && i != lastUsage {
			continue
		}
		out = append(out, p.raw)
	}
	flush()
	return out, lastSeq, nil
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
