package baizhi

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
)

// 黄金值由移动端 JS 实现(mobile/src/api/captcha.ts 算法)生成,
// 钉住与 go-cap / 移动端的跨实现一致性;算法任何一处漂移都会在此爆炸。
func TestPRNGGolden(t *testing.T) {
	if got := prng("test-seed", 40); got != "cd3e30df6f9f7ced8051016cafe6fb126014e950" {
		t.Fatalf("prng 漂移: %s", got)
	}
	const token = "a3f9c2e8b1d07654"
	cases := []struct {
		idx    int
		salt   string
		target string
		nonce  int
	}{
		{1, "6178e2c6d9239696d5d16eaef89e872c", "c33", 557},
		{2, "3eb0fb4a1aecdf66a10ba326788e3bb1", "f6e", 601},
		{3, "a09cbd1ed0d3b6a166ff71e290adc5e3", "7a9", 6458},
	}
	for _, c := range cases {
		if got := prng(token+strconv.Itoa(c.idx), 32); got != c.salt {
			t.Errorf("salt[%d] 漂移: %s", c.idx, got)
		}
		if got := prng(token+strconv.Itoa(c.idx)+"d", 3); got != c.target {
			t.Errorf("target[%d] 漂移: %s", c.idx, got)
		}
		nonce, err := solveOne(c.salt, c.target)
		if err != nil {
			t.Fatalf("solveOne(%d): %v", c.idx, err)
		}
		if nonce != c.nonce {
			t.Errorf("nonce[%d] = %d, want %d", c.idx, nonce, c.nonce)
		}
	}
}

// 自验证:解出的 nonce 必须满足协议本身的校验条件(sha256 hex 前缀)。
func TestSolveChallengesSelfVerify(t *testing.T) {
	const token = "deadbeef00112233"
	ch := Challenge{C: 5, S: 32, D: 3}
	solutions, err := SolveChallenges(token, ch)
	if err != nil {
		t.Fatal(err)
	}
	if len(solutions) != ch.C {
		t.Fatalf("solutions 数量 %d != %d", len(solutions), ch.C)
	}
	for i, nonce := range solutions {
		idx := strconv.Itoa(i + 1)
		salt := prng(token+idx, ch.S)
		target := prng(token+idx+"d", ch.D)
		digest := sha256.Sum256([]byte(salt + strconv.Itoa(nonce)))
		if !strings.HasPrefix(hex.EncodeToString(digest[:]), target) {
			t.Errorf("子质询 %d 的解 %d 未通过校验", i+1, nonce)
		}
	}
}

func TestHasHexPrefix(t *testing.T) {
	digest := sha256.Sum256([]byte("hello"))
	full := hex.EncodeToString(digest[:])
	for _, n := range []int{0, 1, 2, 3, 7} {
		if !hasHexPrefix(digest[:], full[:n]) {
			t.Errorf("前缀长 %d 应匹配", n)
		}
	}
	if hasHexPrefix(digest[:], "zzz") {
		t.Error("非法 hex 目标不应匹配")
	}
	bad := "f" + full[1:3]
	if full[0] == 'f' {
		bad = "0" + full[1:3]
	}
	if hasHexPrefix(digest[:], bad) {
		t.Error("错误前缀不应匹配")
	}
}
