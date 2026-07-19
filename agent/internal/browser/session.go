package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Session 每个 agent 会话一份的浏览器操作现场:当前标签页、ref 表、
// 事件旁白(对话框/标签页变动)。工具实例共享同一 Session。
type Session struct {
	bridge *ExtBridge
	owner  string // 租约持有者标识(agent 会话 ID)

	mu     sync.Mutex
	tabID  int          // 当前操作的标签页(0=无)
	tabs   map[int]bool // 本会话控制过的标签页
	refs   refTable
	notes  []string // 事件旁白,附注到下一个工具结果
	closed bool
}

// NewSession 创建浏览器会话现场(不建立任何连接,首次工具调用时惰性激活)。
func NewSession(b *ExtBridge, owner string) *Session {
	return &Session{bridge: b, owner: owner, tabs: map[int]bool{}}
}

// Close 释放会话:剥离本会话标签页的 debugger(标签页保留,用户可能还要看),
// 解除事件回调与租约。幂等,经 Registry.Close 链自动调用。
func (s *Session) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	tabs := make([]int, 0, len(s.tabs))
	for id := range s.tabs {
		tabs = append(tabs, id)
	}
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for _, id := range tabs {
		_ = s.bridge.Detach(ctx, id)
	}
	s.bridge.SetEventHandler(nil)
	s.bridge.Release(s.owner)
}

// ensure 激活会话:取得浏览器使用权、注册事件回调、认领用户交付的标签页。
func (s *Session) ensure(_ context.Context) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return fmt.Errorf("浏览器会话已关闭")
	}
	s.mu.Unlock()
	if err := s.bridge.Acquire(s.owner); err != nil {
		return err
	}
	s.bridge.SetEventHandler(s.handleEvent)
	if tab := s.bridge.TakePendingHandoff(); tab != nil {
		s.adoptTab(tab)
	}
	return nil
}

// adoptTab 认领标签页(用户交付/新建)。
func (s *Session) adoptTab(t *TabInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tabs[t.TabID] = true
	if s.tabID == 0 {
		s.tabID = t.TabID
		s.refs.invalidate()
	}
	s.addNoteLocked(fmt.Sprintf("用户交付了标签页 #%d(%s)", t.TabID, firstNonEmpty(t.Title, t.URL)))
}

// ensureTab 激活会话并确保当前标签页可操作(attach 幂等自愈 + Page.enable)。
func (s *Session) ensureTab(ctx context.Context) (int, error) {
	if err := s.ensure(ctx); err != nil {
		return 0, err
	}
	s.mu.Lock()
	tab := s.tabID
	s.mu.Unlock()
	if tab == 0 {
		return 0, fmt.Errorf("当前没有活动标签页;可用 browser_navigate 打开页面,或 browser_tabs 新建/选择标签页,或引导用户经扩展交付标签页")
	}
	if err := s.bridge.Attach(ctx, tab); err != nil {
		return 0, err
	}
	// Page 事件(对话框/导航)只 enable 这一个 domain,事件量可控
	_ = s.bridge.CDP(ctx, tab, "Page.enable", nil, nil)
	return tab, nil
}

// handleEvent 扩展事件回调(与工具调用并发,注意锁)。
func (s *Session) handleEvent(msg Message) {
	switch msg.Event {
	case EventCDP:
		s.handleCDPEvent(msg)
	case EventHandoff:
		if msg.Info != nil {
			s.adoptTab(msg.Info)
		}
	case EventTabRemoved:
		s.mu.Lock()
		if s.tabs[msg.TabID] {
			delete(s.tabs, msg.TabID)
			s.addNoteLocked(fmt.Sprintf("标签页 #%d 已被关闭", msg.TabID))
			if s.tabID == msg.TabID {
				s.tabID = 0
				s.refs.invalidate()
			}
		}
		s.mu.Unlock()
	case EventDetached:
		s.mu.Lock()
		if s.tabs[msg.TabID] {
			switch msg.Reason {
			case "canceled_by_user", "released_by_user":
				// 用户主动收回控制权:尊重之,移出会话
				delete(s.tabs, msg.TabID)
				s.addNoteLocked(fmt.Sprintf("用户收回了标签页 #%d 的控制权", msg.TabID))
				if s.tabID == msg.TabID {
					s.tabID = 0
					s.refs.invalidate()
				}
			default:
				// 其他原因(如页面崩溃):保留成员资格,下次操作 attach 自愈
				s.addNoteLocked(fmt.Sprintf("标签页 #%d 的调试连接断开(%s),将自动重连", msg.TabID, msg.Reason))
			}
		}
		s.mu.Unlock()
	}
}

// handleCDPEvent 透传的 CDP 事件:主 frame 导航失效 ref 表;JS 对话框自动
// 处理(alert 确认、confirm/prompt 取消、beforeunload 放行),避免页面阻塞。
func (s *Session) handleCDPEvent(msg Message) {
	switch msg.Method {
	case "Page.frameNavigated":
		var p struct {
			Frame struct {
				ParentID string `json:"parentId"`
				URL      string `json:"url"`
			} `json:"frame"`
		}
		if json.Unmarshal(msg.Params, &p) != nil || p.Frame.ParentID != "" {
			return
		}
		s.mu.Lock()
		if s.tabID == msg.TabID {
			s.refs.invalidate()
		}
		s.mu.Unlock()
	case "Page.javascriptDialogOpening":
		var p struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(msg.Params, &p)
		accept := p.Type == "alert" || p.Type == "beforeunload"
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = s.bridge.CDP(ctx, msg.TabID, "Page.handleJavaScriptDialog",
				map[string]any{"accept": accept}, nil)
		}()
		action := "已自动确认"
		if !accept {
			action = "已自动取消"
		}
		s.mu.Lock()
		s.addNoteLocked(fmt.Sprintf("页面弹出 %s 对话框(%s): %q", p.Type, action, truncate(p.Message, 200)))
		s.mu.Unlock()
	}
}

// addNoteLocked 追加事件旁白(须持有 s.mu)。
func (s *Session) addNoteLocked(note string) {
	if len(s.notes) < 20 {
		s.notes = append(s.notes, note)
	}
}

// takeNotes 取出并清空事件旁白(拼进工具结果)。
func (s *Session) takeNotes() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.notes) == 0 {
		return ""
	}
	out := "\n[浏览器事件] " + strings.Join(s.notes, ";")
	s.notes = nil
	return out
}

// ==================== CDP 交互原语 ====================

// remoteObject Runtime 域返回的远端对象(仅取所需字段)。
type remoteObject struct {
	Type     string          `json:"type"`
	Value    json.RawMessage `json:"value"`
	ObjectID string          `json:"objectId"`
}

type evalResult struct {
	Result           remoteObject `json:"result"`
	ExceptionDetails *struct {
		Text      string `json:"text"`
		Exception *struct {
			Description string `json:"description"`
		} `json:"exception"`
	} `json:"exceptionDetails"`
}

func (r *evalResult) err() error {
	if r.ExceptionDetails == nil {
		return nil
	}
	desc := r.ExceptionDetails.Text
	if r.ExceptionDetails.Exception != nil && r.ExceptionDetails.Exception.Description != "" {
		desc = r.ExceptionDetails.Exception.Description
	}
	return fmt.Errorf("页面脚本执行异常: %s", truncate(desc, 300))
}

// eval 在页面主世界执行表达式,returnByValue 反序列化进 out(可 nil)。
func (s *Session) eval(ctx context.Context, tab int, expr string, out any) error {
	var res evalResult
	if err := s.bridge.CDP(ctx, tab, "Runtime.evaluate", map[string]any{
		"expression": expr, "returnByValue": true,
	}, &res); err != nil {
		return err
	}
	if err := res.err(); err != nil {
		return err
	}
	if out != nil && len(res.Result.Value) > 0 {
		if err := json.Unmarshal(res.Result.Value, out); err != nil {
			return fmt.Errorf("页面脚本结果解析失败: %w", err)
		}
	}
	return nil
}

// callOn 对远端元素执行函数(this 为元素),returnByValue 反序列化进 out。
// 执行上下文已销毁(页面导航)时统一翻译为 ref 失效错误。
func (s *Session) callOn(ctx context.Context, tab int, objectID, fn string, args []any, out any) error {
	callArgs := make([]map[string]any, len(args))
	for i, a := range args {
		callArgs[i] = map[string]any{"value": a}
	}
	var res evalResult
	err := s.bridge.CDP(ctx, tab, "Runtime.callFunctionOn", map[string]any{
		"objectId": objectID, "functionDeclaration": fn,
		"arguments": callArgs, "returnByValue": true,
	}, &res)
	if err != nil {
		if isStaleObjectErr(err) {
			return errRefStale("该元素")
		}
		return err
	}
	if err := res.err(); err != nil {
		return err
	}
	if out != nil && len(res.Result.Value) > 0 {
		if err := json.Unmarshal(res.Result.Value, out); err != nil {
			return fmt.Errorf("元素操作结果解析失败: %w", err)
		}
	}
	return nil
}

// isStaleObjectErr CDP 报文表征"对象/上下文已随导航销毁"。
func isStaleObjectErr(err error) bool {
	msg := err.Error()
	for _, pat := range []string{
		"Cannot find context", "Could not find object",
		"Inspected target navigated", "Execution context was destroyed",
	} {
		if strings.Contains(msg, pat) {
			return true
		}
	}
	return false
}

// pageStatus 轻量页面状态(交互后回报,让模型免于每步 snapshot)。
type pageStatus struct {
	URL   string `json:"url"`
	Title string `json:"title"`
	Gen   int    `json:"gen"`
}

// status 读取当前页面状态;gen==0 表示快照后发生过导航(ref 已失效)。
func (s *Session) status(ctx context.Context, tab int) (pageStatus, error) {
	var st pageStatus
	err := s.eval(ctx, tab,
		`({url:location.href,title:document.title,gen:window.__mcAgentGen||0})`, &st)
	return st, err
}

// waitLoaded 轮询 readyState 至加载完成(interactive/complete)或超时。
func (s *Session) waitLoaded(ctx context.Context, tab int, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var state string
		if err := s.eval(ctx, tab, `document.readyState`, &state); err == nil &&
			(state == "complete" || state == "interactive") {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(300 * time.Millisecond):
		}
	}
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
