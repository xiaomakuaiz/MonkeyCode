// 图片文件读取:read_file 的图片分支。解码 → 超限缩放 → 重编码为
// tool_result 图片块,供模型直接查看(Anthropic 原生;OpenAI 系协议由
// provider 层降级为合成 user 消息)。
package tools

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // 注册 webp 解码

	"github.com/chaitin/MonkeyCode/agent/internal/provider"
)

// imageMediaTypes 支持读取的图片扩展名 → MIME。
var imageMediaTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
}

const (
	imageMaxSrcBytes = 20 * 1024 * 1024 // 源文件上限
	imageMaxEdge     = 1568             // 超过则等比缩放(Anthropic 推荐的最优上限)
	imageMaxOutBytes = 4 * 1024 * 1024  // 编码后上限(留足 base64 膨胀余量)
)

// IsImagePath 路径是否为受支持的图片文件。
func IsImagePath(path string) bool {
	_, ok := imageMediaTypes[strings.ToLower(filepath.Ext(path))]
	return ok
}

// ReadImageBlocks 读取图片文件为 tool_result 内容块(图片块在前、说明文本在后)。
func ReadImageBlocks(path, displayPath string) ([]provider.ContentBlock, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	mediaType := imageMediaTypes[strings.ToLower(filepath.Ext(path))]
	block, dims, err := ImageBlockFromBytes(data, mediaType)
	if err != nil {
		return nil, "", fmt.Errorf("图片 %s: %w", displayPath, err)
	}
	note := fmt.Sprintf("图片 %s(%s)", displayPath, dims)
	blocks := []provider.ContentBlock{block, {Type: provider.BlockText, Text: note}}
	return blocks, note, nil
}

// ImageBlockFromBytes 把内存中的图片字节规范化为模型可用的图片块
// (解码 → 超限缩放 → 重编码);dims 为 "宽×高[,已缩放以适配模型]" 摘要,
// 供调用方拼展示文本。mediaType 可空(按解码格式推断)。
// MCP 图片结果与浏览器截图共用此入口。
func ImageBlockFromBytes(data []byte, mediaType string) (provider.ContentBlock, string, error) {
	if len(data) > imageMaxSrcBytes {
		return provider.ContentBlock{}, "", fmt.Errorf("图片过大(%d 字节,上限 %d)", len(data), imageMaxSrcBytes)
	}
	img, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return provider.ContentBlock{}, "", fmt.Errorf("解码图片失败: %w", err)
	}
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	if mediaType == "" {
		mediaType = "image/" + format
	}

	// 尺寸合规且体积可接受:原始字节直传,零损
	scaled := false
	out := data
	if max(w, h) > imageMaxEdge || len(data) > imageMaxOutBytes {
		img = scaleDown(img, imageMaxEdge)
		w, h = img.Bounds().Dx(), img.Bounds().Dy()
		out, mediaType, err = encodeImage(img, format)
		if err != nil {
			return provider.ContentBlock{}, "", fmt.Errorf("编码图片失败: %w", err)
		}
		scaled = true
	}

	dims := fmt.Sprintf("%d×%d", w, h)
	if scaled {
		dims += ",已缩放以适配模型"
	}
	block := provider.ContentBlock{Type: provider.BlockImage, Source: &provider.ImageSource{
		Type: "base64", MediaType: mediaType, Data: base64.StdEncoding.EncodeToString(out),
	}}
	return block, dims, nil
}

// scaleDown 等比缩放到最长边 ≤ maxEdge(CatmullRom,质量优先)。
func scaleDown(img image.Image, maxEdge int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if max(w, h) <= maxEdge {
		return img
	}
	var nw, nh int
	if w >= h {
		nw = maxEdge
		nh = h * maxEdge / w
	} else {
		nh = maxEdge
		nw = w * maxEdge / h
	}
	dst := image.NewRGBA(image.Rect(0, 0, max(nw, 1), max(nh, 1)))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
	return dst
}

// encodeImage 重编码:jpeg 源保持 jpeg;其余(png/gif/webp,可能含透明)先试
// png,超限再降级 jpeg。返回 (字节, mediaType)。
func encodeImage(img image.Image, srcFormat string) ([]byte, string, error) {
	var buf bytes.Buffer
	if srcFormat == "jpeg" {
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85}); err != nil {
			return nil, "", err
		}
		return buf.Bytes(), "image/jpeg", nil
	}
	if err := png.Encode(&buf, img); err != nil {
		return nil, "", err
	}
	if buf.Len() <= imageMaxOutBytes {
		return buf.Bytes(), "image/png", nil
	}
	buf.Reset()
	if err := jpeg.Encode(&buf, flattenAlpha(img), &jpeg.Options{Quality: 82}); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), "image/jpeg", nil
}

// flattenAlpha 把可能含透明的图像平铺到白底(jpeg 无 alpha 通道)。
func flattenAlpha(img image.Image) image.Image {
	b := img.Bounds()
	dst := image.NewRGBA(b)
	draw.Copy(dst, b.Min, image.White, b, draw.Src, nil)
	draw.Copy(dst, b.Min, img, b, draw.Over, nil)
	return dst
}

// 保持 gif 解码注册(image.Decode 取首帧)。
var _ = gif.Decode
