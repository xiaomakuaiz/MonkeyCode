package browser

import (
	"strings"
	"testing"
)

func TestParseAndFormatSnapshot(t *testing.T) {
	raw := `{"url":"https://example.com/login","title":"登录页","scrollY":0,"winH":800,"docH":2400,
		"crossOriginIframes":1,"truncated":false,"gen":3,"items":[
		{"tag":"a","text":"首页","href":"/home"},
		{"tag":"button","text":"登录"},
		{"tag":"input","type":"text","text":"","value":"","ph":"用户名"},
		{"tag":"input","type":"checkbox","text":"记住我","checked":true},
		{"tag":"button","text":"发布","framed":true}
	]}`
	m, err := parseSnapshotMeta(raw)
	if err != nil {
		t.Fatal(err)
	}
	if m.Gen != 3 || len(m.Items) != 5 {
		t.Fatalf("元数据解析不对: %+v", m)
	}
	out := formatSnapshot(m)
	for _, want := range []string{
		"页面: 登录页", "URL: https://example.com/login",
		"e1 [a] \"首页\" → /home",
		"e2 [button] \"登录\"",
		"e3 [input:text]", "占位:\"用户名\"",
		"e4 [input:checkbox]", "[已勾选]",
		"e5 [button] \"发布\" (iframe 内)",
		"滚动: 视口顶部在 0/2400px",
		"1 个跨源 iframe",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("快照缺少 %q,实际:\n%s", want, out)
		}
	}
}

func TestFormatSnapshot_Truncated(t *testing.T) {
	m := &snapshotMeta{Truncated: true}
	if !strings.Contains(formatSnapshot(m), "仅列出前 150 个") {
		t.Fatal("截断提示缺失")
	}
}

func TestRefTable(t *testing.T) {
	var rt refTable
	if _, err := rt.lookup("e1"); err == nil {
		t.Fatal("无快照时 lookup 应报错")
	}
	rt.rebuild(2, []string{"obj-a", "obj-b"})
	if rt.objectGroup() != "mc-gen-2" {
		t.Fatalf("对象组名不对: %s", rt.objectGroup())
	}
	id, err := rt.lookup("e2")
	if err != nil || id != "obj-b" {
		t.Fatalf("lookup e2: %q %v", id, err)
	}
	if _, err := rt.lookup("e3"); err == nil {
		t.Fatal("越界 ref 应报失效错")
	}
	rt.invalidate()
	if _, err := rt.lookup("e1"); err == nil {
		t.Fatal("失效后 lookup 应报错")
	}
}

func TestParseKeyCombo(t *testing.T) {
	def, mods, err := parseKeyCombo("Enter")
	if err != nil || def.Key != "Enter" || def.KeyCode != 13 || def.Text != "\r" || mods != 0 {
		t.Fatalf("Enter: %+v mods=%d err=%v", def, mods, err)
	}
	def, mods, err = parseKeyCombo("Control+A")
	if err != nil || mods != modCtrl || def.Code != "KeyA" || def.Text != "" {
		t.Fatalf("Control+A: %+v mods=%d err=%v(组合键不应产生 char 文本)", def, mods, err)
	}
	_, mods, err = parseKeyCombo("shift+Tab")
	if err != nil || mods != modShift {
		t.Fatalf("shift+Tab: mods=%d err=%v", mods, err)
	}
	if _, _, err := parseKeyCombo("Foo+Bar"); err == nil {
		t.Fatal("未知修饰键应报错")
	}
	if _, _, err := parseKeyCombo("F13"); err == nil {
		t.Fatal("不支持的键名应报错")
	}
	def, _, err = parseKeyCombo("a")
	if err != nil || def.Text != "a" || def.KeyCode != 'A' {
		t.Fatalf("单字符键: %+v err=%v", def, err)
	}
}

func TestValidateURL(t *testing.T) {
	for _, ok := range []string{"https://a.com", "http://127.0.0.1:3000/x", "about:blank"} {
		if err := validateURL(ok); err != nil {
			t.Fatalf("%s 应放行: %v", ok, err)
		}
	}
	for _, bad := range []string{"chrome://settings", "file:///etc/passwd", "javascript:alert(1)", "ftp://x"} {
		if err := validateURL(bad); err == nil {
			t.Fatalf("%s 应拒绝", bad)
		}
	}
}
