package baizhi

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"time"
)

// 手机号/验证码格式(与移动端一致);服务端仍是权威校验,这里只挡明显笔误。
var (
	phoneRe = regexp.MustCompile(`^1[3-9]\d{9}$`)
	codeRe  = regexp.MustCompile(`^\d{4,6}$`)
)

// Routes 把百智云账号 API 挂到内核本地路由(带内核访问令牌鉴权;
// auth 即 server 的鉴权包装器)。UI 经这些端点驱动登录,凭证不出内核。
func (s *Service) Routes(mux *http.ServeMux, auth func(http.HandlerFunc) http.HandlerFunc) {
	mux.HandleFunc("POST /api/baizhi/send-code", auth(s.handleSendCode))
	mux.HandleFunc("POST /api/baizhi/login", auth(s.handleLogin))
	mux.HandleFunc("GET /api/baizhi/status", auth(s.handleStatus))
	mux.HandleFunc("POST /api/baizhi/logout", auth(s.handleLogout))
	mux.HandleFunc("POST /api/baizhi/wechat/start", auth(s.handleWechatStart))
	mux.HandleFunc("GET /api/baizhi/wechat/poll", auth(s.handleWechatPoll))
	mux.HandleFunc("POST /api/baizhi/sync", auth(s.handleSync))
}

// 发码含 PoW 求解 + 外网请求;登录同。给足超时但别无限等。
const upstreamTimeout = 60 * time.Second

func (s *Service) handleSendCode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !phoneRe.MatchString(req.Phone) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请输入有效的手机号"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), upstreamTimeout)
	defer cancel()
	if err := s.SendPhoneCode(ctx, req.Phone); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Service) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !phoneRe.MatchString(req.Phone) || !codeRe.MatchString(req.Code) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请输入有效的手机号和短信验证码"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), upstreamTimeout)
	defer cancel()
	if err := s.LoginPhone(ctx, req.Phone, req.Code); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Service) handleStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	loggedIn, profile, err := s.Status(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	resp := map[string]any{"logged_in": loggedIn, "host": s.baseHost()}
	if len(profile) > 0 {
		resp["profile"] = json.RawMessage(profile)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Service) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.Logout()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleSync 同步模型网关的模型清单与推理密钥。需已登录。
// 请求体可选 {known_keys:[…]}:UI 已持有的明文密钥,能对上网关就复用不新建。
func (s *Service) handleSync(w http.ResponseWriter, r *http.Request) {
	var req struct {
		KnownKeys []string `json:"known_keys"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req) // 空体/坏体等同无候选密钥
	// 多次网关往返,给足时间
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	res, err := s.Sync(ctx, req.KnownKeys)
	if err != nil {
		status := http.StatusBadGateway
		if isUnauthorized(err) {
			status = http.StatusUnauthorized
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
