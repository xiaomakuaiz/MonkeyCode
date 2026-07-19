// 浏览器操作语义:每个 browser_ 工具对应的会话级实现。
package browser

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
)

const (
	// navTimeout 导航后等待页面加载的上限。
	navTimeout = 10 * time.Second
	// settleDelay 交互后给页面反应的时间(JS 处理/发起导航)。
	settleDelay = 500 * time.Millisecond
)

// validateURL 仅放行 http/https(about:blank 允许,内部空白页)。
func validateURL(raw string) error {
	if raw == "about:blank" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("仅支持 http/https 地址(收到 %q);浏览器内部页面受保护无法访问", raw)
	}
	return nil
}

// navigate 打开 URL("back" 后退);无活动标签页时自动新建。
func (s *Session) navigate(ctx context.Context, rawURL string) (string, error) {
	if err := s.ensure(ctx); err != nil {
		return "", err
	}
	if rawURL == "back" {
		return s.navigateBack(ctx)
	}
	if err := validateURL(rawURL); err != nil {
		return "", err
	}

	s.mu.Lock()
	tab := s.tabID
	s.mu.Unlock()
	if tab == 0 {
		id, err := s.bridge.TabsCreate(ctx, rawURL)
		if err != nil {
			return "", err
		}
		s.bridge.ClaimTab(id, s.owner)
		s.mu.Lock()
		s.tabs[id] = true
		s.tabID = id
		s.refs.invalidate()
		s.mu.Unlock()
		tab = id
		_ = s.bridge.CDP(ctx, tab, "Page.enable", nil, nil)
	} else {
		if err := s.bridge.Attach(ctx, tab); err != nil {
			return "", err
		}
		_ = s.bridge.CDP(ctx, tab, "Page.enable", nil, nil)
		var nav struct {
			ErrorText string `json:"errorText"`
		}
		if err := s.bridge.CDP(ctx, tab, "Page.navigate", map[string]string{"url": rawURL}, &nav); err != nil {
			return "", err
		}
		if nav.ErrorText != "" {
			return "", fmt.Errorf("导航失败: %s", nav.ErrorText)
		}
	}
	s.waitLoaded(ctx, tab, navTimeout)
	s.mu.Lock()
	s.refs.invalidate()
	s.mu.Unlock()
	return s.pageBrief(ctx, tab)
}

// navigateBack 历史后退。
func (s *Session) navigateBack(ctx context.Context) (string, error) {
	tab, err := s.ensureTab(ctx)
	if err != nil {
		return "", err
	}
	var hist struct {
		CurrentIndex int `json:"currentIndex"`
		Entries      []struct {
			ID int `json:"id"`
		} `json:"entries"`
	}
	if err := s.bridge.CDP(ctx, tab, "Page.getNavigationHistory", nil, &hist); err != nil {
		return "", err
	}
	if hist.CurrentIndex <= 0 || hist.CurrentIndex >= len(hist.Entries) {
		return "", fmt.Errorf("没有可后退的历史记录")
	}
	entry := hist.Entries[hist.CurrentIndex-1]
	if err := s.bridge.CDP(ctx, tab, "Page.navigateToHistoryEntry",
		map[string]int{"entryId": entry.ID}, nil); err != nil {
		return "", err
	}
	s.waitLoaded(ctx, tab, navTimeout)
	s.mu.Lock()
	s.refs.invalidate()
	s.mu.Unlock()
	return s.pageBrief(ctx, tab)
}

// pageBrief 页面摘要:标题/URL/正文节选。
func (s *Session) pageBrief(ctx context.Context, tab int) (string, error) {
	var brief struct {
		URL     string `json:"url"`
		Title   string `json:"title"`
		Excerpt string `json:"excerpt"`
	}
	err := s.eval(ctx, tab,
		`({url:location.href,title:document.title,excerpt:(document.body?document.body.innerText:'').trim().replace(/\n{3,}/g,'\n\n').slice(0,800)})`,
		&brief)
	if err != nil {
		return "", err
	}
	out := fmt.Sprintf("已打开: %s\nURL: %s", firstNonEmpty(brief.Title, "(无标题)"), brief.URL)
	if brief.Excerpt != "" {
		out += "\n\n正文开头:\n" + brief.Excerpt
	}
	out += "\n\n(调用 browser_snapshot 获取可交互元素列表)"
	return out + s.takeNotes(), nil
}

// snapshot 页面快照:元数据 + 重建 ref 表 + 格式化文本。
func (s *Session) snapshot(ctx context.Context) (string, error) {
	tab, err := s.ensureTab(ctx)
	if err != nil {
		return "", err
	}

	// 释放上一代对象组(主 + 上次的所有 OOPIF 子会话,防远端对象泄漏)
	s.mu.Lock()
	oldGroup := ""
	if s.refs.gen > 0 {
		oldGroup = s.refs.objectGroup()
	}
	oldSessions := append([]string{""}, s.lastOOPIF...)
	newGen := s.refs.gen + 1
	s.mu.Unlock()
	if oldGroup != "" {
		for _, sid := range oldSessions {
			_ = s.bridge.CDPSession(ctx, tab, sid, "Runtime.releaseObjectGroup",
				map[string]string{"objectGroup": oldGroup}, nil)
		}
	}
	group := fmt.Sprintf("mc-gen-%d", newGen)

	// 主 target(含同源 iframe,阶段1)
	meta, refs, err := s.collectFrame(ctx, tab, "", group)
	if err != nil {
		return "", err
	}

	// 跨源 iframe(OOPIF):各自独立子会话,逐个采集并入(扩展已递归 attach
	// 所有层级,FramesList 返回全部深度的子会话)。单个子会话失败只跳过。
	oopif := []string{}
	frames, ferr := s.bridge.FramesList(ctx, tab)
	if ferr == nil {
		for _, f := range frames {
			fMeta, fRefs, err := s.collectFrame(ctx, tab, f.SessionID, group)
			if err != nil {
				continue
			}
			for i := range fMeta.Items {
				fMeta.Items[i].Framed = true
			}
			meta.Items = append(meta.Items, fMeta.Items...)
			refs = append(refs, fRefs...)
			oopif = append(oopif, f.SessionID)
		}
		// 顶层跨源 iframe 已展开;仅当无法枚举时才提示"未包含"
		meta.CrossOriginIframes = 0
	}

	s.mu.Lock()
	s.refs.rebuild(newGen, refs)
	s.lastOOPIF = oopif
	s.mu.Unlock()
	return formatSnapshot(meta) + s.takeNotes(), nil
}

// collectFrame 在一个会话(空 = 根会话/主 target;非空 = OOPIF 子会话)采集
// 可交互元素:执行 collectJS 拿元数据,再取元素数组句柄逐个解析 objectId。
func (s *Session) collectFrame(ctx context.Context, tab int, sessionID, group string) (*snapshotMeta, []elemRef, error) {
	var raw string
	if err := s.evalSession(ctx, tab, sessionID, collectJS, &raw); err != nil {
		return nil, nil, err
	}
	meta, err := parseSnapshotMeta(raw)
	if err != nil {
		return nil, nil, err
	}
	var arr evalResult
	if err := s.bridge.CDPSession(ctx, tab, sessionID, "Runtime.evaluate", map[string]any{
		"expression": "window.__mcAgentRefs", "objectGroup": group,
	}, &arr); err != nil {
		return nil, nil, err
	}
	if err := arr.err(); err != nil {
		return nil, nil, err
	}
	refs := make([]elemRef, len(meta.Items))
	if arr.Result.ObjectID != "" && len(meta.Items) > 0 {
		var props struct {
			Result []struct {
				Name  string        `json:"name"`
				Value *remoteObject `json:"value"`
			} `json:"result"`
		}
		if err := s.bridge.CDPSession(ctx, tab, sessionID, "Runtime.getProperties", map[string]any{
			"objectId": arr.Result.ObjectID, "ownProperties": true,
		}, &props); err != nil {
			return nil, nil, err
		}
		for _, p := range props.Result {
			idx, err := strconv.Atoi(p.Name)
			if err != nil || idx < 0 || idx >= len(refs) || p.Value == nil {
				continue
			}
			refs[idx] = elemRef{sessionID: sessionID, objectID: p.Value.ObjectID}
		}
	}
	return meta, refs, nil
}

// resolveRef 取 ref 对应的元素定位信息。
func (s *Session) resolveRef(ref string) (elemRef, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refs.lookup(ref)
}

// interactionResult 交互后的状态回报。
func (s *Session) interactionResult(ctx context.Context, tab int, action string) string {
	time.Sleep(settleDelay)
	st, err := s.status(ctx, tab)
	if err != nil {
		return action + s.takeNotes()
	}
	out := fmt.Sprintf("%s;当前页面: %s(%s)", action, firstNonEmpty(st.Title, "(无标题)"), st.URL)
	if st.Gen == 0 {
		out += "\n页面已导航,元素引用已失效;如需继续交互请重新 browser_snapshot"
	}
	return out + s.takeNotes()
}

// elemRect 元素滚动进视口后的中心坐标。
type elemRect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// locate 主 target(含同进程 iframe)元素滚动进视口并取**主视口坐标**
// (供顶层 Input 真实鼠标点击)。坐标经 DOM.getBoxModel(objectId) 取得,
// 浏览器统一计算,自动含所有同进程 iframe 偏移。OOPIF 元素不走此路(用 DOM 点击)。
func (s *Session) locate(ctx context.Context, tab int, objID string) (elemRect, error) {
	// 先滚进视口(iframe 内元素 scrollIntoView 会滚对应 iframe;callFunctionOn
	// 在元素所属执行上下文运行,跨 iframe 自动正确)
	var connected *bool
	err := s.callOn(ctx, tab, "", objID, `function(){
		if (!this.isConnected) return null;
		this.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
		return true;
	}`, nil, &connected)
	if err != nil {
		return elemRect{}, err
	}
	if connected == nil {
		return elemRect{}, errRefStale("该元素")
	}
	var box struct {
		Model struct {
			Content []float64 `json:"content"`
			Width   float64   `json:"width"`
			Height  float64   `json:"height"`
		} `json:"model"`
	}
	if err := s.bridge.CDP(ctx, tab, "DOM.getBoxModel", map[string]any{"objectId": objID}, &box); err != nil {
		if isStaleObjectErr(err) {
			return elemRect{}, errRefStale("该元素")
		}
		return elemRect{}, err
	}
	q := box.Model.Content
	if len(q) < 8 || box.Model.Width <= 0 || box.Model.Height <= 0 {
		return elemRect{}, errRefStale("该元素")
	}
	// content 是内容盒的四角 [x1,y1,x2,y2,x3,y3,x4,y4](主视口坐标),取中心
	return elemRect{
		X: (q[0] + q[2] + q[4] + q[6]) / 4,
		Y: (q[1] + q[3] + q[5] + q[7]) / 4,
		W: box.Model.Width,
		H: box.Model.Height,
	}, nil
}

// click 点击 ref 元素。主 target(含同源 iframe)走真实鼠标事件(坐标经
// getBoxModel 统一计算);跨源 iframe(OOPIF)因跨进程坐标累加脆弱,退化为
// 在元素所在子会话执行 element.click()(合成事件,绝大多数按钮响应)。
func (s *Session) click(ctx context.Context, ref string) (string, error) {
	tab, err := s.ensureTab(ctx)
	if err != nil {
		return "", err
	}
	r, err := s.resolveRef(ref)
	if err != nil {
		return "", err
	}
	if r.sessionID == "" {
		rect, err := s.locate(ctx, tab, r.objectID)
		if err != nil {
			return "", err
		}
		for _, ev := range []map[string]any{
			{"type": "mouseMoved", "x": rect.X, "y": rect.Y},
			{"type": "mousePressed", "x": rect.X, "y": rect.Y, "button": "left", "clickCount": 1},
			{"type": "mouseReleased", "x": rect.X, "y": rect.Y, "button": "left", "clickCount": 1},
		} {
			if err := s.bridge.CDP(ctx, tab, "Input.dispatchMouseEvent", ev, nil); err != nil {
				return "", err
			}
		}
	} else {
		var ok *bool
		err = s.callOn(ctx, tab, r.sessionID, r.objectID, `function(){
			if (!this.isConnected) return null;
			this.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
			this.click();
			return true;
		}`, nil, &ok)
		if err != nil {
			return "", err
		}
		if ok == nil {
			return "", errRefStale(ref)
		}
	}
	return s.interactionResult(ctx, tab, fmt.Sprintf("已点击 %s", ref)), nil
}

// typeText 聚焦元素并输入文本(真实输入事件,框架监听可触发)。
func (s *Session) typeText(ctx context.Context, ref, text string, clear, submit bool) (string, error) {
	tab, err := s.ensureTab(ctx)
	if err != nil {
		return "", err
	}
	r, err := s.resolveRef(ref)
	if err != nil {
		return "", err
	}
	action := fmt.Sprintf("已在 %s 输入 %q", ref, truncate(text, 60))
	if r.sessionID != "" {
		// 跨源 iframe:顶层 Input 到不了子进程焦点,直接在子会话用 DOM 设值
		var ok *bool
		err = s.callOn(ctx, tab, r.sessionID, r.objectID, `function(text, clear, submit){
			if (!this.isConnected) return null;
			this.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
			this.focus();
			if ('value' in this) {
				this.value = clear ? text : (this.value + text);
			} else if (this.isContentEditable) {
				if (clear) this.textContent = '';
				this.textContent += text;
			}
			this.dispatchEvent(new Event('input', {bubbles: true}));
			this.dispatchEvent(new Event('change', {bubbles: true}));
			if (submit && this.form) this.form.requestSubmit ? this.form.requestSubmit() : this.form.submit();
			return true;
		}`, []any{text, clear, submit}, &ok)
		if err != nil {
			return "", err
		}
		if ok == nil {
			return "", errRefStale(ref)
		}
		if submit {
			action += " 并提交"
		}
		return s.interactionResult(ctx, tab, action), nil
	}

	// 主 target(含同源 iframe):真实输入事件
	var ok *bool
	err = s.callOn(ctx, tab, "", r.objectID, `function(clear){
		if (!this.isConnected) return null;
		this.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
		this.focus();
		if (clear) {
			if ('value' in this && typeof this.select === 'function') { this.select(); }
			else if (this.isContentEditable) { document.execCommand('selectAll', false, null); }
		}
		return true;
	}`, []any{clear}, &ok)
	if err != nil {
		return "", err
	}
	if ok == nil {
		return "", errRefStale(ref)
	}
	// 选中态下 insertText 覆盖旧值(等价清空)
	if err := s.bridge.CDP(ctx, tab, "Input.insertText", map[string]string{"text": text}, nil); err != nil {
		return "", err
	}
	if submit {
		if err := s.dispatchKey(ctx, tab, namedKeys["enter"], 0); err != nil {
			return "", err
		}
		action += " 并回车提交"
	}
	return s.interactionResult(ctx, tab, action), nil
}

// selectOption 设置 <select> 选中项(按 value 或可见文本匹配)。
func (s *Session) selectOption(ctx context.Context, ref string, values []string) (string, error) {
	tab, err := s.ensureTab(ctx)
	if err != nil {
		return "", err
	}
	r, err := s.resolveRef(ref)
	if err != nil {
		return "", err
	}
	var res *struct {
		Err string `json:"err"`
		Hit int    `json:"hit"`
	}
	err = s.callOn(ctx, tab, r.sessionID, r.objectID, `function(values){
		if (!this.isConnected) return null;
		if (this.tagName !== 'SELECT') return {err: 'not_select'};
		const want = new Set(values);
		let hit = 0;
		for (const o of this.options) {
			const on = want.has(o.value) || want.has(o.textContent.trim());
			if (!this.multiple && hit > 0 && on) continue;
			o.selected = on;
			if (on) hit++;
		}
		this.dispatchEvent(new Event('input', {bubbles: true}));
		this.dispatchEvent(new Event('change', {bubbles: true}));
		return {hit};
	}`, []any{values}, &res)
	if err != nil {
		return "", err
	}
	if res == nil {
		return "", errRefStale(ref)
	}
	if res.Err == "not_select" {
		return "", fmt.Errorf("%s 不是 <select> 元素;文本输入用 browser_type,点击用 browser_click", ref)
	}
	if res.Hit == 0 {
		return "", fmt.Errorf("没有匹配的选项(按 value 或可见文本精确匹配): %v;可先 browser_snapshot 查看", values)
	}
	return s.interactionResult(ctx, tab, fmt.Sprintf("已在 %s 选中 %d 项", ref, res.Hit)), nil
}

// pressKey 向焦点元素发送按键(支持 Control+A 等组合)。
func (s *Session) pressKey(ctx context.Context, combo string) (string, error) {
	tab, err := s.ensureTab(ctx)
	if err != nil {
		return "", err
	}
	def, mods, err := parseKeyCombo(combo)
	if err != nil {
		return "", err
	}
	if err := s.dispatchKey(ctx, tab, def, mods); err != nil {
		return "", err
	}
	return s.interactionResult(ctx, tab, fmt.Sprintf("已按下 %s", combo)), nil
}

// dispatchKey 完整按键序列 rawKeyDown → char(如有文本) → keyUp。
func (s *Session) dispatchKey(ctx context.Context, tab int, def keyDef, mods int) error {
	down := map[string]any{
		"type": "rawKeyDown", "modifiers": mods,
		"key": def.Key, "code": def.Code,
		"windowsVirtualKeyCode": def.KeyCode, "nativeVirtualKeyCode": def.KeyCode,
	}
	if err := s.bridge.CDP(ctx, tab, "Input.dispatchKeyEvent", down, nil); err != nil {
		return err
	}
	if def.Text != "" {
		char := map[string]any{"type": "char", "modifiers": mods, "text": def.Text,
			"key": def.Key, "windowsVirtualKeyCode": def.KeyCode}
		if err := s.bridge.CDP(ctx, tab, "Input.dispatchKeyEvent", char, nil); err != nil {
			return err
		}
	}
	up := map[string]any{
		"type": "keyUp", "modifiers": mods,
		"key": def.Key, "code": def.Code,
		"windowsVirtualKeyCode": def.KeyCode, "nativeVirtualKeyCode": def.KeyCode,
	}
	return s.bridge.CDP(ctx, tab, "Input.dispatchKeyEvent", up, nil)
}

// scroll 视口滚动一屏(direction)或滚动到元素(ref)。
func (s *Session) scroll(ctx context.Context, direction, ref string) (string, error) {
	tab, err := s.ensureTab(ctx)
	if err != nil {
		return "", err
	}
	if ref != "" {
		r, err := s.resolveRef(ref)
		if err != nil {
			return "", err
		}
		if r.sessionID == "" {
			if _, err := s.locate(ctx, tab, r.objectID); err != nil {
				return "", err
			}
		} else {
			// OOPIF:在子会话滚动元素进视口
			var ok *bool
			err = s.callOn(ctx, tab, r.sessionID, r.objectID, `function(){
				if (!this.isConnected) return null;
				this.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
				return true;
			}`, nil, &ok)
			if err != nil {
				return "", err
			}
			if ok == nil {
				return "", errRefStale(ref)
			}
		}
		return fmt.Sprintf("已滚动到 %s%s", ref, s.takeNotes()), nil
	}
	dir := 1
	if direction == "up" {
		dir = -1
	}
	var pos struct {
		Y    int `json:"y"`
		DocH int `json:"docH"`
		WinH int `json:"winH"`
	}
	expr := fmt.Sprintf(`(window.scrollBy({top: %d * innerHeight * 0.8, behavior: 'instant'}),
		{y: Math.round(scrollY), docH: Math.round(document.documentElement.scrollHeight), winH: innerHeight})`, dir)
	if err := s.eval(ctx, tab, expr, &pos); err != nil {
		return "", err
	}
	return fmt.Sprintf("已滚动,视口顶部在 %d/%dpx(视口高 %dpx);元素位置可能已变化,交互前建议重新 browser_snapshot%s",
		pos.Y, pos.DocH, pos.WinH, s.takeNotes()), nil
}

// screenshot 截图为图片块(视觉模型直接查看)。
func (s *Session) screenshot(ctx context.Context, fullPage bool) ([]provider.ContentBlock, string, error) {
	tab, err := s.ensureTab(ctx)
	if err != nil {
		return nil, "", err
	}
	params := map[string]any{"format": "png"}
	if fullPage {
		params["captureBeyondViewport"] = true
	}
	var res struct {
		Data string `json:"data"`
	}
	if err := s.bridge.CDP(ctx, tab, "Page.captureScreenshot", params, &res); err != nil {
		return nil, "", err
	}
	raw, err := base64.StdEncoding.DecodeString(res.Data)
	if err != nil {
		return nil, "", fmt.Errorf("截图数据解码失败: %w", err)
	}
	block, dims, err := tools.ImageBlockFromBytes(raw, "image/png")
	if err != nil {
		return nil, "", fmt.Errorf("截图处理失败: %w", err)
	}
	st, _ := s.status(ctx, tab)
	note := fmt.Sprintf("截图: %s(%s,%s)", firstNonEmpty(st.Title, "当前页面"), st.URL, dims)
	blocks := []provider.ContentBlock{block, {Type: provider.BlockText, Text: note + s.takeNotes()}}
	return blocks, note, nil
}

// tabsOp 标签页管理。
func (s *Session) tabsOp(ctx context.Context, action string, tabID int, rawURL string) (string, error) {
	if err := s.ensure(ctx); err != nil {
		return "", err
	}
	switch action {
	case "list", "":
		tabs, err := s.bridge.TabsList(ctx)
		if err != nil {
			return "", err
		}
		return s.formatTabs(tabs), nil
	case "new":
		if rawURL == "" {
			rawURL = "about:blank"
		}
		if err := validateURL(rawURL); err != nil {
			return "", err
		}
		id, err := s.bridge.TabsCreate(ctx, rawURL)
		if err != nil {
			return "", err
		}
		s.bridge.ClaimTab(id, s.owner)
		s.mu.Lock()
		s.tabs[id] = true
		s.tabID = id
		s.refs.invalidate()
		s.mu.Unlock()
		_ = s.bridge.CDP(ctx, id, "Page.enable", nil, nil)
		s.waitLoaded(ctx, id, navTimeout)
		return fmt.Sprintf("已新建标签页 #%d(%s)并设为当前%s", id, rawURL, s.takeNotes()), nil
	case "select":
		if tabID == 0 {
			return "", fmt.Errorf("select 需要 tab_id(先用 action=list 查看)")
		}
		// attach 由扩展校验受控集合;未受控标签页会返回引导文案
		if err := s.bridge.Attach(ctx, tabID); err != nil {
			return "", err
		}
		s.bridge.ClaimTab(tabID, s.owner)
		s.mu.Lock()
		s.tabs[tabID] = true
		s.tabID = tabID
		s.refs.invalidate()
		s.mu.Unlock()
		_ = s.bridge.CDP(ctx, tabID, "Page.enable", nil, nil)
		return s.pageBrief(ctx, tabID)
	case "close":
		if tabID == 0 {
			return "", fmt.Errorf("close 需要 tab_id")
		}
		if err := s.bridge.TabsClose(ctx, tabID); err != nil {
			return "", err
		}
		s.bridge.ReleaseTab(tabID)
		s.mu.Lock()
		delete(s.tabs, tabID)
		if s.tabID == tabID {
			s.tabID = 0
			s.refs.invalidate()
		}
		s.mu.Unlock()
		return fmt.Sprintf("已关闭标签页 #%d%s", tabID, s.takeNotes()), nil
	default:
		return "", fmt.Errorf("未知 action %q(支持 list/new/select/close)", action)
	}
}

// formatTabs 标签页列表文本。
func (s *Session) formatTabs(tabs []TabInfo) string {
	s.mu.Lock()
	current := s.tabID
	s.mu.Unlock()
	sort.Slice(tabs, func(i, j int) bool { return tabs[i].TabID < tabs[j].TabID })
	var b strings.Builder
	fmt.Fprintf(&b, "标签页(%d 个):\n", len(tabs))
	for _, t := range tabs {
		marks := ""
		if t.TabID == current {
			marks += "[当前]"
		}
		if t.Controlled {
			marks += "[受控]"
		} else {
			marks += "[未受控]"
		}
		fmt.Fprintf(&b, "#%d %s %s — %s\n", t.TabID, marks, firstNonEmpty(t.Title, "(无标题)"), t.URL)
	}
	b.WriteString("未受控的标签页需用户点击浏览器工具栏的 MonkeyCode 扩展图标交付后才能操作(select 仅对受控标签页有效)\n")
	return b.String() + s.takeNotes()
}
