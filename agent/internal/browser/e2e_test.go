package browser

// 真实浏览器端到端:拉起 Chromium(--headless=new 支持扩展)加载
// browser-extension/dist,经 CDP 驱动扩展 options 页完成配对,再走
// navigate → snapshot → click → type → screenshot → tabs 全链路。
// 环境无 Chromium 或扩展未构建时跳过(CI 友好)。

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/chaitin/MonkeyCode/agent/internal/provider"
)

// devExtID manifest 里 key 钉死的 dev 扩展 ID。
const devExtID = "bhmoekbeakkmhaakojecgmnaomcepboa"

func findChromium() string {
	if v := os.Getenv("MC_TEST_CHROMIUM"); v != "" {
		return v
	}
	for _, name := range []string{"google-chrome", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	// playwright 缓存的 Chromium(全量 chrome 二进制,headless=new 支持扩展)
	home, _ := os.UserHomeDir()
	matches, _ := filepath.Glob(filepath.Join(home, ".cache/ms-playwright/chromium-*/chrome-linux/chrome"))
	if len(matches) > 0 {
		return matches[len(matches)-1]
	}
	return ""
}

func extDistDir(t *testing.T) string {
	t.Helper()
	// 包目录 agent/internal/browser → 仓库根/browser-extension/dist
	dist, err := filepath.Abs(filepath.Join("..", "..", "..", "browser-extension", "dist"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dist, "manifest.json")); err != nil {
		return ""
	}
	return dist
}

// cdpPage 直连 Chromium 调试端口的极简 CDP 客户端(仅驱动 options 页配对用)。
type cdpPage struct {
	ws *websocket.Conn
	id int
}

func (c *cdpPage) call(t *testing.T, method string, params map[string]any) json.RawMessage {
	t.Helper()
	c.id++
	req, _ := json.Marshal(map[string]any{"id": c.id, "method": method, "params": params})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, req); err != nil {
		t.Fatalf("CDP write: %v", err)
	}
	for {
		_, data, err := c.ws.Read(ctx)
		if err != nil {
			t.Fatalf("CDP read: %v", err)
		}
		var resp struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(data, &resp) == nil && resp.ID == c.id {
			return resp.Result
		}
	}
}

func (c *cdpPage) eval(t *testing.T, expr string) json.RawMessage {
	t.Helper()
	return c.call(t, "Runtime.evaluate",
		map[string]any{"expression": expr, "returnByValue": true, "awaitPromise": true})
}

// dialCDP 连接一个调试目标。
func dialCDP(t *testing.T, wsURL string) *cdpPage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("CDP dial: %v", err)
	}
	ws.SetReadLimit(16 * 1024 * 1024)
	return &cdpPage{ws: ws}
}

// findSWTarget 从 /json/list 找扩展 service worker 目标(id 与调试地址,可能为空)。
func findSWTarget(t *testing.T, dbgPort string) (id, wsURL string) {
	t.Helper()
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%s/json/list", dbgPort))
	if err != nil {
		return "", ""
	}
	defer resp.Body.Close()
	var targets []struct {
		ID                   string `json:"id"`
		Type                 string `json:"type"`
		URL                  string `json:"url"`
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if json.NewDecoder(resp.Body).Decode(&targets) != nil {
		return "", ""
	}
	for _, tg := range targets {
		if tg.Type == "service_worker" && strings.Contains(tg.URL, devExtID) {
			return tg.ID, tg.WebSocketDebuggerURL
		}
	}
	return "", ""
}

// openDebugTarget 开一个空白页并经 CDP 导航到 url(/json/new 不接受
// chrome-extension:// 地址,必须用 Page.navigate)。
func openDebugTarget(t *testing.T, dbgPort, url string) *cdpPage {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut,
		fmt.Sprintf("http://127.0.0.1:%s/json/new", dbgPort), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open target: %v", err)
	}
	defer resp.Body.Close()
	var target struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&target); err != nil || target.WebSocketDebuggerURL == "" {
		t.Fatalf("target 无调试地址: %v", err)
	}
	c := dialCDP(t, target.WebSocketDebuggerURL)
	c.call(t, "Page.navigate", map[string]any{"url": url})
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		res := c.eval(t, `location.href + '|' + document.readyState`)
		if strings.Contains(string(res), url+"|complete") {
			return c
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("页面未导航到 %s", url)
	return nil
}

const e2ePageHTML = `<!doctype html><html><head><title>E2E 测试页</title></head><body>
<h1>端到端验证</h1>
<button id="btn" onclick="document.title='已点击'">点我</button>
<input id="inp" placeholder="输入框">
<select id="sel"><option value="a">甲</option><option value="b">乙</option></select>
<a href="#down">锚点链接</a>
<!-- 同源 iframe:内含发布按钮,点击后经 postMessage 改父页面标题 -->
<iframe id="editor" src="/iframe" style="width:300px;height:120px;border:1px solid #ccc"></iframe>
<div id="cross"></div>
<script>
window.addEventListener('message', e => {
  if (e.data === 'published') document.title = '已发布';
  if (e.data === 'cross-published') document.title = '跨源已发布';
});
// 动态插入跨源 iframe:localhost ≠ 127.0.0.1(不同 origin),配合
// --site-per-process 成为跨进程 OOPIF。
var f = document.createElement('iframe');
f.src = 'http://localhost:' + location.port + '/iframe2';
f.style = 'width:300px;height:120px';
document.getElementById('cross').appendChild(f);
</script>
</body></html>`

// e2eIframeHTML 同源 iframe 内容:发布按钮点击后通知父页面。
const e2eIframeHTML = `<!doctype html><html><head><title>iframe 编辑器</title></head><body>
<button id="publish" onclick="parent.postMessage('published','*')">发布</button>
</body></html>`

// e2eCrossIframeHTML 跨源(OOPIF)iframe 内容:跨源发布按钮通知父页面。
const e2eCrossIframeHTML = `<!doctype html><html><head><title>跨源编辑器</title></head><body>
<button id="cpublish" onclick="parent.postMessage('cross-published','*')">跨源发布</button>
<input id="cinp" placeholder="跨源输入框">
</body></html>`

func TestE2E_ChromiumExtension(t *testing.T) {
	if testing.Short() {
		t.Skip("short 模式跳过")
	}
	chromium := findChromium()
	if chromium == "" {
		t.Skip("环境无 Chromium,跳过端到端(设 MC_TEST_CHROMIUM 指定)")
	}
	dist := extDistDir(t)
	if dist == "" {
		t.Skip("browser-extension/dist 未构建(npm run build),跳过端到端")
	}

	// 1. 扩展桥 + 测试页
	b, bridgeAddr := startBridge(t)
	_, bridgePort, _ := net.SplitHostPort(bridgeAddr)
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		switch r.URL.Path {
		case "/iframe":
			_, _ = w.Write([]byte(e2eIframeHTML))
		case "/iframe2":
			_, _ = w.Write([]byte(e2eCrossIframeHTML))
		default:
			_, _ = w.Write([]byte(e2ePageHTML))
		}
	}))
	defer page.Close()

	// 2. 拉起 Chromium。优先带头模式(xvfb 虚拟显示):--headless=new 下扩展
	// SW 发起的 WebSocket 会挂起 ~20s 且 SW 被激进回收,与真实环境行为不符。
	profile := t.TempDir()
	args := []string{
		"--user-data-dir=" + profile,
		"--load-extension=" + dist,
		"--disable-extensions-except=" + dist,
		"--remote-debugging-port=0",
		"--no-first-run", "--no-default-browser-check", "--no-sandbox",
		"--disable-dev-shm-usage",
		// 无桌面会话的 Linux 上系统代理解析会挂起 ~20s(SW 网络请求首当其冲)
		"--no-proxy-server",
		// 强制跨 origin iframe 跨进程化(OOPIF),让 localhost≠127.0.0.1 的
		// 子 iframe 走 Target auto-attach 路径,覆盖阶段2
		"--site-per-process",
		"about:blank",
	}
	var cmd *exec.Cmd
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		xvfb, err := exec.LookPath("xvfb-run")
		if err != nil {
			t.Skip("无显示环境且无 xvfb-run,跳过端到端(headless 模式的扩展 SW 网络栈行为失真)")
		}
		cmd = exec.Command(xvfb, append([]string{"-a", chromium}, args...)...)
	} else {
		cmd = exec.Command(chromium, args...)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("启动 Chromium: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	// DevToolsActivePort 文件给出实际调试端口
	dbgPort := ""
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(filepath.Join(profile, "DevToolsActivePort")); err == nil {
			lines := strings.Split(strings.TrimSpace(string(data)), "\n")
			if len(lines) > 0 && lines[0] != "" {
				dbgPort = lines[0]
				break
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	if dbgPort == "" {
		t.Fatal("Chromium 调试端口未就绪")
	}

	// 4. 驱动扩展 options 页配对(如同用户手填配对码)
	code := b.Status().PairingCode
	opts := openDebugTarget(t, dbgPort,
		"chrome-extension://"+devExtID+"/src/options/options.html")
	pairJS := fmt.Sprintf(`(async () => {
		for (let i = 0; i < 50 && !document.getElementById('pair-btn'); i++)
			await new Promise(r => setTimeout(r, 100));
		const port = document.getElementById('port');
		port.value = %q; port.dispatchEvent(new Event('input'));
		document.getElementById('code').value = %q;
		document.getElementById('pair-btn').click();
		return 'ok';
	})()`, bridgePort, code)
	if res := opts.eval(t, pairJS); !strings.Contains(string(res), "ok") {
		t.Fatalf("配对脚本执行异常: %s", res)
	}
	// SW 保活泵:本机 Chromium 冷启动时 SW 的网络请求挂起 ~20s,而空闲回收
	// 只要 ~10s——不续命的话 SW 永远活不到连接完成(真实桌面环境无此现象)。
	// 每 2s 发一条 runtime 消息重置空闲计时器,模拟"用户开着扩展页面"。
	opts.eval(t, `(self.__ka ??= setInterval(() => {
		try { chrome.runtime.sendMessage({type: 'noop'}).catch(() => {}); } catch {}
	}, 2000), 'pumped')`)

	// 5. 等扩展连上桥(SW 冷启动的首连可能失败,退避重连自愈)
	connectStart := time.Now()
	deadline = time.Now().Add(45 * time.Second)
	for !b.Status().Connected {
		if time.Now().After(deadline) {
			errMsg := opts.eval(t, `document.getElementById('error').textContent`)
			// 原始 WS 探针:从扩展 origin 直连桥,暴露真实握手错误
			probe := opts.eval(t, fmt.Sprintf(`new Promise(r => {
				try {
					const w = new WebSocket('ws://127.0.0.1:%s/ext');
					w.onopen = () => r('open');
					w.onclose = e => r('close code=' + e.code + ' reason=' + e.reason);
				} catch (e) { r('throw ' + e.message); }
			})`, bridgePort))
			t.Fatalf("扩展未连上桥: status=%+v optionsErr=%s probe=%s", b.Status(), errMsg, probe)
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Logf("扩展连上桥耗时 %.1fs", time.Since(connectStart).Seconds())

	// 5. 全链路工具操作
	ctx, cancel := context.WithTimeout(context.Background(), 240*time.Second)
	defer cancel()

	// 分级探针:验证桥接透传(tabs.list 无副作用)。本机 Chromium 冷启动的
	// SW 网络挂起可能产生一条"半死连接",探针失败即等扩展自愈重连
	// (alarms ≤30s)后重试——这正是真实环境的断线自愈路径。
	probeOK := false
	var lastErr error
	for attempt := 1; attempt <= 4 && !probeOK; attempt++ {
		deadline := time.Now().Add(45 * time.Second)
		for !b.Status().Connected && time.Now().Before(deadline) {
			time.Sleep(200 * time.Millisecond)
		}
		if !b.Status().Connected {
			lastErr = fmt.Errorf("扩展未在线")
			continue
		}
		probeCtx, probeCancel := context.WithTimeout(ctx, 10*time.Second)
		tabs, err := b.TabsList(probeCtx)
		probeCancel()
		if err == nil {
			t.Logf("tabs.list 探针通过(第 %d 次): %d 个标签页", attempt, len(tabs))
			probeOK = true
			break
		}
		lastErr = err
		t.Logf("探针第 %d 次失败: %v(等待扩展自愈重连)", attempt, err)
	}
	if !probeOK {
		diag := "无 SW"
		if _, cur := findSWTarget(t, dbgPort); cur != "" {
			sw := dialCDP(t, cur)
			diag = string(sw.eval(t, `JSON.stringify({frames: globalThis.__mcFrames ?? null})`))
			sw.ws.Close(websocket.StatusNormalClosure, "")
		}
		t.Fatalf("桥接透传始终不通: %v; SW 侧: %s", lastErr, diag)
	}

	s := NewSession(b, "e2e")
	defer s.Close()

	out, err := s.navigate(ctx, page.URL)
	if err != nil {
		t.Fatalf("navigate: %v", err)
	}
	if !strings.Contains(out, "E2E 测试页") || !strings.Contains(out, "端到端验证") {
		t.Fatalf("navigate 结果缺少标题/正文: %s", out)
	}

	// 多会话并行:第二个会话开自己的标签页,同窗口内 s1 的标签页随之转入
	// 后台——后续 s1 的快照/点击/输入/截图全部在非活动标签页上执行,
	// 即"不抢前台"的真实覆盖(CDP 直达渲染进程,无需标签页可见)。
	s2 := NewSession(b, "e2e-2")
	defer s2.Close()
	out2, err := s2.navigate(ctx, page.URL+"?session=2")
	if err != nil {
		t.Fatalf("s2 navigate(多会话并行): %v", err)
	}
	if !strings.Contains(out2, "E2E 测试页") {
		t.Fatalf("s2 navigate 结果不对: %s", out2)
	}

	snap, err := s.snapshot(ctx)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	// 含同源 iframe 内的"发布"按钮(阶段1:collectJS 递归同源 iframe)
	for _, want := range []string{"点我", "输入框", "锚点链接", "[select]", "发布", "(iframe 内)"} {
		if !strings.Contains(snap, want) {
			t.Fatalf("快照缺少 %q:\n%s", want, snap)
		}
	}
	refOf := func(marker string) string {
		for _, line := range strings.Split(snap, "\n") {
			if strings.Contains(line, marker) {
				return strings.Fields(line)[0]
			}
		}
		t.Fatalf("快照里找不到 %q", marker)
		return ""
	}

	// click:按钮 onclick 改 document.title,交互回报应看到新标题
	out, err = s.click(ctx, refOf("点我"))
	if err != nil {
		t.Fatalf("click: %v", err)
	}
	if !strings.Contains(out, "已点击") {
		t.Fatalf("点击后标题未变化: %s", out)
	}

	// type:输入后读回 input 值验证真实输入
	if _, err = s.typeText(ctx, refOf("输入框"), "你好世界", true, false); err != nil {
		t.Fatalf("type: %v", err)
	}
	var val string
	tab := s.tabID
	if err := s.eval(ctx, tab, `document.getElementById('inp').value`, &val); err != nil || val != "你好世界" {
		t.Fatalf("输入未生效: %q err=%v", val, err)
	}

	// select_option
	if _, err = s.selectOption(ctx, refOf("[select]"), []string{"乙"}); err != nil {
		t.Fatalf("select: %v", err)
	}
	if err := s.eval(ctx, tab, `document.getElementById('sel').value`, &val); err != nil || val != "b" {
		t.Fatalf("下拉选择未生效: %q err=%v", val, err)
	}

	// 阶段1 核心:点击同源 iframe 内的"发布"按钮。坐标经 DOM.getBoxModel
	// 自动含 iframe 偏移,真实鼠标点到 iframe 内元素;点击后 postMessage
	// 把父页面标题改为"已发布"。
	if _, err = s.click(ctx, refOf("发布")); err != nil {
		t.Fatalf("点击 iframe 内按钮: %v", err)
	}
	var parentTitle string
	deadlineIframe := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadlineIframe) {
		if err := s.eval(ctx, tab, `document.title`, &parentTitle); err == nil && parentTitle == "已发布" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if parentTitle != "已发布" {
		t.Fatalf("iframe 内发布按钮点击未生效,父页面标题=%q", parentTitle)
	}

	// 阶段2 核心:跨源 OOPIF iframe 内的按钮。动态插入的跨源 iframe 需时间
	// 完成 auto-attach,轮询 snapshot 直到 FramesList 采到子会话里的按钮。
	var crossSnap string
	deadlineCross := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadlineCross) {
		crossSnap, err = s.snapshot(ctx)
		if err == nil && strings.Contains(crossSnap, "跨源发布") {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if !strings.Contains(crossSnap, "跨源发布") {
		t.Fatalf("跨源 OOPIF 按钮未采集到(auto-attach/site-per-process 未生效?):\n%s", crossSnap)
	}
	crossRef := ""
	for _, line := range strings.Split(crossSnap, "\n") {
		if strings.Contains(line, "跨源发布") {
			crossRef = strings.Fields(line)[0]
		}
	}
	if crossRef == "" {
		t.Fatal("跨源发布按钮无 ref")
	}
	// 点击(OOPIF 走子会话 element.click 兜底),父页面标题应变"跨源已发布"
	if _, err = s.click(ctx, crossRef); err != nil {
		t.Fatalf("点击跨源 OOPIF 内按钮: %v", err)
	}
	deadlineCross = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadlineCross) {
		if err := s.eval(ctx, tab, `document.title`, &parentTitle); err == nil && parentTitle == "跨源已发布" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if parentTitle != "跨源已发布" {
		t.Fatalf("跨源 OOPIF 按钮点击未生效,父页面标题=%q", parentTitle)
	}

	// screenshot:应产出图片块
	blocks, display, err := s.screenshot(ctx, false)
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	if len(blocks) < 2 || blocks[0].Type != provider.BlockImage || blocks[0].Source == nil || blocks[0].Source.Data == "" {
		t.Fatalf("截图应为 [image, text] 块: display=%q", display)
	}

	// tabs:列表应含受控的当前标签页(两个会话各有一个受控标签页)
	tabsOut, err := s.tabsOp(ctx, "list", 0, "")
	if err != nil {
		t.Fatalf("tabs list: %v", err)
	}
	if !strings.Contains(tabsOut, "[受控]") || !strings.Contains(tabsOut, "[当前]") {
		t.Fatalf("标签页列表缺少受控/当前标注:\n%s", tabsOut)
	}
	if strings.Count(tabsOut, "[受控]") < 2 {
		t.Fatalf("应有两个受控标签页(多会话并行):\n%s", tabsOut)
	}

	// s2 在自己的标签页上独立操作(事件路由互不串扰)
	snap2, err := s2.snapshot(ctx)
	if err != nil {
		t.Fatalf("s2 snapshot: %v", err)
	}
	if !strings.Contains(snap2, "session=2") && !strings.Contains(snap2, "点我") {
		t.Fatalf("s2 快照不对:\n%s", snap2)
	}

	// ref 失效闭环:导航后旧 ref 应报错引导重新 snapshot
	oldRef := refOf("锚点链接")
	if _, err = s.navigate(ctx, page.URL+"?again=1"); err != nil {
		t.Fatalf("re-navigate: %v", err)
	}
	if _, err = s.click(ctx, oldRef); err == nil || !strings.Contains(err.Error(), "browser_snapshot") {
		t.Fatalf("导航后旧 ref 应报失效并引导重新快照: %v", err)
	}
}
