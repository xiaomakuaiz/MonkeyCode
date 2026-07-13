package platform

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"time"
)

// loginTimeout 等待浏览器回调的上限。
const loginTimeout = 5 * time.Minute

// LoginViaBrowser 桌面授权码登录:本机 loopback 起一次性回调监听 →
// 系统浏览器打开平台授权页 → 回调携 code → 换桌面令牌。
// 返回令牌与用户展示名。浏览器打不开时用户可手动访问打印的 URL。
func LoginViaBrowser(ctx context.Context, platformURL string) (*TokenResp, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("启动回调监听失败: %w", err)
	}
	defer ln.Close()

	state, err := randomState()
	if err != nil {
		return nil, err
	}
	redirectURI := fmt.Sprintf("http://%s/callback", ln.Addr().String())
	authURL := AuthorizeURL(platformURL, redirectURI, state)

	type result struct {
		code string
		err  error
	}
	ch := make(chan result, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/callback" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		if q.Get("state") != state {
			http.Error(w, "state 不匹配", http.StatusBadRequest)
			ch <- result{err: fmt.Errorf("回调 state 不匹配")}
			return
		}
		code := q.Get("code")
		if code == "" {
			http.Error(w, "缺少 code", http.StatusBadRequest)
			ch <- result{err: fmt.Errorf("回调缺少 code")}
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, "<html><body><h3>登录成功,可关闭此页面回到终端。</h3></body></html>")
		ch <- result{code: code}
	})}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	fmt.Println("在浏览器中完成登录(未自动打开请手动访问):")
	fmt.Println("  " + authURL)
	openBrowser(authURL)

	ctx, cancel := context.WithTimeout(ctx, loginTimeout)
	defer cancel()
	select {
	case <-ctx.Done():
		return nil, fmt.Errorf("等待登录超时或被取消")
	case r := <-ch:
		if r.err != nil {
			return nil, r.err
		}
		return New(platformURL, "").ExchangeCode(context.WithoutCancel(ctx), r.code)
	}
}

func randomState() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// openBrowser 尽力打开系统浏览器,失败静默(URL 已打印)。
func openBrowser(u string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", u)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	_ = cmd.Start()
}
