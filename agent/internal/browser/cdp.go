// CDP-over-bridge 薄客户端:内核经扩展桥对指定标签页执行 CDP 命令与
// tabs 管理。方法集刻意最小(v1 仅工具所需),不引第三方 CDP 库。
package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// callTimeout 单条指令默认超时(导航等待等长操作由调用方分段轮询)。
const callTimeout = 30 * time.Second

// CDP 执行一条 CDP 命令(标签页根会话);out 非 nil 时把 result 反序列化进去。
func (b *ExtBridge) CDP(ctx context.Context, tabID int, method string, params any, out any) error {
	return b.CDPSession(ctx, tabID, "", method, params, out)
}

// CDPSession 执行一条 CDP 命令;sessionID 非空时路由到跨源 iframe 子会话。
func (b *ExtBridge) CDPSession(ctx context.Context, tabID int, sessionID, method string, params any, out any) error {
	var raw json.RawMessage
	if params != nil {
		data, err := json.Marshal(params)
		if err != nil {
			return err
		}
		raw = data
	}
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	res, err := b.call(cctx, Request{Op: OpCDP, TabID: tabID, SessionID: sessionID, Method: method, Params: raw})
	if err != nil {
		return err
	}
	if out != nil && len(res) > 0 {
		if err := json.Unmarshal(res, out); err != nil {
			return fmt.Errorf("CDP %s 结果解析失败: %w", method, err)
		}
	}
	return nil
}

// FramesList 列出标签页当前的跨源 iframe(OOPIF)子会话。
func (b *ExtBridge) FramesList(ctx context.Context, tabID int) ([]FrameInfo, error) {
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	res, err := b.call(cctx, Request{Op: OpFramesList, TabID: tabID})
	if err != nil {
		return nil, err
	}
	var frames []FrameInfo
	if len(res) > 0 {
		if err := json.Unmarshal(res, &frames); err != nil {
			return nil, fmt.Errorf("frames.list 结果解析失败: %w", err)
		}
	}
	return frames, nil
}

// TabsCreate 新建标签页(自动 attach 并纳入受控集合),返回 tabId。
func (b *ExtBridge) TabsCreate(ctx context.Context, url string) (int, error) {
	params, _ := json.Marshal(map[string]string{"url": url})
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	res, err := b.call(cctx, Request{Op: OpTabsCreate, Params: params})
	if err != nil {
		return 0, err
	}
	var out struct {
		TabID int `json:"tabId"`
	}
	if err := json.Unmarshal(res, &out); err != nil || out.TabID == 0 {
		return 0, fmt.Errorf("tabs.create 结果无效: %s", res)
	}
	return out.TabID, nil
}

// TabsList 列出全部标签页(含受控标注)。
func (b *ExtBridge) TabsList(ctx context.Context) ([]TabInfo, error) {
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	res, err := b.call(cctx, Request{Op: OpTabsList})
	if err != nil {
		return nil, err
	}
	var tabs []TabInfo
	if err := json.Unmarshal(res, &tabs); err != nil {
		return nil, fmt.Errorf("tabs.list 结果解析失败: %w", err)
	}
	return tabs, nil
}

// TabsActivate 激活标签页并前置其窗口(截图与真实输入需要可见)。
func (b *ExtBridge) TabsActivate(ctx context.Context, tabID int) error {
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	_, err := b.call(cctx, Request{Op: OpTabsActivate, TabID: tabID})
	return err
}

// TabsClose 关闭受控标签页。
func (b *ExtBridge) TabsClose(ctx context.Context, tabID int) error {
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	_, err := b.call(cctx, Request{Op: OpTabsClose, TabID: tabID})
	return err
}

// Attach 附加 debugger(幂等;仅受控集合内的标签页允许)。
func (b *ExtBridge) Attach(ctx context.Context, tabID int) error {
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	_, err := b.call(cctx, Request{Op: OpAttach, TabID: tabID})
	return err
}

// Detach 剥离 debugger。
func (b *ExtBridge) Detach(ctx context.Context, tabID int) error {
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	_, err := b.call(cctx, Request{Op: OpDetach, TabID: tabID})
	return err
}
