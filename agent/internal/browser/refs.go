package browser

import "fmt"

// elemRef 一个元素引用的定位信息:objectId 定位远端对象;sessionId 非空时
// 该对象在跨源 iframe(OOPIF)的 flat 子会话里,CDP 命令须带此 sessionId。
type elemRef struct {
	sessionID string
	objectID  string
}

// refTable 元素引用表:snapshot 建立 "e1".."eN" → elemRef 映射,
// 页面导航/刷新即整表失效(交互工具据此报错引导重新 snapshot)。
type refTable struct {
	gen  int // 快照代号,与页面内 window.__mcAgentGen 对应
	refs map[string]elemRef
}

// errRefStale ref 失效的统一错误(模型收到后会重新 snapshot,闭环)。
func errRefStale(ref string) error {
	return fmt.Errorf("元素引用 %s 不存在或已过期(页面可能已导航/刷新/重渲染),请先调用 browser_snapshot 获取最新元素列表", ref)
}

// objectGroup 本代快照的 CDP 对象组名(整组释放防泄漏)。
func (t *refTable) objectGroup() string {
	return fmt.Sprintf("mc-gen-%d", t.gen)
}

// rebuild 用新一代映射整表替换。
func (t *refTable) rebuild(gen int, refs []elemRef) {
	t.gen = gen
	t.refs = make(map[string]elemRef, len(refs))
	for i, r := range refs {
		t.refs[fmt.Sprintf("e%d", i+1)] = r
	}
}

// lookup 按 ref 取定位信息。
func (t *refTable) lookup(ref string) (elemRef, error) {
	if t.refs == nil {
		return elemRef{}, fmt.Errorf("尚无元素快照,请先调用 browser_snapshot")
	}
	r, ok := t.refs[ref]
	if !ok {
		return elemRef{}, errRefStale(ref)
	}
	return r, nil
}

// invalidate 整表失效(主 frame 导航时调用)。
func (t *refTable) invalidate() {
	t.refs = nil
}
