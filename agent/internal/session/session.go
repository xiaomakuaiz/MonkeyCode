// Package session 会话持久化:帧事件日志(JSONL)+ 对话消息快照,支持 resume。
package session

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/chaitin/MonkeyCode/agent/internal/frame"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/workspace"
)

// Meta 会话元信息。
// Status 状态机:created(新建)→ running(轮次执行中)→
// finished / interrupted / error(轮次终态);running 属于轮次生命周期,
// 进程异常退出遗留的 running 会被 serve 加载时判定为中断。
type Meta struct {
	ID        string         `json:"id"`
	Title     string         `json:"title"`
	Workdir   string         `json:"workdir"`
	Model     string         `json:"model"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	Turns     int            `json:"turns"`
	Status    string         `json:"status"` // created | running | finished | interrupted | error
	Usage     provider.Usage `json:"usage"`
	// Worktree 非空表示会话运行在隔离 worktree(Workdir 即 worktree 路径)。
	Worktree *workspace.Worktree `json:"worktree,omitempty"`
}

// Session 单个会话,持有打开的事件日志。
type Session struct {
	Meta Meta
	dir  string
	log  *os.File
}

// DefaultRoot 会话存储根目录。
func DefaultRoot() string {
	if v := os.Getenv("MC_AGENT_DATA_DIR"); v != "" {
		return filepath.Join(v, "sessions")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".local", "share", "mc-agent", "sessions")
}

// New 创建新会话。
func New(root, workdir, model, title string) (*Session, error) {
	id := newID()
	dir := filepath.Join(root, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Session{
		Meta: Meta{
			ID: id, Title: title, Workdir: workdir, Model: model,
			CreatedAt: time.Now(), UpdatedAt: time.Now(), Status: "created",
		},
		dir: dir,
	}
	if err := s.openLog(); err != nil {
		return nil, err
	}
	return s, s.SaveMeta()
}

// Load 加载既有会话(resume)。
func Load(root, id string) (*Session, error) {
	dir := filepath.Join(root, id)
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return nil, fmt.Errorf("会话 %s 不存在: %w", id, err)
	}
	var meta Meta
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, err
	}
	s := &Session{Meta: meta, dir: dir}
	return s, s.openLog()
}

// List 列出全部会话元信息(按更新时间倒序)。
func List(root string) ([]Meta, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var metas []Meta
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, e.Name(), "meta.json"))
		if err != nil {
			continue
		}
		var m Meta
		if json.Unmarshal(data, &m) == nil {
			metas = append(metas, m)
		}
	}
	sort.Slice(metas, func(i, j int) bool { return metas[i].UpdatedAt.After(metas[j].UpdatedAt) })
	return metas, nil
}

// EventsPath 事件日志文件路径。
func (s *Session) EventsPath() string {
	return filepath.Join(s.dir, "events.jsonl")
}

func (s *Session) openLog() error {
	f, err := os.OpenFile(filepath.Join(s.dir, "events.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	s.log = f
	return nil
}

// Emit 实现 frame.Emitter:帧写入事件日志。
func (s *Session) Emit(f frame.Frame) {
	if s.log == nil {
		return
	}
	data, err := json.Marshal(f)
	if err != nil {
		return
	}
	_, _ = s.log.Write(append(data, '\n'))
}

// SaveMessages 保存对话消息快照(resume 的数据源)。
func (s *Session) SaveMessages(msgs []provider.Message) error {
	data, err := json.Marshal(msgs)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.dir, "messages.json"), data)
}

// LoadMessages 读取对话消息快照。
func (s *Session) LoadMessages() ([]provider.Message, error) {
	data, err := os.ReadFile(filepath.Join(s.dir, "messages.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var msgs []provider.Message
	return msgs, json.Unmarshal(data, &msgs)
}

// SaveMeta 持久化元信息。
func (s *Session) SaveMeta() error {
	s.Meta.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(s.Meta, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.dir, "meta.json"), data)
}

// Close 关闭事件日志。
func (s *Session) Close() {
	if s.log != nil {
		_ = s.log.Close()
		s.log = nil
	}
}

func atomicWrite(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func newID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return time.Now().Format("20060102-150405") + "-" + hex.EncodeToString(b)
}
