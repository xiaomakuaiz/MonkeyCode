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
// 先拨通云端再升级 UI 连接,拨不通直接回 HTTP 错误(UI 可读错误体)。
func (s *Service) handleMCTaskStream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少任务 ID"})
		return
	}
	mode := r.URL.Query().Get("mode")
	if mode != "new" {
		mode = "attach"
	}
	if s.mc.empty() {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "MonkeyCode 会话缺失,请先同步云端账号"})
		return
	}

	// 云端 wss 地址;cookie 罐按 https 形态取(Secure cookie 匹配 scheme)
	httpsURL := s.ep.MonkeyCode + "/api/v1/users/tasks/stream?id=" + url.QueryEscape(id) + "&mode=" + mode
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
