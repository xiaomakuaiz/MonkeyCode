package baizhi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// TestWechatLoginFlow 假微信 + 假百智云:获取二维码 → 长轮询(等待→已扫→
// 确认出码)→ 内核走回调换会话 → 登录态确认。
func TestWechatLoginFlow(t *testing.T) {
	const (
		wxUUID  = "0919x3mp3yqAHa1j"
		wxCode  = "wxcode-e2e"
		session = "wx-sess-1"
	)
	var (
		bzURL    string
		state    string
		lpCalls  atomic.Int32
		loggedIn atomic.Bool
	)

	// 假微信(授权页 + 二维码 + 长轮询)
	wxMux := http.NewServeMux()
	wxMux.HandleFunc("GET /connect/qrconnect", func(w http.ResponseWriter, r *http.Request) {
		// 页面结构对齐真实抓取:img src 引用 /connect/qrcode/<uuid>
		fmt.Fprintf(w, `<html><body><img class="qrcode" src="/connect/qrcode/%s"></body></html>`, wxUUID)
	})
	wxMux.HandleFunc("GET /connect/qrcode/"+wxUUID, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		w.Write([]byte("\xff\xd8fake-jpeg"))
	})
	wxMux.HandleFunc("GET /connect/l/qrconnect", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("uuid") != wxUUID {
			fmt.Fprint(w, "window.wx_errcode=500;window.wx_code='';")
			return
		}
		// 第 1 次未扫码,第 2 次已扫码,第 3 次确认出码(真实序列)
		switch lpCalls.Add(1) {
		case 1:
			fmt.Fprint(w, "window.wx_errcode=408;window.wx_code='';")
		case 2:
			fmt.Fprint(w, "window.wx_errcode=404;window.wx_code='';")
		default:
			fmt.Fprintf(w, "window.wx_errcode=405;window.wx_code='%s';", wxCode)
		}
	})
	wxSrv := httptest.NewServer(wxMux)
	defer wxSrv.Close()

	// 假百智云(授权地址下发 + 回调 + profile)
	bzMux := http.NewServeMux()
	bzMux.HandleFunc("GET /api/v1/user/oauth/login", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("platform") != "wechat" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]any{"code": 400, "message": "invalid platform"})
			return
		}
		state = "st-42"
		authorize := fmt.Sprintf("%s/connect/qrconnect?appid=wx48&redirect_uri=%s&response_type=code&scope=snsapi_login&state=%s",
			wxSrv.URL, bzURL+"/api/v1/oauth/wechat/callback", state)
		json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]string{"url": authorize}})
	})
	bzMux.HandleFunc("GET /api/v1/oauth/wechat/callback", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("code") != wxCode || r.URL.Query().Get("state") != state {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]any{"code": 400, "message": "code/state 不匹配"})
			return
		}
		loggedIn.Store(true)
		http.SetCookie(w, &http.Cookie{Name: "baizhi_session", Value: session, Path: "/", HttpOnly: true})
		// 真实服务端会 302 回 redirect_url;验证不跟随重定向也能吸收 cookie
		w.Header().Set("Location", bzURL+"/")
		w.WriteHeader(http.StatusFound)
	})
	bzMux.HandleFunc("GET /api/v1/user/profile", func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("baizhi_session")
		if err != nil || !loggedIn.Load() || c.Value != session {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte("Unauthorized"))
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]string{"name": "微信用户"}})
	})
	bzSrv := httptest.NewServer(bzMux)
	defer bzSrv.Close()
	bzURL = bzSrv.URL

	s := newTestService(t, bzSrv.URL, "")
	s.lpOverride = wxSrv.URL // lp.<host> 在测试环境不可解析,直连假微信
	ctx := context.Background()

	qr, err := s.StartWechatLogin(ctx)
	if err != nil {
		t.Fatalf("StartWechatLogin: %v", err)
	}
	if !strings.HasPrefix(qr, "data:image/jpeg;base64,") {
		t.Fatalf("二维码应为 data URL: %.40s", qr)
	}

	for i, want := range []string{"waiting", "scanned", "ok"} {
		res, err := s.PollWechatLogin(ctx)
		if err != nil {
			t.Fatalf("poll %d: %v", i+1, err)
		}
		if res.Status != want {
			t.Fatalf("poll %d = %s, want %s", i+1, res.Status, want)
		}
	}

	ok, profile, err := s.Status(ctx)
	if err != nil || !ok {
		t.Fatalf("扫码登录后应为已登录: ok=%v err=%v", ok, err)
	}
	if !strings.Contains(string(profile), "微信用户") {
		t.Fatalf("profile 不对: %s", profile)
	}

	// 会话已消费:再 poll 应报"没有进行中的扫码会话"
	if _, err := s.PollWechatLogin(ctx); err == nil {
		t.Fatal("登录完成后继续 poll 应报错")
	}
}

// TestWechatPollExpired 二维码过期(402)与取消(403)映射。
func TestWechatPollStatusMapping(t *testing.T) {
	for errcode, want := range map[int]string{402: "expired", 500: "expired", 403: "canceled"} {
		wx := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, "window.wx_errcode=%d;window.wx_code='';", errcode)
		}))
		s := newTestService(t, "http://127.0.0.1:1", "") // baizhi 不会被访问
		s.lpOverride = wx.URL
		s.wx = &wechatLogin{uuid: "u", state: "s", callbackURL: "http://127.0.0.1:1/cb", lpBase: wx.URL}
		res, err := s.PollWechatLogin(context.Background())
		if err != nil {
			t.Fatalf("errcode=%d: %v", errcode, err)
		}
		if res.Status != want {
			t.Errorf("errcode=%d → %s, want %s", errcode, res.Status, want)
		}
		wx.Close()
	}
}
