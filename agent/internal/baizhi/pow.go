// Package baizhi 对接百智云(baizhi.cloud)账号体系:Cap.js PoW 验证码求解、
// 手机验证码登录、cookie 会话持久化。登录态供后续"自动同步模型与 MCP"使用
// (ai-api-gateway / agent-toolkit 两个子域,接口测绘后接入)。
//
// 协议参考移动端已验证实现(mobile/src/api/{captcha,baizhi}.ts),
// PoW 算法与服务端 github.com/ackcoder/go-cap 逐位对齐。
package baizhi

import (
	"crypto/sha256"
	"fmt"
	"strconv"
)

// Challenge PoW 质询参数:c 个子质询,盐长 s,目标前缀长 d(难度)。
type Challenge struct {
	C int `json:"c"`
	S int `json:"s"`
	D int `json:"d"`
}

// fnv1a32 FNV-1a 32 位哈希(按字节,对齐 JS charCodeAt(i)&0xff)。
func fnv1a32(seed string) uint32 {
	hash := uint32(0x811c9dc5)
	for i := 0; i < len(seed); i++ {
		hash ^= uint32(seed[i])
		hash *= 0x01000193
	}
	return hash
}

// prng 确定性十六进制串:FNV-1a 播种 + xorshift32,每轮输出 8 位 hex。
func prng(seed string, length int) string {
	state := fnv1a32(seed)
	var out []byte
	for len(out) < length {
		state ^= state << 13
		state ^= state >> 17
		state ^= state << 5
		out = append(out, fmt.Sprintf("%08x", state)...)
	}
	return string(out[:length])
}

const maxNonce = 5_000_000 // difficulty=3 一般几千次内命中,与移动端同上限

// solveOne 爆破单个子质询:找 nonce 使 sha256hex(salt+nonce) 以 target 为前缀。
func solveOne(salt, target string) (int, error) {
	buf := make([]byte, 0, len(salt)+8)
	buf = append(buf, salt...)
	for nonce := range maxNonce {
		digest := sha256.Sum256(strconv.AppendInt(buf[:len(salt)], int64(nonce), 10))
		if hasHexPrefix(digest[:], target) {
			return nonce, nil
		}
	}
	return 0, fmt.Errorf("验证码计算超时(nonce 上限 %d)", maxNonce)
}

// hasHexPrefix digest 的十六进制表示是否以 target 为前缀(逐 nibble 比对,
// 避免整段 hex 编码)。
func hasHexPrefix(digest []byte, target string) bool {
	for k := 0; k < len(target); k++ {
		b := digest[k/2]
		var nib byte
		if k%2 == 0 {
			nib = b >> 4
		} else {
			nib = b & 0x0f
		}
		want, ok := hexNibble(target[k])
		if !ok || nib != want {
			return false
		}
	}
	return true
}

func hexNibble(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	}
	return 0, false
}

// SolveChallenges 求解整组质询:第 i 个(1 起)的盐 = prng(token+i, s),
// 目标 = prng(token+i+"d", d)。返回 nonce 数组(与子质询顺序对应)。
func SolveChallenges(token string, ch Challenge) ([]int, error) {
	solutions := make([]int, ch.C)
	for i := range ch.C {
		idx := strconv.Itoa(i + 1)
		salt := prng(token+idx, ch.S)
		target := prng(token+idx+"d", ch.D)
		nonce, err := solveOne(salt, target)
		if err != nil {
			return nil, fmt.Errorf("子质询 %d: %w", i+1, err)
		}
		solutions[i] = nonce
	}
	return solutions, nil
}
