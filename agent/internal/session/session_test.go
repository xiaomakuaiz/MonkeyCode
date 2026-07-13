package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/chaitin/MonkeyCode/agent/internal/frame"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
)

// ==================== New + SaveMeta ====================

func TestNew_SaveMeta(t *testing.T) {
	root := t.TempDir()
	s, err := New(root, "/tmp/work", "test-model", "测试会话")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

	// 验证返回的 Meta
	if s.Meta.ID == "" {
		t.Fatal("ID 为空")
	}
	if s.Meta.Workdir != "/tmp/work" {
		t.Fatalf("Workdir = %q", s.Meta.Workdir)
	}
	if s.Meta.Model != "test-model" {
		t.Fatalf("Model = %q", s.Meta.Model)
	}
	if s.Meta.Title != "测试会话" {
		t.Fatalf("Title = %q", s.Meta.Title)
	}
	if s.Meta.Status != "created" {
		t.Fatalf("Status = %q", s.Meta.Status)
	}
	if s.Meta.CreatedAt.IsZero() || s.Meta.UpdatedAt.IsZero() {
		t.Fatal("时间戳为空")
	}

	// 验证 meta.json 落盘
	metaPath := filepath.Join(root, s.Meta.ID, "meta.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("读取 meta.json: %v", err)
	}
	var m Meta
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("解析 meta.json: %v", err)
	}
	if m.ID != s.Meta.ID || m.Title != s.Meta.Title {
		t.Fatal("meta.json 与内存不一致")
	}

	// 验证 events.jsonl 已创建
	eventsPath := filepath.Join(root, s.Meta.ID, "events.jsonl")
	if _, err := os.Stat(eventsPath); err != nil {
		t.Fatalf("events.jsonl 不存在: %v", err)
	}
}

// ==================== SaveMeta 更新 UpdatedAt ====================

func TestSaveMeta_UpdatesTimestamp(t *testing.T) {
	root := t.TempDir()
	s, err := New(root, "/tmp/w", "m", "t")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	first := s.Meta.UpdatedAt
	time.Sleep(10 * time.Millisecond)
	if err := s.SaveMeta(); err != nil {
		t.Fatal(err)
	}
	if !s.Meta.UpdatedAt.After(first) {
		t.Fatal("UpdatedAt 应更新")
	}
}

// ==================== Load 恢复会话 ====================

func TestLoad_Resume(t *testing.T) {
	root := t.TempDir()
	s1, err := New(root, "/tmp/w", "m", "loaded")
	if err != nil {
		t.Fatal(err)
	}
	id := s1.Meta.ID
	s1.Close()

	s2, err := Load(root, id)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	defer s2.Close()

	if s2.Meta.ID != id {
		t.Fatalf("ID 不匹配: %q vs %q", s2.Meta.ID, id)
	}
	if s2.Meta.Title != "loaded" {
		t.Fatalf("Title = %q", s2.Meta.Title)
	}
	if s2.Meta.Workdir != "/tmp/w" {
		t.Fatalf("Workdir = %q", s2.Meta.Workdir)
	}

	// 不存在的会话
	if _, err := Load(root, "nonexistent"); err == nil {
		t.Fatal("Load 不存在的会话应报错")
	}
}

// ==================== SaveMessages / LoadMessages 往返 ====================

func TestSaveMessages_LoadMessages_Roundtrip(t *testing.T) {
	root := t.TempDir()
	s, err := New(root, "/tmp/w", "m", "msg-test")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	msgs := []provider.Message{
		{Role: "user", Content: []provider.ContentBlock{{Type: "text", Text: "hello"}}},
		{Role: "assistant", Content: []provider.ContentBlock{{Type: "text", Text: "hi there"}}},
	}
	if err := s.SaveMessages(msgs); err != nil {
		t.Fatalf("SaveMessages: %v", err)
	}

	got, err := s.LoadMessages()
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].Role != "user" || got[1].Role != "assistant" {
		t.Fatal("角色不匹配")
	}
	if got[0].Content[0].Text != "hello" || got[1].Content[0].Text != "hi there" {
		t.Fatal("内容不匹配")
	}
}

// ==================== LoadMessages 无文件时返回 nil ====================

func TestLoadMessages_NoFile_ReturnsNil(t *testing.T) {
	root := t.TempDir()
	s, err := New(root, "/tmp/w", "m", "no-msg")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	// 确保 messages.json 不存在
	msgPath := filepath.Join(root, s.Meta.ID, "messages.json")
	os.Remove(msgPath)

	got, err := s.LoadMessages()
	if err != nil {
		t.Fatalf("LoadMessages 不应报错: %v", err)
	}
	if got != nil {
		t.Fatalf("无文件时应返回 nil, 实际: %v", got)
	}
}

// ==================== Emit 写入 events.jsonl ====================

func TestEmit_WritesEventsJSONL(t *testing.T) {
	root := t.TempDir()
	s, err := New(root, "/tmp/w", "m", "emit-test")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	var fb frame.Builder

	// 发射若干帧
	s.Emit(fb.TaskStarted())
	s.Emit(fb.AgentText("hello world"))
	s.Emit(fb.AgentThought("thinking..."))
	s.Emit(fb.TaskEnded())

	// 读取 events.jsonl,逐行解析
	eventsPath := filepath.Join(root, s.Meta.ID, "events.jsonl")
	data, err := os.ReadFile(eventsPath)
	if err != nil {
		t.Fatalf("读取 events.jsonl: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 4 {
		t.Fatalf("期望 4 行, 实际 %d 行", len(lines))
	}

	for i, line := range lines {
		var f frame.Frame
		if err := json.Unmarshal([]byte(line), &f); err != nil {
			t.Fatalf("第 %d 行解析失败: %v\n%s", i+1, err, line)
		}
		if f.Seq == 0 {
			t.Fatalf("第 %d 行 seq 为 0", i+1)
		}
		if f.Timestamp == 0 {
			t.Fatalf("第 %d 行 timestamp 为 0", i+1)
		}
	}
}

// ==================== List 按更新时间倒序 ====================

func TestList_SortedByUpdatedAtDesc(t *testing.T) {
	root := t.TempDir()

	// 创建多个会话(间隔以保证时间戳差异)
	s1, err := New(root, "/tmp/w1", "m1", "first")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	s1.SaveMeta() // 更新 UpdatedAt
	s1.Close()

	s2, err := New(root, "/tmp/w2", "m2", "second")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	s2.SaveMeta()
	s2.Close()

	s3, err := New(root, "/tmp/w3", "m3", "third")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	s3.SaveMeta()
	s3.Close()

	metas, err := List(root)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(metas) != 3 {
		t.Fatalf("len = %d, want 3", len(metas))
	}

	// 验证倒序
	for i := 1; i < len(metas); i++ {
		if metas[i-1].UpdatedAt.Before(metas[i].UpdatedAt) {
			t.Fatalf("第 %d 个更新于 %v, 第 %d 个更新于 %v, 未按倒序排列",
				i, metas[i-1].UpdatedAt, i+1, metas[i].UpdatedAt)
		}
	}

	// 第三个创建的应该是第一个
	if metas[0].Title != "third" {
		t.Fatalf("最新应是 'third', 实际 '%s'", metas[0].Title)
	}
}

// ==================== List 空目录或不存在目录 ====================

func TestList_EmptyOrMissingRoot(t *testing.T) {
	// 空目录
	root := t.TempDir()
	metas, err := List(root)
	if err != nil {
		t.Fatalf("空目录 List 不应报错: %v", err)
	}
	if len(metas) != 0 {
		t.Fatalf("空目录应返回空列表")
	}

	// 不存在的目录
	metas, err = List(filepath.Join(root, "nonexistent"))
	if err != nil {
		t.Fatalf("不存在的目录 List 不应报错: %v", err)
	}
	if metas != nil {
		t.Fatalf("不存在的目录应返回 nil")
	}
}
