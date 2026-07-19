package browser

import (
	"fmt"
	"strings"
)

// keyDef 一个按键的 CDP Input.dispatchKeyEvent 参数。
type keyDef struct {
	Key     string // DOM key 值
	Code    string // 物理键 code
	KeyCode int    // windowsVirtualKeyCode
	Text    string // char 事件文本(可打印键/回车)
}

// 修饰键位掩码(CDP Input.dispatchKeyEvent modifiers)。
const (
	modAlt   = 1
	modCtrl  = 2
	modMeta  = 4
	modShift = 8
)

// namedKeys 常用命名键(键名不区分大小写)。
var namedKeys = map[string]keyDef{
	"enter":      {Key: "Enter", Code: "Enter", KeyCode: 13, Text: "\r"},
	"escape":     {Key: "Escape", Code: "Escape", KeyCode: 27},
	"esc":        {Key: "Escape", Code: "Escape", KeyCode: 27},
	"tab":        {Key: "Tab", Code: "Tab", KeyCode: 9},
	"backspace":  {Key: "Backspace", Code: "Backspace", KeyCode: 8},
	"delete":     {Key: "Delete", Code: "Delete", KeyCode: 46},
	"space":      {Key: " ", Code: "Space", KeyCode: 32, Text: " "},
	"arrowup":    {Key: "ArrowUp", Code: "ArrowUp", KeyCode: 38},
	"arrowdown":  {Key: "ArrowDown", Code: "ArrowDown", KeyCode: 40},
	"arrowleft":  {Key: "ArrowLeft", Code: "ArrowLeft", KeyCode: 37},
	"arrowright": {Key: "ArrowRight", Code: "ArrowRight", KeyCode: 39},
	"pageup":     {Key: "PageUp", Code: "PageUp", KeyCode: 33},
	"pagedown":   {Key: "PageDown", Code: "PageDown", KeyCode: 34},
	"home":       {Key: "Home", Code: "Home", KeyCode: 36},
	"end":        {Key: "End", Code: "End", KeyCode: 35},
}

// parseKeyCombo 解析 "Enter"、"Control+A"、"Shift+Tab" 形态的按键描述,
// 返回按键定义与修饰键位掩码。
func parseKeyCombo(combo string) (keyDef, int, error) {
	parts := strings.Split(combo, "+")
	mods := 0
	keyPart := ""
	for i, p := range parts {
		p = strings.TrimSpace(p)
		lower := strings.ToLower(p)
		isLast := i == len(parts)-1
		switch lower {
		case "control", "ctrl":
			mods |= modCtrl
		case "alt":
			mods |= modAlt
		case "shift":
			mods |= modShift
		case "meta", "cmd", "command":
			mods |= modMeta
		default:
			if !isLast {
				return keyDef{}, 0, fmt.Errorf("无法识别的修饰键 %q(支持 Control/Alt/Shift/Meta)", p)
			}
			keyPart = p
		}
		if isLast && keyPart == "" {
			return keyDef{}, 0, fmt.Errorf("按键 %q 缺少主键(如 Control+A)", combo)
		}
	}
	if def, ok := namedKeys[strings.ToLower(keyPart)]; ok {
		return def, mods, nil
	}
	// 单字符键(字母/数字/符号)
	r := []rune(keyPart)
	if len(r) != 1 {
		return keyDef{}, 0, fmt.Errorf("不支持的按键 %q;支持单字符或 %s", keyPart, namedKeyList())
	}
	ch := r[0]
	def := keyDef{Key: string(ch), Text: string(ch)}
	if ch >= 'a' && ch <= 'z' {
		def.Code = "Key" + strings.ToUpper(string(ch))
		def.KeyCode = int(ch - 'a' + 'A')
	} else if ch >= 'A' && ch <= 'Z' {
		def.Code = "Key" + string(ch)
		def.KeyCode = int(ch)
	} else if ch >= '0' && ch <= '9' {
		def.Code = "Digit" + string(ch)
		def.KeyCode = int(ch)
	}
	// 带 Ctrl/Meta 的组合键不产生 char 文本(避免把字符输入进页面)
	if mods&(modCtrl|modMeta|modAlt) != 0 {
		def.Text = ""
	}
	return def, mods, nil
}

func namedKeyList() string {
	return "Enter/Escape/Tab/Backspace/Delete/Space/Arrow*/PageUp/PageDown/Home/End"
}
