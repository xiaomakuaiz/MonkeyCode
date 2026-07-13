package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// TodoEntry 计划条目。
type TodoEntry struct {
	Content string `json:"content"`
	Status  string `json:"status"` // pending | in_progress | completed
}

// Todo 任务计划管理(全量替换语义),条目变化通过 OnUpdate 外显为 plan 帧。
type Todo struct {
	mu       sync.Mutex
	entries  []TodoEntry
	OnUpdate func([]TodoEntry)
}

type todoInput struct {
	Entries []TodoEntry `json:"entries"`
}

func (t *Todo) Name() string { return "todo" }

func (t *Todo) Description() string {
	return "维护当前任务的执行计划清单。传入完整清单(全量替换)。" +
		"复杂任务开始时先列计划,每完成一步更新状态(pending/in_progress/completed)。"
}

func (t *Todo) InputSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"entries": map[string]any{
				"type":        "array",
				"description": "完整计划清单",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"content": map[string]any{"type": "string", "description": "条目内容"},
						"status":  map[string]any{"type": "string", "enum": []string{"pending", "in_progress", "completed"}},
					},
					"required": []string{"content", "status"},
				},
			},
		},
		"required": []string{"entries"},
	}
}

func (t *Todo) Title(input json.RawMessage) string {
	var in todoInput
	_ = json.Unmarshal(input, &in)
	done := 0
	for _, e := range in.Entries {
		if e.Status == "completed" {
			done++
		}
	}
	return fmt.Sprintf("更新计划(%d/%d 完成)", done, len(in.Entries))
}

// Entries 当前计划快照。
func (t *Todo) Entries() []TodoEntry {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]TodoEntry, len(t.entries))
	copy(out, t.entries)
	return out
}

func (t *Todo) Execute(_ context.Context, _ *Env, input json.RawMessage) (string, error) {
	var in todoInput
	if err := unmarshalInput(input, &in); err != nil {
		return "", err
	}
	for i, e := range in.Entries {
		if e.Status != "pending" && e.Status != "in_progress" && e.Status != "completed" {
			return "", fmt.Errorf("第 %d 条 status %q 无效,必须是 pending/in_progress/completed", i+1, e.Status)
		}
	}
	t.mu.Lock()
	t.entries = in.Entries
	cb := t.OnUpdate
	entries := make([]TodoEntry, len(in.Entries))
	copy(entries, in.Entries)
	t.mu.Unlock()

	if cb != nil {
		cb(entries)
	}

	var b strings.Builder
	b.WriteString("计划已更新:\n")
	for _, e := range entries {
		mark := map[string]string{"pending": "[ ]", "in_progress": "[~]", "completed": "[x]"}[e.Status]
		fmt.Fprintf(&b, "%s %s\n", mark, e.Content)
	}
	return b.String(), nil
}
