package baizhi

// 云端任务流代理:UI ⇆ 内核 ⇆ monkeycode 云端 WS。
// UI 直连云端会被 CORS/凭证拦(monkeycode 会话 cookie 只在内核手里),
// 因此内核对 UI 开一条本地 WS,自己带 cookie 拨 wss 到云端
// /api/v1/users/tasks/stream,两个方向原样转发——云端下行 TaskStream
// 与 UI 的 Frame 逐字段同构,上行 user-input/user-cancel/reply-question
// 也是云端原生词汇,代理零翻译。

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// 读上限:云端工具输出帧可以很大(默认 32KB 必炸);上行是用户输入,给 4MB 足够。
const (
	mcStreamDownstreamLimit = 32 << 20
	mcStreamUpstreamLimit   = 4 << 20
)

// handleMCTaskStream GET /api/mc/tasks/{id}/stream?mode=attach|new。
func (s *Service) handleMCTaskStream(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("mode")
	if mode != "new" {
		mode = "attach"
	}
	s.proxyMCWS(w, r, "/api/v1/users/tasks/stream?id="+url.QueryEscape(r.PathValue("id"))+"&mode="+mode)
}

// handleMCTaskControl GET /api/mc/tasks/{id}/control。
// 云端控制流(call/call-response:文件树/读文件/改动/diff/端口等),
// 独立于任务流的长生命周期连接,任务结束后仍可用(浏览产物)。
func (s *Service) handleMCTaskControl(w http.ResponseWriter, r *http.Request) {
	s.proxyMCWS(w, r, "/api/v1/users/tasks/control?id="+url.QueryEscape(r.PathValue("id")))
}

// handleMCVMTerminal GET /api/mc/vms/{id}/terminal?terminal_id=<uuid>。
// 云端 VM 终端(xterm 协议:文本 JSON 帧,data/resize/ping,payload base64),
// 与任务流/控制流独立的第三条 WS。terminal_id 由 UI 生成(uuid,新 tab 即新 id)。
func (s *Service) handleMCVMTerminal(w http.ResponseWriter, r *http.Request) {
	tid := r.URL.Query().Get("terminal_id")
	if tid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少 terminal_id"})
		return
	}
	s.proxyMCWS(w, r, "/api/v1/users/hosts/vms/"+url.PathEscape(r.PathValue("id"))+
		"/terminals/connect?terminal_id="+url.QueryEscape(tid))
}

// proxyMCWS 拨云端 WS 并与 UI 连接双向对拷(pathAndQuery 拼在云端基址后)。
// 先拨通云端再升级 UI 连接,拨不通直接回 HTTP 错误(UI 可读错误体)。
func (s *Service) proxyMCWS(w http.ResponseWriter, r *http.Request, pathAndQuery string) {
	if r.PathValue("id") == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少资源 ID"})
		return
	}
	if s.mc.empty() {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "MonkeyCode 会话缺失,请先同步云端账号"})
		return
	}

	// 云端 wss 地址;cookie 罐按 https 形态取(Secure cookie 匹配 scheme)
	httpsURL := s.ep.MonkeyCode + pathAndQuery
	wsURL := strings.Replace(strings.Replace(httpsURL, "https://", "wss://", 1), "http://", "ws://", 1)
	header := http.Header{}
	if u, err := url.Parse(httpsURL); err == nil {
		if h := s.mc.header(u); h != "" {
			header.Set("Cookie", h)
		}
	}

	dialCtx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	up, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{HTTPHeader: header})
	cancel()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "连接云端任务流失败: " + err.Error()})
		return
	}
	up.SetReadLimit(mcStreamDownstreamLimit)

	down, err := websocket.Accept(w, r, nil) // 默认同源 Origin 校验(与 /ws 一致)
	if err != nil {
		up.Close(websocket.StatusInternalError, "ui accept failed")
		return
	}
	down.SetReadLimit(mcStreamUpstreamLimit)

	// 双向泵:任一方向断开即整体收尾(ctx 取消让另一方向的 Read 立刻返回)
	ctx, stop := context.WithCancel(r.Context())
	defer stop()
	go func() {
		defer stop()
		pipeWS(ctx, up, down) // 云端 → UI
	}()
	pipeWS(ctx, down, up) // UI → 云端
	stop()
	up.Close(websocket.StatusNormalClosure, "")
	down.Close(websocket.StatusNormalClosure, "")
}

// pipeWS 单方向转发直到读/写失败或 ctx 取消。
func pipeWS(ctx context.Context, from, to *websocket.Conn) {
	for {
		typ, data, err := from.Read(ctx)
		if err != nil {
			return
		}
		if err := to.Write(ctx, typ, data); err != nil {
			return
		}
	}
}
