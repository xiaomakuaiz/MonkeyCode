// Package browser 浏览器控制:自研 MV3 扩展经本地 WS 桥接,内核在用户真实
// 浏览器(Chrome/Edge)中执行 CDP 操作。
//
// 架构:扩展是"带鉴权的 chrome.debugger 哑代理 + 标签页授权 UI",一切浏览器
// 语义(快照、ref、坐标点击、键序列)在 Go 侧实现;未来若加内置浏览器模式,
// Go 侧逻辑可原样复用,只换传输层。
//
// 桥接协议(JSON 文本帧,单连接):
//
//	扩展→内核 首帧  {"event":"hello","auth":{"token"|"code"},"ext":{...},"browser":{...},"proto":1}
//	内核→扩展 应答  {"event":"hello.ok","token":"<配对时新颁发>"}
//	内核→扩展 请求  {"id":N,"op":"cdp|tabs.*|attach|detach|ping","tabId":T,"method":"...","params":{...}}
//	扩展→内核 应答  {"id":N,"result":{...}} | {"id":N,"error":{"code","message"}}
//	扩展→内核 事件  {"event":"cdp|tab.updated|tab.removed|detached|handoff|pong","tabId":T,...}
package browser

import (
	"encoding/json"
	"fmt"
)

// ProtoVersion 桥接协议版本(前向兼容判断用)。
const ProtoVersion = 1

// 内核→扩展的请求 op。
const (
	OpCDP          = "cdp"           // chrome.debugger.sendCommand 透传
	OpTabsCreate   = "tabs.create"   // 新建标签页并 attach,自动纳入受控集合
	OpTabsList     = "tabs.list"     // 列出全部标签页(含受控标注)
	OpTabsActivate = "tabs.activate" // 激活标签页/前置窗口(截图与真实输入需要)
	OpTabsClose    = "tabs.close"    // 关闭标签页
	OpAttach       = "attach"        // attach debugger(幂等;仅受控集合内允许)
	OpDetach       = "detach"        // detach debugger
	OpPing         = "ping"          // 保活(兼作 MV3 SW 续命)
)

// 扩展→内核的事件。
const (
	EventHello      = "hello"       // 连接首帧(鉴权)
	EventHelloOK    = "hello.ok"    // 内核应答(仅此一个下行事件)
	EventCDP        = "cdp"         // chrome.debugger.onEvent 透传
	EventTabUpdated = "tab.updated" // 受控标签页 URL/标题/加载状态变化
	EventTabRemoved = "tab.removed" // 受控标签页被关闭
	EventDetached   = "detached"    // debugger 被剥离(用户点信息条取消/页面关闭/DevTools)
	EventHandoff    = "handoff"     // 用户在 popup 把当前标签页交给 agent
	EventPong       = "pong"        // ping 应答
)

// 扩展侧错误码。
const (
	ErrCodeDetached         = "detached"          // debugger 未附加/已被剥离
	ErrCodeNoTab            = "no_tab"            // 标签页不存在
	ErrCodeRestrictedURL    = "restricted_url"    // chrome:// 等受限页面
	ErrCodeNotControlled    = "not_controlled"    // 标签页不在受控集合
	ErrCodeCDP              = "cdp_error"         // CDP 命令执行失败
	ErrCodeDebuggerConflict = "debugger_conflict" // 已有其他调试器(如 DevTools)
)

// Request 内核→扩展请求帧。
type Request struct {
	ID     int64           `json:"id"`
	Op     string          `json:"op"`
	TabID  int             `json:"tabId,omitempty"`
	Method string          `json:"method,omitempty"` // op=cdp 时的 CDP 方法名
	Params json.RawMessage `json:"params,omitempty"`
}

// Message 扩展→内核入站帧(应答或事件,按字段区分)。
type Message struct {
	// 应答字段(ID>0)
	ID     int64           `json:"id,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RespError      `json:"error,omitempty"`

	// 事件字段
	Event  string          `json:"event,omitempty"`
	TabID  int             `json:"tabId,omitempty"`
	Method string          `json:"method,omitempty"` // event=cdp 时的 CDP 事件名
	Params json.RawMessage `json:"params,omitempty"` // event=cdp 时的事件载荷
	Info   *TabInfo        `json:"info,omitempty"`   // tab.updated / handoff
	Reason string          `json:"reason,omitempty"` // detached

	// hello 字段
	Auth    *HelloAuth   `json:"auth,omitempty"`
	Ext     *ExtInfo     `json:"ext,omitempty"`
	Browser *BrowserInfo `json:"browser,omitempty"`
	Proto   int          `json:"proto,omitempty"`
}

// RespError 扩展侧执行错误。
type RespError struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

// Error 转为内核侧错误(给模型的文案,按错误码翻译成可行动的提示)。
func (e *RespError) Error() string {
	switch e.Code {
	case ErrCodeDetached:
		return "浏览器调试连接已断开(用户可能点了「取消」提示条),请用 browser_tabs 重新选择或新建标签页"
	case ErrCodeNoTab:
		return "标签页不存在(可能已被关闭),请用 browser_tabs 查看当前标签页"
	case ErrCodeRestrictedURL:
		return "该页面受浏览器保护(chrome:// 等内部页面),无法操作"
	case ErrCodeNotControlled:
		return "该标签页未交给 agent 控制;请引导用户点击浏览器工具栏的 MonkeyCode 扩展图标,选择「交给 agent 操作」"
	case ErrCodeDebuggerConflict:
		return "该标签页已被其他调试器占用(如已打开开发者工具),请引导用户关闭该页的 DevTools 后重试"
	default:
		if e.Message != "" {
			return fmt.Sprintf("浏览器操作失败(%s): %s", e.Code, e.Message)
		}
		return fmt.Sprintf("浏览器操作失败(%s)", e.Code)
	}
}

// HelloAuth 连接鉴权:长期 token(已配对)或一次性配对码(首次配对)。
type HelloAuth struct {
	Token string `json:"token,omitempty"`
	Code  string `json:"code,omitempty"`
}

// ExtInfo 扩展自述。
type ExtInfo struct {
	ID      string `json:"id"`
	Version string `json:"version,omitempty"`
}

// BrowserInfo 浏览器自述(状态页展示)。
type BrowserInfo struct {
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
}

// TabInfo 标签页元数据(tabs.list 结果项 / tab.updated / handoff 载荷)。
type TabInfo struct {
	TabID      int    `json:"tabId"`
	URL        string `json:"url,omitempty"`
	Title      string `json:"title,omitempty"`
	Active     bool   `json:"active,omitempty"`
	Controlled bool   `json:"controlled,omitempty"` // 在受控集合内
	Status     string `json:"status,omitempty"`     // loading | complete
}

// helloOK 内核对 hello 的应答帧。
type helloOK struct {
	Event string `json:"event"` // 固定 hello.ok
	Token string `json:"token,omitempty"`
	Proto int    `json:"proto"`
}
