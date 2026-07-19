package baizhi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// fakeMonkeyCode 假 monkeycode 云端:登录入口 302 到百智授权页,回调校验
// code/state 后种会话 cookie,status/tasks 校验会话。与假百智(fakeOAuthBaizhi)
// 一起复刻真实桥接重定向链;两个 httptest 服务同 IP 不同端口,顺带钉住
// storeFor 按 host:port 分罐的行为。
type fakeMonkeyCode struct {
	t         *testing.T
	baizhiURL string // 假百智基址(启动后回填)
	selfURL   string
	authCode  string
	session   string
}

func (f *fakeMonkeyCode) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/users/login", func(w http.ResponseWriter, r *http.Request) {
		// 真实云端会 302 到百智"授权页"(非 API 路径),桥接方必须自行改写
		page := f.baizhiURL + "/oauth/authorize?client_id=cid-1&redirect_uri=" +
			url.QueryEscape(f.selfURL+"/api/v1/users/oauth/baizhi/callback") +
			"&scope=user&state=st-1"
		http.Redirect(w, r, page, http.StatusFound)
	})
	mux.HandleFunc("GET /api/v1/users/oauth/baizhi/callback", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("code") != f.authCode || r.URL.Query().Get("state") != "st-1" {
			http.Error(w, "bad code/state", http.StatusBadRequest)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "monkeycode_ai_session", Value: f.session, Path: "/"})
		http.Redirect(w, r, "/console/tasks", http.StatusFound)
	})
	mux.HandleFunc("GET /console/tasks", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("<html>console</html>"))
	})
	requireSession := func(r *http.Request) bool {
		c, err := r.Cookie("monkeycode_ai_session")
		return err == nil && c.Value == f.session
	}
	mux.HandleFunc("GET /api/v1/users/status", func(w http.ResponseWriter, r *http.Request) {
		if !requireSession(r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"code": 0,
			"data": map[string]any{"user": map[string]any{"id": "u-1", "name": "测试用户"}},
		})
	})
	mux.HandleFunc("GET /api/v1/users/tasks", func(w http.ResponseWriter, r *http.Request) {
		if !requireSession(r) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Query().Get("page") != "1" || r.URL.Query().Get("size") != "20" {
			http.Error(w, "bad page/size", http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"code": 0,
			"data": map[string]any{
				"tasks":     []map[string]any{{"id": "t-1", "title": "修复登录 bug", "status": "processing"}},
				"page_info": map[string]any{"total": 1},
			},
		})
	})
	return mux
}

// fakeOAuthBaizhi 假百智授权 API:校验会话 cookie 与授权参数,302 回调。
type fakeOAuthBaizhi struct {
	session  string
	authCode string
}

func (f *fakeOAuthBaizhi) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/oauth/authorize", func(w http.ResponseWriter, r *http.Request) {
		if c, err := r.Cookie("baizhi_session"); err != nil || c.Value != f.session {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]any{"code": 401, "message": "未登录"})
			return
		}
		q := r.URL.Query()
		if q.Get("client_id") != "cid-1" || q.Get("scope") != "user" ||
			q.Get("state") != "st-1" || q.Get("response_type") != "code" {
			http.Error(w, "bad authorize params", http.StatusBadRequest)
			return
		}
		redirect := q.Get("redirect_uri")
		if redirect == "" {
			http.Error(w, "missing redirect_uri", http.StatusBadRequest)
			return
		}
		sep := "?"
		if strings.Contains(redirect, "?") {
			sep = "&"
		}
		http.Redirect(w, r, redirect+sep+"code="+f.authCode+"&state="+q.Get("state"), http.StatusFound)
	})
	return mux
}

// newBridgeService 组装假云端 + 假百智 + Service;seedBaizhi 控制是否预置百智会话。
func newBridgeService(t *testing.T, seedBaizhi bool) (*Service, *fakeMonkeyCode) {
	t.Helper()
	bz := &fakeOAuthBaizhi{session: "bz-sess-1", authCode: "code-abc"}
	bzSrv := httptest.NewServer(bz.handler())
	t.Cleanup(bzSrv.Close)
	mc := &fakeMonkeyCode{t: t, baizhiURL: bzSrv.URL, authCode: "code-abc", session: "mc-sess-1"}
	mcSrv := httptest.NewServer(mc.handler())
	t.Cleanup(mcSrv.Close)
	mc.selfURL = mcSrv.URL

	s := NewServiceWithEndpoints(Endpoints{
		Account: bzSrv.URL, ModelGateway: bzSrv.URL, MCPGateway: bzSrv.URL, MonkeyCode: mcSrv.URL,
	}, "")
	if seedBaizhi {
		u, _ := url.Parse(bzSrv.URL)
		s.store.update(u, []*http.Cookie{{Name: "baizhi_session", Value: "bz-sess-1", Path: "/"}})
	}
	return s, mc
}

func TestLoginMonkeyCodeBridge(t *testing.T) {
	s, _ := newBridgeService(t, true)
	ctx := context.Background()

	user, err := s.LoginMonkeyCode(ctx)
	if err != nil {
		t.Fatalf("LoginMonkeyCode: %v", err)
	}
	var u struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(user, &u); err != nil || u.ID != "u-1" {
		t.Fatalf("用户信息不符: %s (err=%v)", user, err)
	}

	// 桥接成功后 status 应报已登录,且 mc 会话独立于百智罐
	loggedIn, _, err := s.MonkeyCodeStatus(ctx)
	if err != nil || !loggedIn {
		t.Fatalf("MonkeyCodeStatus: loggedIn=%v err=%v", loggedIn, err)
	}
	if s.mc.empty() {
		t.Fatal("云端会话应落在 mc 罐(storeFor 未按 host:port 分罐?)")
	}

	// 任务列表透传
	data, err := s.MonkeyCodeTasks(ctx, 1, 20)
	if err != nil {
		t.Fatalf("MonkeyCodeTasks: %v", err)
	}
	var tasks struct {
		Tasks []struct{ ID, Title, Status string } `json:"tasks"`
	}
	if err := json.Unmarshal(data, &tasks); err != nil || len(tasks.Tasks) != 1 || tasks.Tasks[0].ID != "t-1" {
		t.Fatalf("任务列表不符: %s (err=%v)", data, err)
	}

	// 百智登出不应牵连云端会话;云端登出后 status 回到未登录
	s.Logout()
	if loggedIn, _, _ := s.MonkeyCodeStatus(ctx); !loggedIn {
		t.Fatal("百智登出不应清掉云端会话")
	}
	s.MonkeyCodeLogout()
	if loggedIn, _, _ := s.MonkeyCodeStatus(ctx); loggedIn {
		t.Fatal("云端登出后应回到未登录")
	}
}

func TestLoginMonkeyCodeRequiresBaizhi(t *testing.T) {
	s, _ := newBridgeService(t, false)
	if _, err := s.LoginMonkeyCode(context.Background()); err == nil {
		t.Fatal("未登录百智云时桥接应报错")
	}
}

func TestLoginMonkeyCodeExpiredBaizhi(t *testing.T) {
	s, _ := newBridgeService(t, true)
	// 罐里换成过期值:授权 API 会 401,应转成"会话失效"语义(unauthorized)
	u, _ := url.Parse(s.ep.Account)
	s.store.update(u, []*http.Cookie{{Name: "baizhi_session", Value: "stale", Path: "/"}})
	_, err := s.LoginMonkeyCode(context.Background())
	if err == nil || !isUnauthorized(err) {
		t.Fatalf("百智会话失效应报 unauthorized,得到: %v", err)
	}
}
