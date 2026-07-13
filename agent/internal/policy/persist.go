package policy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
)

// projectRules 项目级持久化权限规则(<工作区>/.mc-agent/permissions.json)。
// key 与会话内记忆同构:工具名、"bash:<命令首词>"、"mcp__server__tool"。
type projectRules struct {
	Allow []string `json:"allow,omitempty"`
	Deny  []string `json:"deny,omitempty"`
}

func rulesPath(workdir string) string {
	return filepath.Join(workdir, ".mc-agent", "permissions.json")
}

func loadProjectRules(workdir string) projectRules {
	var r projectRules
	data, err := os.ReadFile(rulesPath(workdir))
	if err != nil {
		return r
	}
	_ = json.Unmarshal(data, &r)
	return r
}

// saveProjectRule 追加一条规则(去重;allow/deny 互斥,后写覆盖)。
func saveProjectRule(workdir, key string, d Decision) error {
	r := loadProjectRules(workdir)
	r.Allow = slices.DeleteFunc(r.Allow, func(s string) bool { return s == key })
	r.Deny = slices.DeleteFunc(r.Deny, func(s string) bool { return s == key })
	switch d {
	case Allow:
		r.Allow = append(r.Allow, key)
	case Deny:
		r.Deny = append(r.Deny, key)
	}
	slices.Sort(r.Allow)
	slices.Sort(r.Deny)

	p := rulesPath(workdir)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}
