package browser

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// startBridge 启动测试桥(随机端口),返回桥与取消函数。
func startBridge(t *testing.T) (*ExtBridge, string) {
	t.Helper()
	b, err := NewExtBridge("127.0.0.1:0", true, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go b.ListenAndServe(ctx)
	deadline := time.Now().Add(3 * time.Second)
	for {
		if s := b.Status(); s.Enabled {
			return b, s.Addr
		}
		if time.Now().After(deadline) {
			t.Fatalf("桥未就绪: %+v", b.Status())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// helloOKParsed hello.ok 应答(测试侧解析)。
type helloOKParsed struct {
	Event string `json:"event"`
	Token string `json:"token"`
}

// dialExt 模拟扩展连入并发 hello,返回连接与 hello.ok 应答。
func dialExt(t *testing.T, addr string, auth HelloAuth) (*websocket.Conn, helloOKParsed, error) {
	t.Helper()
	var ok helloOKParsed
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws://"+addr+"/ext", nil)
	if err != nil {
		return nil, ok, err
	}
	hello := Message{Event: EventHello, Auth: &auth, Proto: ProtoVersion,
		Ext:     &ExtInfo{ID: "test-ext-id", Version: "0.1.0"},
		Browser: &BrowserInfo{Name: "Chrome", Version: "126.0"},
	}
	data, _ := json.Marshal(hello)
	if err := ws.Write(ctx, websocket.MessageText, data); err != nil {
		ws.Close(websocket.StatusNormalClosure, "")
		return nil, ok, err
	}
	_, resp, err := ws.Read(ctx)
	if err != nil {
		ws.Close(websocket.StatusNormalClosure, "")
		return nil, ok, err
	}
	if err := json.Unmarshal(resp, &ok); err != nil {
		t.Fatalf("hello.ok 解析失败: %s", resp)
	}
	return ws, ok, nil
}

func TestBridge_PairingFlow(t *testing.T) {
	b, addr := startBridge(t)
	s := b.Status()
	if s.Paired || s.PairingCode == "" {
		t.Fatalf("初始状态应未配对且有配对码: %+v", s)
	}

	// 配对码带连字符/小写:归一后应通过
	code := s.PairingCode[:4] + "-" + s.PairingCode[4:]
	ws, ok, err := dialExt(t, addr, HelloAuth{Code: code})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	if ok.Event != EventHelloOK || ok.Token == "" {
		t.Fatalf("应答应为 hello.ok 且颁发 token: %+v", ok)
	}

	s = b.Status()
	if !s.Paired || !s.Connected || s.PairingCode != "" {
		t.Fatalf("配对后状态不对: %+v", s)
	}
	if s.BrowserName != "Chrome" {
		t.Fatalf("浏览器信息未记录: %+v", s)
	}
	// 凭据已落盘
	if _, err := os.Stat(b.authPath); err != nil {
		t.Fatal("ext-auth.json 未落盘")
	}
}

func TestBridge_BadCodeRejected(t *testing.T) {
	_, addr := startBridge(t)
	ws, _, err := dialExt(t, addr, HelloAuth{Code: "WRONGCOD"})
	if err == nil {
		ws.Close(websocket.StatusNormalClosure, "")
		t.Fatal("错误配对码应被拒绝(连接关闭)")
	}
}

func TestBridge_TokenReconnectAndReplace(t *testing.T) {
	b, addr := startBridge(t)
	code := b.Status().PairingCode
	ws1, ok, err := dialExt(t, addr, HelloAuth{Code: code})
	if err != nil {
		t.Fatal(err)
	}
	token := ok.Token
	if token == "" {
		t.Fatal("配对应颁发长期 token")
	}

	// 扩展未以 token 确认持久化前,配对码保持可用(防半死连接吞码),
	// 且每次使用重新颁发 token
	wsRe, okRe, err := dialExt(t, addr, HelloAuth{Code: code})
	if err != nil || okRe.Token == "" {
		t.Fatalf("token 确认前配对码应可重用: %v", err)
	}
	wsRe.Close(websocket.StatusNormalClosure, "")
	token = okRe.Token

	// token 重连:新连接顶替旧连接,并确认配对(配对码此刻作废)
	ws2, _, err := dialExt(t, addr, HelloAuth{Token: token})
	if err != nil {
		t.Fatal(err)
	}
	defer ws2.Close(websocket.StatusNormalClosure, "")
	if ws, _, err := dialExt(t, addr, HelloAuth{Code: code}); err == nil {
		ws.Close(websocket.StatusNormalClosure, "")
		t.Fatal("token 连入确认后配对码应作废")
	}
	// 旧连接应被关闭(读到 EOF/关闭错误)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := ws1.Read(ctx); err == nil {
		t.Fatal("旧连接应被新连接顶替关闭")
	}
	if !b.Status().Connected {
		t.Fatal("新连接应在线")
	}

	// 错误 token 拒绝
	if ws, _, err := dialExt(t, addr, HelloAuth{Token: "deadbeef"}); err == nil {
		ws.Close(websocket.StatusNormalClosure, "")
		t.Fatal("错误 token 应被拒绝")
	}
}

func TestBridge_PersistedTokenSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	b1, err := NewExtBridge("127.0.0.1:0", true, dir)
	if err != nil {
		t.Fatal(err)
	}
	// 手工写入凭据模拟上一进程配对结果
	data, _ := json.Marshal(extAuth{Token: "tok123", ExtID: "test-ext-id"})
	if err := os.WriteFile(filepath.Join(dir, "ext-auth.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	b2, err := NewExtBridge("127.0.0.1:0", true, dir)
	if err != nil {
		t.Fatal(err)
	}
	_ = b1
	if !b2.Status().Paired {
		t.Fatal("重启后应加载落盘 token")
	}
}

// extResponder 模拟扩展的请求应答循环。
func extResponder(t *testing.T, ws *websocket.Conn, handle func(Request) Message) {
	t.Helper()
	go func() {
		for {
			_, data, err := ws.Read(context.Background())
			if err != nil {
				return
			}
			var req Request
			if json.Unmarshal(data, &req) != nil {
				continue
			}
			if req.Op == OpPing {
				resp, _ := json.Marshal(Message{Event: EventPong})
				_ = ws.Write(context.Background(), websocket.MessageText, resp)
				continue
			}
			msg := handle(req)
			msg.ID = req.ID
			resp, _ := json.Marshal(msg)
			_ = ws.Write(context.Background(), websocket.MessageText, resp)
		}
	}()
}

func TestBridge_CallRoundTrip(t *testing.T) {
	b, addr := startBridge(t)
	ws, _, err := dialExt(t, addr, HelloAuth{Code: b.Status().PairingCode})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	extResponder(t, ws, func(req Request) Message {
		switch req.Op {
		case OpCDP:
			if req.Method == "Page.navigate" {
				return Message{Result: json.RawMessage(`{"frameId":"F1"}`)}
			}
			return Message{Error: &RespError{Code: ErrCodeCDP, Message: "boom"}}
		case OpTabsCreate:
			return Message{Result: json.RawMessage(`{"tabId":42}`)}
		case OpTabsList:
			return Message{Result: json.RawMessage(`[{"tabId":42,"url":"https://a.com","controlled":true}]`)}
		}
		return Message{Error: &RespError{Code: ErrCodeCDP}}
	})

	ctx := context.Background()
	var nav struct {
		FrameID string `json:"frameId"`
	}
	if err := b.CDP(ctx, 42, "Page.navigate", map[string]string{"url": "https://a.com"}, &nav); err != nil {
		t.Fatal(err)
	}
	if nav.FrameID != "F1" {
		t.Fatalf("CDP 结果不对: %+v", nav)
	}

	id, err := b.TabsCreate(ctx, "about:blank")
	if err != nil || id != 42 {
		t.Fatalf("TabsCreate: id=%d err=%v", id, err)
	}
	tabs, err := b.TabsList(ctx)
	if err != nil || len(tabs) != 1 || !tabs[0].Controlled {
		t.Fatalf("TabsList: %+v err=%v", tabs, err)
	}

	// 扩展侧错误应带可行动文案
	err = b.CDP(ctx, 42, "Runtime.evaluate", nil, nil)
	if err == nil {
		t.Fatal("应返回错误")
	}
}

func TestBridge_CallWithoutConn(t *testing.T) {
	b, _ := startBridge(t)
	err := b.CDP(context.Background(), 1, "Page.navigate", nil, nil)
	if err == nil {
		t.Fatal("无连接时应报「扩展未连接」")
	}
}

func TestBridge_EventDispatchAndPendingHandoff(t *testing.T) {
	b, addr := startBridge(t)
	ws, _, err := dialExt(t, addr, HelloAuth{Code: b.Status().PairingCode})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	// 无活跃会话时 handoff 暂存
	handoff, _ := json.Marshal(Message{Event: EventHandoff, TabID: 7,
		Info: &TabInfo{TabID: 7, URL: "https://x.com", Controlled: true}})
	_ = ws.Write(context.Background(), websocket.MessageText, handoff)
	deadline := time.Now().Add(2 * time.Second)
	for {
		if tab := b.TakePendingHandoff(); tab != nil {
			if tab.TabID != 7 {
				t.Fatalf("暂存 handoff 不对: %+v", tab)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("handoff 未暂存")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// 有回调时事件直达
	got := make(chan Message, 1)
	b.SetEventHandler(func(m Message) { got <- m })
	ev, _ := json.Marshal(Message{Event: EventTabRemoved, TabID: 7})
	_ = ws.Write(context.Background(), websocket.MessageText, ev)
	select {
	case m := <-got:
		if m.Event != EventTabRemoved || m.TabID != 7 {
			t.Fatalf("事件不对: %+v", m)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("事件未派发")
	}
}

func TestBridge_LeaseMutex(t *testing.T) {
	b, _ := startBridge(t)
	if err := b.Acquire("s1"); err != nil {
		t.Fatal(err)
	}
	if err := b.Acquire("s1"); err != nil {
		t.Fatal("同一持有者重入应成功")
	}
	if err := b.Acquire("s2"); err == nil {
		t.Fatal("他人持有时应互斥")
	}
	b.Release("s1")
	if err := b.Acquire("s2"); err != nil {
		t.Fatal("释放后应可获取")
	}
}

func TestBridge_Repair(t *testing.T) {
	b, addr := startBridge(t)
	ws, _, err := dialExt(t, addr, HelloAuth{Code: b.Status().PairingCode})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	s := b.Repair()
	if s.Paired || s.PairingCode == "" {
		t.Fatalf("重置后应未配对且有新配对码: %+v", s)
	}
	if _, err := os.Stat(b.authPath); !os.IsNotExist(err) {
		t.Fatal("重置应删除落盘凭据")
	}
	// 旧连接被断开
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := ws.Read(ctx); err == nil {
		t.Fatal("重置应断开现有连接")
	}
}

// 扩展 SW 的 Origin 是 chrome-extension://<id>(必然非同源),握手不得被拒
func TestBridge_ExtensionOriginAccepted(t *testing.T) {
	b, addr := startBridge(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws://"+addr+"/ext", &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Origin": {"chrome-extension://abcdefghijklmnop"}},
	})
	if err != nil {
		t.Fatalf("扩展 Origin 握手被拒: %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	hello, _ := json.Marshal(Message{Event: EventHello, Auth: &HelloAuth{Code: b.Status().PairingCode}})
	if err := ws.Write(ctx, websocket.MessageText, hello); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ws.Read(ctx); err != nil {
		t.Fatalf("带扩展 Origin 的配对应成功: %v", err)
	}
}

func TestNormalizeCode(t *testing.T) {
	if normalizeCode("k7mq-p2xr") != "K7MQP2XR" {
		t.Fatal("配对码归一化失败")
	}
	if normalizeCode(" AB CD ") != "ABCD" {
		t.Fatal("空格应剔除")
	}
}
