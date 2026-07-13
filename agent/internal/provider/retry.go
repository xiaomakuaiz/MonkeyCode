package provider

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

// RetryConfig 重试策略。
type RetryConfig struct {
	MaxAttempts int           // 总尝试次数(含首次)
	BaseDelay   time.Duration // 首次重试延迟,之后指数递增
	MaxDelay    time.Duration
	// OnRetry 每次重试前回调(attempt 从 1 开始计数)。
	OnRetry func(attempt int, err error)
}

// DefaultRetry 默认策略。
func DefaultRetry() RetryConfig {
	return RetryConfig{MaxAttempts: 5, BaseDelay: 2 * time.Second, MaxDelay: 30 * time.Second}
}

// StreamWithRetry 带退避重试的流式请求。
// 注意:流中途失败也会整次重试(请求是无副作用的)。
func StreamWithRetry(ctx context.Context, p Provider, req Request, h *StreamHandler, cfg RetryConfig) (*Result, error) {
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 1
	}
	var lastErr error
	delay := cfg.BaseDelay
	for attempt := 1; attempt <= cfg.MaxAttempts; attempt++ {
		res, err := p.Stream(ctx, req, h)
		if err == nil {
			return res, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if !retryable(err) || attempt == cfg.MaxAttempts {
			return nil, err
		}
		if cfg.OnRetry != nil {
			cfg.OnRetry(attempt, err)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
		delay *= 2
		if cfg.MaxDelay > 0 && delay > cfg.MaxDelay {
			delay = cfg.MaxDelay
		}
	}
	return nil, fmt.Errorf("llm request failed after %d attempts: %w", cfg.MaxAttempts, lastErr)
}

func retryable(err error) bool {
	var he *HTTPError
	if errors.As(err, &he) {
		return he.Retryable()
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return true
	}
	// 流中途断开等网络类错误
	msg := err.Error()
	for _, s := range []string{"connection reset", "EOF", "broken pipe", "read stream", "stream ended without"} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}
