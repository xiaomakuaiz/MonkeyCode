package loop

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveToolImage(t *testing.T) {
	dir := t.TempDir()
	data := []byte("\x89PNG\r\n\x1a\nfake-bytes")

	rel, err := saveToolImage(dir, "toolu_ABC123", 0, "image/png", data)
	if err != nil {
		t.Fatal(err)
	}
	if rel != ".mc-agent/uploads/shot-toolu_ABC123-0.png" {
		t.Fatalf("相对路径不对: %q", rel)
	}
	// 文件落盘且内容一致
	got, err := os.ReadFile(filepath.Join(dir, rel))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(data) {
		t.Fatal("落盘内容与原始字节不一致")
	}
	// uploads 目录自带 .gitignore(不入库)
	if _, err := os.Stat(filepath.Join(dir, ".mc-agent", "uploads", ".gitignore")); err != nil {
		t.Fatal("uploads 目录缺少 .gitignore")
	}
}

func TestSaveToolImage_MediaTypeExt(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"image/jpeg":   ".jpg",
		"image/gif":    ".gif",
		"image/webp":   ".webp",
		"image/png":    ".png",
		"unknown/type": ".png", // 未知回退 png
	}
	i := 0
	for mime, wantExt := range cases {
		rel, err := saveToolImage(dir, "t", i, mime, []byte("x"))
		i++
		if err != nil {
			t.Fatal(err)
		}
		if filepath.Ext(rel) != wantExt {
			t.Fatalf("%s → 扩展名 %s,期望 %s", mime, filepath.Ext(rel), wantExt)
		}
	}
}

func TestSaveToolImage_NoWorkdir(t *testing.T) {
	if _, err := saveToolImage("", "t", 0, "image/png", []byte("x")); err == nil {
		t.Fatal("无工作区应报错(调用方降级不显示图)")
	}
}

func TestSanitizeToolID(t *testing.T) {
	if got := sanitizeToolID("toolu_A-9"); got != "toolu_A-9" {
		t.Fatalf("合法 ID 被改写: %q", got)
	}
	if got := sanitizeToolID("a/b\\c..d"); got != "abcd" {
		t.Fatalf("路径字符未净化: %q", got)
	}
	if got := sanitizeToolID("///"); got != "img" {
		t.Fatalf("全非法应回退 img: %q", got)
	}
}
