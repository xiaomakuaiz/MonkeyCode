package browser

import "fmt"

// refTable 元素引用表:snapshot 建立 "e1".."eN" → CDP RemoteObjectId 映射,
// 页面导航/刷新即整表失效(交互工具据此报错引导重新 snapshot)。
type refTable struct {
	gen  int // 快照代号,与页面内 window.__mcAgentGen 对应
	refs map[string]string
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
func (t *refTable) rebuild(gen int, objectIDs []string) {
	t.gen = gen
	t.refs = make(map[string]string, len(objectIDs))
	for i, id := range objectIDs {
		t.refs[fmt.Sprintf("e%d", i+1)] = id
	}
}

// lookup 按 ref 取 RemoteObjectId。
func (t *refTable) lookup(ref string) (string, error) {
	if t.refs == nil {
		return "", fmt.Errorf("尚无元素快照,请先调用 browser_snapshot")
	}
	id, ok := t.refs[ref]
	if !ok {
		return "", errRefStale(ref)
	}
	return id, nil
}

// invalidate 整表失效(主 frame 导航时调用)。
func (t *refTable) invalidate() {
	t.refs = nil
}
