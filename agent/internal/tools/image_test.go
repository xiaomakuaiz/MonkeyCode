package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/chaitin/MonkeyCode/agent/internal/provider"
)

func writeTestPNG(t *testing.T, path string, w, h int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y += 10 {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: 200, G: 40, B: 40, A: 255})
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}

// ==================== read_file 图片分支:返回图片块 + 超限缩放 ====================

func TestReadFile_ImageBlocks(t *testing.T) {
	dir := t.TempDir()
	writeTestPNG(t, filepath.Join(dir, "big.png"), 2000, 1000)

	rf := &ReadFile{}
	env := &Env{Workdir: dir}
	blocks, display, err := rf.ExecuteBlocks(context.Background(), env, json.RawMessage(`{"path":"big.png"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 2 || blocks[0].Type != provider.BlockImage || blocks[1].Type != provider.BlockText {
		t.Fatalf("应为 [image, text] 两块,实际: %+v", blocks)
	}
	src := blocks[0].Source
	if src == nil || src.Type != "base64" || src.MediaType != "image/png" {
		t.Fatalf("图片 source 形状不对: %+v", src)
	}
	raw, err := base64.StdEncoding.DecodeString(src.Data)
	if err != nil {
		t.Fatal(err)
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 1568 || img.Bounds().Dy() != 784 {
		t.Fatalf("应等比缩放到 1568×784,实际 %dx%d", img.Bounds().Dx(), img.Bounds().Dy())
	}
	if display == "" || blocks[1].Text == "" {
		t.Fatalf("缺少展示说明: display=%q text=%q", display, blocks[1].Text)
	}
}

// 小图不缩放:原始字节直传
func TestReadFile_SmallImagePassthrough(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "small.png")
	writeTestPNG(t, p, 100, 60)
	orig, _ := os.ReadFile(p)

	rf := &ReadFile{}
	blocks, _, err := rf.ExecuteBlocks(context.Background(), &Env{Workdir: dir}, json.RawMessage(`{"path":"small.png"}`))
	if err != nil {
		t.Fatal(err)
	}
	got, _ := base64.StdEncoding.DecodeString(blocks[0].Source.Data)
	if string(got) != string(orig) {
		t.Fatal("尺寸合规的小图应原始字节直传")
	}
}

// 非图片文件仍走文本路径(单文本块)
func TestReadFile_TextUnaffected(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	rf := &ReadFile{}
	blocks, _, err := rf.ExecuteBlocks(context.Background(), &Env{Workdir: dir}, json.RawMessage(`{"path":"a.txt"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 || blocks[0].Type != provider.BlockText {
		t.Fatalf("文本文件应为单文本块: %+v", blocks)
	}
}

// 图片扩展名但文件不存在:报错口径与文本路径一致
func TestReadFile_MissingImage(t *testing.T) {
	rf := &ReadFile{}
	_, _, err := rf.ExecuteBlocks(context.Background(), &Env{Workdir: t.TempDir()}, json.RawMessage(`{"path":"no.png"}`))
	if err == nil {
		t.Fatal("不存在的图片应报错")
	}
}

// ==================== ImageBlockFromBytes:内存字节入口(MCP/浏览器截图共用) ====================

func encodeTestPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestImageBlockFromBytes_ScaleDown(t *testing.T) {
	block, dims, err := ImageBlockFromBytes(encodeTestPNG(t, 3136, 1568), "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if block.Type != provider.BlockImage || block.Source == nil {
		t.Fatalf("应为图片块: %+v", block)
	}
	raw, _ := base64.StdEncoding.DecodeString(block.Source.Data)
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 1568 || img.Bounds().Dy() != 784 {
		t.Fatalf("应缩放到 1568×784,实际 %dx%d", img.Bounds().Dx(), img.Bounds().Dy())
	}
	if dims != "1568×784,已缩放以适配模型" {
		t.Fatalf("dims 摘要不对: %q", dims)
	}
}

func TestImageBlockFromBytes_PassthroughAndMediaTypeInfer(t *testing.T) {
	src := encodeTestPNG(t, 80, 40)
	// mediaType 留空:按解码格式推断
	block, dims, err := ImageBlockFromBytes(src, "")
	if err != nil {
		t.Fatal(err)
	}
	if block.Source.MediaType != "image/png" {
		t.Fatalf("应推断为 image/png: %q", block.Source.MediaType)
	}
	got, _ := base64.StdEncoding.DecodeString(block.Source.Data)
	if !bytes.Equal(got, src) {
		t.Fatal("合规小图应原始字节直传")
	}
	if dims != "80×40" {
		t.Fatalf("dims 摘要不对: %q", dims)
	}
}

func TestImageBlockFromBytes_BadBytes(t *testing.T) {
	if _, _, err := ImageBlockFromBytes([]byte("not an image"), "image/png"); err == nil {
		t.Fatal("坏字节应报错")
	}
}
