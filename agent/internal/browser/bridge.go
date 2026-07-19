package browser

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	// helloTimeout 连接后首帧(hello)必须在此时限内到达。
	helloTimeout = 3 * time.Second
	// pingInterval 内核→扩展保活间隔(兼作 MV3 SW 续命)。
	pingInterval = 20 * time.Second
	// portScanRange 默认端口被占时向上顺延尝试的范围。
	portScanRange = 10
)

// ExtBridge 扩展桥:独立 loopback listener,管理与浏览器扩展的唯一 WS 连接、
// 配对与鉴权。进程级单例,serve 启动时创建。
type ExtBridge struct {
	prefAddr string // 配置的首选地址(如 127.0.0.1:7440)
	fixed    bool   // 用户显式指定地址:不做端口顺延
	authPath string // ext-auth.json 路径

	reqID atomic.Int64

	mu          sync.Mutex
	token       string // 长期 ext token(已配对时非空)
	extID       string // 配对时记录的扩展 ID
	pairingCode string // 一次性配对码(本次启动有效,配对成功后作废)
	listenAddr  string // 实际监听地址(启动成功后非空)
	listenErr   string // 监听失败原因(状态页外显)
	conn        *extConn
	browser     BrowserInfo

	// 多会话并行:tab 归属会话,事件按 tabId 路由到属主;
	// 用户交付(handoff)的标签页进待领队列,会话按需认领
	sessions        map[string]func(Message) // 会话 ID → 事件回调
	tabOwner        map[int]string           // tabId → 会话 ID
	pendingHandoffs []*TabInfo
}

// extAuth ext-auth.json 落盘结构。
type extAuth struct {
	Token string `json:"token"`
	ExtID string `json:"ext_id,omitempty"`
}

// NewExtBridge 创建扩展桥。dataDir 为数据目录(存 ext-auth.json);
// addr 为首选监听地址,fixed 表示用户显式指定(端口被占时不顺延)。
func NewExtBridge(addr string, fixed bool, dataDir string) (*ExtBridge, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("扩展桥地址无效: %w", err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("扩展桥仅允许绑定 loopback 地址(当前: %s)", addr)
	}
	b := &ExtBridge{
		prefAddr: addr,
		fixed:    fixed,
		authPath: filepath.Join(dataDir, "ext-auth.json"),
		sessions: map[string]func(Message){},
		tabOwner: map[int]string{},
	}
	if data, err := os.ReadFile(b.authPath); err == nil {
		var a extAuth
		if json.Unmarshal(data, &a) == nil && a.Token != "" {
			b.token = a.Token
			b.extID = a.ExtID
		}
	}
	b.pairingCode = newPairingCode()
	return b, nil
}

// newPairingCode 生成 8 位配对码(剔除易混字符的 base32 字母表)。
func newPairingCode() string {
	const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
	raw := make([]byte, 8)
	_, _ = rand.Read(raw)
	out := make([]byte, 8)
	for i, c := range raw {
		out[i] = alphabet[int(c)%len(alphabet)]
	}
	return string(out)
}

// normalizeCode 配对码归一:去连字符/空格,大写。
func normalizeCode(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '-' || c == ' ' {
			continue
		}
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		out = append(out, c)
	}
	return string(out)
}

// ListenAndServe 启动扩展桥监听(阻塞至 ctx 取消)。端口被占时:
// 默认地址向上顺延 portScanRange 个端口;显式指定地址则失败记录原因。
// 监听失败不返回错误(浏览器能力降级不可用,不拖垮 serve 主体)。
func (b *ExtBridge) ListenAndServe(ctx context.Context) {
	ln, addr, err := b.listen()
	if err != nil {
		b.mu.Lock()
		b.listenErr = err.Error()
		b.mu.Unlock()
		return
	}
	b.mu.Lock()
	b.listenAddr = addr
	b.mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ext", b.handleExt)
	srv := &http.Server{Handler: mux}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		b.dropConn(nil)
	}()
	_ = srv.Serve(ln)
}

func (b *ExtBridge) listen() (net.Listener, string, error) {
	host, portStr, err := net.SplitHostPort(b.prefAddr)
	if err != nil {
		return nil, "", err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return nil, "", fmt.Errorf("扩展桥端口无效: %q", portStr)
	}
	tries := 1
	if !b.fixed {
		tries = portScanRange
	}
	var lastErr error
	for i := 0; i < tries; i++ {
		addr := net.JoinHostPort(host, strconv.Itoa(port+i))
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			// 实际地址(端口 0 时由系统分配)
			return ln, ln.Addr().String(), nil
		}
		lastErr = err
	}
	return nil, "", fmt.Errorf("扩展桥监听失败(端口 %d 起 %d 个均被占用): %w", port, tries, lastErr)
}

// handleExt 扩展 WS 接入:hello 鉴权(长期 token 或一次性配对码),
// 通过后新连接替换旧连接(处理浏览器重启后的僵尸连接)。
func (b *ExtBridge) handleExt(w http.ResponseWriter, r *http.Request) {
	// 跳过同源 Origin 校验:扩展 SW 的 Origin 是 chrome-extension://<id>,
	// 必然非同源。信任根是 token/配对码(+ authorize 里的扩展 ID 绑定),
	// Origin 对本机进程本就可伪造,不作为安全边界。
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(64 * 1024 * 1024) // 整页截图 base64 可达数十 MB

	helloCtx, cancel := context.WithTimeout(context.Background(), helloTimeout)
	_, data, err := ws.Read(helloCtx)
	cancel()
	if err != nil {
		ws.Close(websocket.StatusPolicyViolation, "hello timeout")
		return
	}
	var hello Message
	if json.Unmarshal(data, &hello) != nil || hello.Event != EventHello || hello.Auth == nil {
		ws.Close(websocket.StatusPolicyViolation, "bad hello")
		return
	}

	issued, err := b.authorize(&hello)
	if err != nil {
		ws.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}

	c := &extConn{ws: ws, pending: map[int64]chan Message{}, closed: make(chan struct{})}
	ok := helloOK{Event: EventHelloOK, Token: issued, Proto: ProtoVersion}
	if err := c.write(context.Background(), ok); err != nil {
		ws.Close(websocket.StatusInternalError, "")
		return
	}

	b.mu.Lock()
	old := b.conn
	b.conn = c
	if hello.Browser != nil {
		b.browser = *hello.Browser
	}
	b.mu.Unlock()
	if old != nil {
		old.close()
	}

	go b.pingLoop(c)
	b.readLoop(c) // 在 handler 协程内阻塞,连接断开即返回
}

// authorize 校验 hello 鉴权。配对码路径成功时颁发并落盘长期 token,
// 返回新 token(扩展需存储);token 路径返回空串。
func (b *ExtBridge) authorize(hello *Message) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	extID := ""
	if hello.Ext != nil {
		extID = hello.Ext.ID
	}
	if hello.Auth.Token != "" && b.token != "" {
		if subtle.ConstantTimeCompare([]byte(hello.Auth.Token), []byte(b.token)) != 1 {
			return "", errors.New("unauthorized")
		}
		// 配对时记录过扩展 ID 则要求一致(纵深防御)
		if b.extID != "" && extID != "" && extID != b.extID {
			return "", errors.New("extension mismatch")
		}
		// 扩展以 token 连入 = 已确认持久化配对凭据,配对码此刻才作废。
		// (若在颁发 token 时就作废:连接在扩展落库前夭折会吞掉配对码,
		// 扩展带着旧码重试永远失败,用户只能重新配对)
		b.pairingCode = ""
		return "", nil
	}
	if hello.Auth.Code != "" && b.pairingCode != "" &&
		subtle.ConstantTimeCompare([]byte(normalizeCode(hello.Auth.Code)), []byte(b.pairingCode)) == 1 {
		raw := make([]byte, 16)
		if _, err := rand.Read(raw); err != nil {
			return "", errors.New("internal error")
		}
		token := hex.EncodeToString(raw)
		data, _ := json.Marshal(extAuth{Token: token, ExtID: extID})
		if err := os.MkdirAll(filepath.Dir(b.authPath), 0o700); err != nil {
			return "", errors.New("persist failed")
		}
		if err := os.WriteFile(b.authPath, data, 0o600); err != nil {
			return "", errors.New("persist failed")
		}
		b.token = token
		b.extID = extID
		return token, nil
	}
	return "", errors.New("unauthorized")
}

// readLoop 读扩展入站帧:应答派发给等待者,事件转给活跃会话。
func (b *ExtBridge) readLoop(c *extConn) {
	defer b.dropConn(c)
	for {
		_, data, err := c.ws.Read(context.Background())
		if err != nil {
			debugf("readLoop 结束: %v", err)
			return
		}
		debugf("← %s", truncateBytes(data, 200))
		var msg Message
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		if msg.ID > 0 {
			c.resolve(msg)
			continue
		}
		b.handleEvent(msg)
	}
}

// handleEvent 扩展事件分发:带 tabId 的事件路由到属主会话;handoff 进
// 待领队列(会话在下一次工具调用时认领);无属主的事件丢弃。
func (b *ExtBridge) handleEvent(msg Message) {
	switch msg.Event {
	case EventPong, "":
		return
	case EventHandoff:
		if msg.Info != nil {
			b.mu.Lock()
			b.pendingHandoffs = append(b.pendingHandoffs, msg.Info)
			b.mu.Unlock()
		}
	default:
		b.mu.Lock()
		var handler func(Message)
		if owner, ok := b.tabOwner[msg.TabID]; ok {
			handler = b.sessions[owner]
		}
		b.mu.Unlock()
		if handler != nil {
			handler(msg)
		}
	}
}

// pingLoop 周期 ping:活跃的 WS 收发让扩展 SW 免于被浏览器回收。
func (b *ExtBridge) pingLoop(c *extConn) {
	t := time.NewTicker(pingInterval)
	defer t.Stop()
	for {
		select {
		case <-c.closed:
			return
		case <-t.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err := c.write(ctx, Request{Op: OpPing})
			cancel()
			if err != nil {
				b.dropConn(c)
				return
			}
		}
	}
}

// dropConn 关闭并清理连接(c 为 nil 时清理当前连接)。
func (b *ExtBridge) dropConn(c *extConn) {
	b.mu.Lock()
	if c == nil {
		c = b.conn
	}
	if b.conn == c {
		b.conn = nil
	}
	b.mu.Unlock()
	if c != nil {
		c.close()
	}
}

// call 发送请求并等待应答(超时/断连即错)。
func (b *ExtBridge) call(ctx context.Context, req Request) (json.RawMessage, error) {
	b.mu.Lock()
	c := b.conn
	b.mu.Unlock()
	if c == nil {
		return nil, errors.New("浏览器扩展未连接;请确认已在浏览器中安装 MonkeyCode 扩展并完成配对(设置页可查看状态)")
	}
	req.ID = b.reqID.Add(1)
	ch := c.register(req.ID)
	defer c.unregister(req.ID)
	if err := c.write(ctx, req); err != nil {
		return nil, fmt.Errorf("发送浏览器指令失败: %w", err)
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.closed:
		return nil, errors.New("浏览器扩展连接已断开,请稍后重试")
	case msg := <-ch:
		if msg.Error != nil {
			return nil, msg.Error
		}
		return msg.Result, nil
	}
}

// RegisterSession 注册会话事件回调(幂等覆盖)。
func (b *ExtBridge) RegisterSession(id string, fn func(Message)) {
	b.mu.Lock()
	b.sessions[id] = fn
	b.mu.Unlock()
}

// UnregisterSession 注销会话并释放其全部标签页归属。
func (b *ExtBridge) UnregisterSession(id string) {
	b.mu.Lock()
	delete(b.sessions, id)
	for tab, owner := range b.tabOwner {
		if owner == id {
			delete(b.tabOwner, tab)
		}
	}
	b.mu.Unlock()
}

// ClaimTab 声明标签页归属(新建/认领交付时调用;后声明者覆盖)。
func (b *ExtBridge) ClaimTab(tabID int, sessionID string) {
	b.mu.Lock()
	b.tabOwner[tabID] = sessionID
	b.mu.Unlock()
}

// ReleaseTab 释放标签页归属(关闭/用户收回时调用)。
func (b *ExtBridge) ReleaseTab(tabID int) {
	b.mu.Lock()
	delete(b.tabOwner, tabID)
	b.mu.Unlock()
}

// TakePendingHandoff 认领一个用户交付的标签页(队首;无则 nil)。
func (b *ExtBridge) TakePendingHandoff() *TabInfo {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.pendingHandoffs) == 0 {
		return nil
	}
	t := b.pendingHandoffs[0]
	b.pendingHandoffs = b.pendingHandoffs[1:]
	return t
}

// Status 桥接状态(设置页 /api/browser/status 外显)。
type Status struct {
	Enabled     bool   `json:"enabled"`         // 监听是否就绪
	Addr        string `json:"addr,omitempty"`  // 实际监听地址
	Error       string `json:"error,omitempty"` // 监听失败原因
	Paired      bool   `json:"paired"`          // 已有长期 token
	Connected   bool   `json:"connected"`       // 扩展当前在线
	BrowserName string `json:"browser_name,omitempty"`
	BrowserVer  string `json:"browser_version,omitempty"`
	PairingCode string `json:"pairing_code,omitempty"` // 未配对时展示
}

// Status 当前桥接状态快照。
func (b *ExtBridge) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := Status{
		Enabled:   b.listenAddr != "",
		Addr:      b.listenAddr,
		Error:     b.listenErr,
		Paired:    b.token != "",
		Connected: b.conn != nil,
	}
	if s.Connected {
		s.BrowserName = b.browser.Name
		s.BrowserVer = b.browser.Version
	}
	if !s.Paired {
		s.PairingCode = b.pairingCode
	}
	return s
}

// Repair 重置配对:删除长期 token 与落盘凭据,断开现有连接,生成新配对码。
func (b *ExtBridge) Repair() Status {
	b.mu.Lock()
	b.token = ""
	b.extID = ""
	b.pairingCode = newPairingCode()
	c := b.conn
	b.conn = nil
	_ = os.Remove(b.authPath)
	b.mu.Unlock()
	if c != nil {
		c.close()
	}
	return b.Status()
}

// ==================== 连接 ====================

// extConn 一条扩展 WS 连接:写互斥 + 在途请求表。
type extConn struct {
	ws      *websocket.Conn
	writeMu sync.Mutex

	pmu     sync.Mutex
	pending map[int64]chan Message

	closeOnce sync.Once
	closed    chan struct{}
}

func (c *extConn) write(ctx context.Context, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	debugf("→ %s", truncateBytes(data, 200))
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.ws.Write(ctx, websocket.MessageText, data)
}

// debugf 桥接线路日志(MC_BRIDGE_DEBUG=1 时输出,排查扩展联调问题用)。
func debugf(format string, args ...any) {
	if os.Getenv("MC_BRIDGE_DEBUG") == "" {
		return
	}
	fmt.Fprintf(os.Stderr, "[bridge %s] "+format+"\n",
		append([]any{time.Now().Format("15:04:05.000")}, args...)...)
}

func truncateBytes(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}

func (c *extConn) register(id int64) chan Message {
	ch := make(chan Message, 1)
	c.pmu.Lock()
	c.pending[id] = ch
	c.pmu.Unlock()
	return ch
}

func (c *extConn) unregister(id int64) {
	c.pmu.Lock()
	delete(c.pending, id)
	c.pmu.Unlock()
}

func (c *extConn) resolve(msg Message) {
	c.pmu.Lock()
	ch := c.pending[msg.ID]
	c.pmu.Unlock()
	if ch != nil {
		ch <- msg
	}
}

// close 关闭连接:唤醒全部在途等待者(经 closed 通道)。
func (c *extConn) close() {
	c.closeOnce.Do(func() {
		close(c.closed)
		_ = c.ws.Close(websocket.StatusNormalClosure, "")
	})
}
