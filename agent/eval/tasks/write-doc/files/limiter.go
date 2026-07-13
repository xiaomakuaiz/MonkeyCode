package limiter

import "time"

// Limiter 简单令牌桶限流器。
type Limiter struct {
	tokens chan struct{}
}

// NewLimiter 创建容量为 n 的限流器;n <= 0 时按 1 处理。
func NewLimiter(n int) *Limiter {
	if n <= 0 {
		n = 1
	}
	l := &Limiter{tokens: make(chan struct{}, n)}
	for i := 0; i < n; i++ {
		l.tokens <- struct{}{}
	}
	return l
}

// Acquire 获取令牌,最多等待 d;成功返回 true。
func (l *Limiter) Acquire(d time.Duration) bool {
	select {
	case <-l.tokens:
		return true
	case <-time.After(d):
		return false
	}
}

// Release 归还令牌;多还的会被丢弃。
func (l *Limiter) Release() {
	select {
	case l.tokens <- struct{}{}:
	default:
	}
}
