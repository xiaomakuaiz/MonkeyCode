// browser_ 工具集:9 个工具共享同一 Session,全部串行(不实现 Parallelizable)。
package browser

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
)

// Tools 返回绑定到本会话的全部浏览器工具。
func (s *Session) Tools() []tools.Tool {
	return []tools.Tool{
		&navigateTool{s}, &snapshotTool{s}, &screenshotTool{s},
		&clickTool{s}, &typeTool{s}, &selectTool{s},
		&pressKeyTool{s}, &scrollTool{s}, &tabsTool{s},
	}
}

// 各工具内嵌 *Session:提升的 Close() 让 Registry.Close 链自动释放会话(幂等)。

func obj(props map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func str(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

// parseInput 解析入参(错误文案与内置工具一致口径)。
func parseInput(input json.RawMessage, v any) error {
	if len(input) == 0 {
		return nil
	}
	if err := json.Unmarshal(input, v); err != nil {
		return fmt.Errorf("工具参数 JSON 解析失败: %v。请修正参数后重试", err)
	}
	return nil
}

// ==================== browser_navigate ====================

type navigateTool struct{ *Session }

func (t *navigateTool) Name() string { return "browser_navigate" }
func (t *navigateTool) Description() string {
	return "在用户浏览器中打开网页(经 MonkeyCode 扩展控制,共享用户登录态)。无活动标签页时自动新建;url 填 \"back\" 表示后退。仅支持 http/https。"
}
func (t *navigateTool) InputSchema() map[string]any {
	return obj(map[string]any{"url": str("目标 URL;填 \"back\" 后退")}, "url")
}
func (t *navigateTool) Title(input json.RawMessage) string {
	var in struct {
		URL string `json:"url"`
	}
	_ = parseInput(input, &in)
	return "浏览器: 打开 " + truncate(in.URL, 60)
}
func (t *navigateTool) Execute(ctx context.Context, _ *tools.Env, input json.RawMessage) (string, error) {
	var in struct {
		URL string `json:"url"`
	}
	if err := parseInput(input, &in); err != nil {
		return "", err
	}
	if in.URL == "" {
		return "", fmt.Errorf("url 不能为空")
	}
	return t.navigate(ctx, in.URL)
}

// ==================== browser_snapshot ====================

type snapshotTool struct{ *Session }

func (t *snapshotTool) Name() string { return "browser_snapshot" }
func (t *snapshotTool) Description() string {
	return "获取当前页面快照:标题/URL/滚动位置 + 带编号(e1、e2...)的可交互元素列表。点击/输入等操作按编号定位元素;页面变化后需重新快照。"
}
func (t *snapshotTool) InputSchema() map[string]any  { return obj(map[string]any{}) }
func (t *snapshotTool) Title(json.RawMessage) string { return "浏览器: 页面快照" }
func (t *snapshotTool) Execute(ctx context.Context, _ *tools.Env, _ json.RawMessage) (string, error) {
	return t.snapshot(ctx)
}

// ==================== browser_take_screenshot ====================

type screenshotTool struct{ *Session }

func (t *screenshotTool) Name() string { return "browser_take_screenshot" }
func (t *screenshotTool) Description() string {
	return "截取当前页面为图片(视觉查看页面布局/图形内容;文字与可交互元素优先用 browser_snapshot,更省 token)。"
}
func (t *screenshotTool) InputSchema() map[string]any {
	return obj(map[string]any{
		"full_page": map[string]any{"type": "boolean", "description": "整页截图(默认仅当前视口)"},
	})
}
func (t *screenshotTool) Title(json.RawMessage) string { return "浏览器: 截图" }

// Execute BlocksTool 存在时 loop 不会调用;保留以满足 Tool 接口。
func (t *screenshotTool) Execute(ctx context.Context, env *tools.Env, input json.RawMessage) (string, error) {
	_, display, err := t.ExecuteBlocks(ctx, env, input)
	return display, err
}

func (t *screenshotTool) ExecuteBlocks(ctx context.Context, _ *tools.Env, input json.RawMessage) ([]provider.ContentBlock, string, error) {
	var in struct {
		FullPage bool `json:"full_page"`
	}
	if err := parseInput(input, &in); err != nil {
		return nil, "", err
	}
	return t.screenshot(ctx, in.FullPage)
}

// ==================== browser_click ====================

type clickTool struct{ *Session }

func (t *clickTool) Name() string { return "browser_click" }
func (t *clickTool) Description() string {
	return "点击页面元素(browser_snapshot 返回的编号,如 e3)。真实鼠标事件,自动滚动元素进视口。"
}
func (t *clickTool) InputSchema() map[string]any {
	return obj(map[string]any{"ref": str("元素编号,如 e3")}, "ref")
}
func (t *clickTool) Title(input json.RawMessage) string {
	var in struct {
		Ref string `json:"ref"`
	}
	_ = parseInput(input, &in)
	return "浏览器: 点击 " + in.Ref
}
func (t *clickTool) Execute(ctx context.Context, _ *tools.Env, input json.RawMessage) (string, error) {
	var in struct {
		Ref string `json:"ref"`
	}
	if err := parseInput(input, &in); err != nil {
		return "", err
	}
	if in.Ref == "" {
		return "", fmt.Errorf("ref 不能为空(browser_snapshot 返回的元素编号)")
	}
	return t.click(ctx, in.Ref)
}

// ==================== browser_type ====================

type typeTool struct{ *Session }

func (t *typeTool) Name() string { return "browser_type" }
func (t *typeTool) Description() string {
	return "在输入框中输入文本(按元素编号定位)。默认覆盖原值;submit=true 输入后按回车提交。"
}
func (t *typeTool) InputSchema() map[string]any {
	return obj(map[string]any{
		"ref":    str("元素编号,如 e3"),
		"text":   str("要输入的文本"),
		"clear":  map[string]any{"type": "boolean", "description": "先清空原值(默认 true)"},
		"submit": map[string]any{"type": "boolean", "description": "输入后按回车提交"},
	}, "ref", "text")
}
func (t *typeTool) Title(input json.RawMessage) string {
	var in struct {
		Ref  string `json:"ref"`
		Text string `json:"text"`
	}
	_ = parseInput(input, &in)
	return fmt.Sprintf("浏览器: 在 %s 输入 %s", in.Ref, truncate(in.Text, 30))
}
func (t *typeTool) Execute(ctx context.Context, _ *tools.Env, input json.RawMessage) (string, error) {
	in := struct {
		Ref    string `json:"ref"`
		Text   string `json:"text"`
		Clear  *bool  `json:"clear"`
		Submit bool   `json:"submit"`
	}{}
	if err := parseInput(input, &in); err != nil {
		return "", err
	}
	if in.Ref == "" {
		return "", fmt.Errorf("ref 不能为空")
	}
	clear := in.Clear == nil || *in.Clear
	return t.typeText(ctx, in.Ref, in.Text, clear, in.Submit)
}

// ==================== browser_select_option ====================

type selectTool struct{ *Session }

func (t *selectTool) Name() string { return "browser_select_option" }
func (t *selectTool) Description() string {
	return "设置下拉框(<select>)的选中项,按选项 value 或可见文本精确匹配。"
}
func (t *selectTool) InputSchema() map[string]any {
	return obj(map[string]any{
		"ref": str("元素编号,如 e3"),
		"values": map[string]any{"type": "array", "items": map[string]any{"type": "string"},
			"description": "要选中的选项(value 或可见文本)"},
	}, "ref", "values")
}
func (t *selectTool) Title(input json.RawMessage) string {
	var in struct {
		Ref string `json:"ref"`
	}
	_ = parseInput(input, &in)
	return "浏览器: 选择 " + in.Ref
}
func (t *selectTool) Execute(ctx context.Context, _ *tools.Env, input json.RawMessage) (string, error) {
	var in struct {
		Ref    string   `json:"ref"`
		Values []string `json:"values"`
	}
	if err := parseInput(input, &in); err != nil {
		return "", err
	}
	if in.Ref == "" || len(in.Values) == 0 {
		return "", fmt.Errorf("ref 与 values 均不能为空")
	}
	return t.selectOption(ctx, in.Ref, in.Values)
}

// ==================== browser_press_key ====================

type pressKeyTool struct{ *Session }

func (t *pressKeyTool) Name() string { return "browser_press_key" }
func (t *pressKeyTool) Description() string {
	return "向页面焦点元素发送按键,如 Enter、Escape、Tab、ArrowDown、PageDown,或组合键如 Control+A。"
}
func (t *pressKeyTool) InputSchema() map[string]any {
	return obj(map[string]any{"key": str("按键名或组合,如 Enter、Control+A")}, "key")
}
func (t *pressKeyTool) Title(input json.RawMessage) string {
	var in struct {
		Key string `json:"key"`
	}
	_ = parseInput(input, &in)
	return "浏览器: 按键 " + in.Key
}
func (t *pressKeyTool) Close() { t.Session.Close() }
func (t *pressKeyTool) Execute(ctx context.Context, _ *tools.Env, input json.RawMessage) (string, error) {
	var in struct {
		Key string `json:"key"`
	}
	if err := parseInput(input, &in); err != nil {
		return "", err
	}
	if in.Key == "" {
		return "", fmt.Errorf("key 不能为空")
	}
	return t.pressKey(ctx, in.Key)
}

// ==================== browser_scroll ====================

type scrollTool struct{ *Session }

func (t *scrollTool) Name() string { return "browser_scroll" }
func (t *scrollTool) Description() string {
	return "滚动页面:direction=up/down 翻一屏,或 ref 滚动到指定元素。"
}
func (t *scrollTool) InputSchema() map[string]any {
	return obj(map[string]any{
		"direction": map[string]any{"type": "string", "enum": []string{"up", "down"},
			"description": "滚动方向(与 ref 二选一)"},
		"ref": str("滚动到该元素(与 direction 二选一)"),
	})
}
func (t *scrollTool) Title(input json.RawMessage) string {
	var in struct {
		Direction string `json:"direction"`
		Ref       string `json:"ref"`
	}
	_ = parseInput(input, &in)
	if in.Ref != "" {
		return "浏览器: 滚动到 " + in.Ref
	}
	return "浏览器: 滚动 " + in.Direction
}
func (t *scrollTool) Execute(ctx context.Context, _ *tools.Env, input json.RawMessage) (string, error) {
	var in struct {
		Direction string `json:"direction"`
		Ref       string `json:"ref"`
	}
	if err := parseInput(input, &in); err != nil {
		return "", err
	}
	if in.Direction == "" && in.Ref == "" {
		in.Direction = "down"
	}
	return t.scroll(ctx, in.Direction, in.Ref)
}

// ==================== browser_tabs ====================

type tabsTool struct{ *Session }

func (t *tabsTool) Name() string { return "browser_tabs" }
func (t *tabsTool) Description() string {
	return "标签页管理:list 列出全部(含受控标注)、new 新建、select 切换到受控标签页、close 关闭。操作用户已打开的标签页需要用户先经扩展交付。"
}
func (t *tabsTool) InputSchema() map[string]any {
	return obj(map[string]any{
		"action": map[string]any{"type": "string", "enum": []string{"list", "new", "select", "close"},
			"description": "操作类型"},
		"tab_id": map[string]any{"type": "integer", "description": "目标标签页(select/close 必填)"},
		"url":    str("新标签页打开的地址(action=new 可选,默认空白页)"),
	}, "action")
}
func (t *tabsTool) Title(input json.RawMessage) string {
	var in struct {
		Action string `json:"action"`
		TabID  int    `json:"tab_id"`
	}
	_ = parseInput(input, &in)
	switch in.Action {
	case "new":
		return "浏览器: 新建标签页"
	case "select":
		return fmt.Sprintf("浏览器: 切换到标签页 #%d", in.TabID)
	case "close":
		return fmt.Sprintf("浏览器: 关闭标签页 #%d", in.TabID)
	default:
		return "浏览器: 标签页列表"
	}
}
func (t *tabsTool) Execute(ctx context.Context, _ *tools.Env, input json.RawMessage) (string, error) {
	var in struct {
		Action string `json:"action"`
		TabID  int    `json:"tab_id"`
		URL    string `json:"url"`
	}
	if err := parseInput(input, &in); err != nil {
		return "", err
	}
	return t.tabsOp(ctx, in.Action, in.TabID, in.URL)
}
