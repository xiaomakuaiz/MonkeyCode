package platform

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakePlatform 模拟 MonkeyCode 平台的桌面端 API。
func fakePlatform(t *testing.T, skillZip []byte) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	var srv *httptest.Server

	ok := func(w http.ResponseWriter, data any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "message": "", "data": data})
	}

	mux.HandleFunc("POST /api/v1/desktop/token", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Code string `json:"code"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Code != "code-123" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		ok(w, map[string]any{
			"access_token": "mcd_test-token",
			"token_type":   "Bearer",
			"expires_in":   3600,
			"user":         map[string]any{"id": "u1", "name": "alice", "email": "a@b.c"},
		})
	})
	mux.HandleFunc("POST /api/v1/desktop/runtime-key", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mcd_test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		ok(w, map[string]any{"api_key": "rk-1", "model": "deepseek-v4-pro", "protocol": "anthropic"})
	})
	mux.HandleFunc("GET /api/v1/desktop/agent-resources", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mcd_test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		ok(w, map[string]any{
			"rules": []map[string]string{{"name": "team-style", "content": "所有导出函数必须有注释"}},
			"skills": []map[string]string{{
				"name": "deploy", "version": "v1", "description": "部署技能",
				"zip_url": srv.URL + "/zips/deploy.zip",
			}},
		})
	})
	mux.HandleFunc("GET /zips/deploy.zip", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(skillZip)
	})

	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func makeZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(content))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// withTempCache 把缓存目录指到临时目录(通过 XDG_CACHE_HOME)。
func withTempCache(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", dir)
	return dir
}

func TestExchangeCodeAndRuntimeKey(t *testing.T) {
	srv := fakePlatform(t, nil)

	tok, err := New(srv.URL, "").ExchangeCode(context.Background(), "code-123")
	if err != nil {
		t.Fatalf("ExchangeCode: %v", err)
	}
	if tok.AccessToken != "mcd_test-token" || tok.User.Name != "alice" {
		t.Fatalf("token resp: %+v", tok)
	}

	if _, err := New(srv.URL, "").ExchangeCode(context.Background(), "wrong"); err == nil {
		t.Fatal("wrong code should fail")
	}

	c := New(srv.URL, tok.AccessToken)
	rk, err := c.FetchRuntimeKey(context.Background(), "")
	if err != nil {
		t.Fatalf("FetchRuntimeKey: %v", err)
	}
	if rk.APIKey != "rk-1" || rk.Model != "deepseek-v4-pro" || rk.Protocol != "anthropic" {
		t.Fatalf("runtime key: %+v", rk)
	}

	// 令牌失效 → 明确的鉴权错误
	if _, err := New(srv.URL, "mcd_bad").FetchRuntimeKey(context.Background(), ""); err == nil ||
		!strings.Contains(err.Error(), "鉴权失败") {
		t.Fatalf("bad token error: %v", err)
	}
}

func TestSyncAndLoadCached(t *testing.T) {
	withTempCache(t)
	zipData := makeZip(t, map[string]string{
		"SKILL.md":       "# deploy skill",
		"scripts/run.sh": "echo hi",
	})
	srv := fakePlatform(t, zipData)

	c := New(srv.URL, "mcd_test-token")
	mat, err := c.Sync(context.Background())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if len(mat.Rules) != 1 || mat.Rules[0].Name != "team-style" {
		t.Fatalf("rules: %+v", mat.Rules)
	}
	if len(mat.Skills) != 1 {
		t.Fatalf("skills: %+v", mat.Skills)
	}
	s := mat.Skills[0]
	if s.Doc == "" || !strings.HasSuffix(s.Doc, "SKILL.md") {
		t.Fatalf("skill doc: %q", s.Doc)
	}
	if data, err := os.ReadFile(filepath.Join(s.Dir, "scripts", "run.sh")); err != nil || string(data) != "echo hi" {
		t.Fatalf("skill file: %v %q", err, data)
	}

	// 离线兜底:缓存可读且内容一致
	cached, err := LoadCached(srv.URL)
	if err != nil {
		t.Fatalf("LoadCached: %v", err)
	}
	if len(cached.Rules) != 1 || len(cached.Skills) != 1 || cached.Skills[0].Dir != s.Dir {
		t.Fatalf("cached: %+v", cached)
	}

	// 技能目录被清理后,缓存过滤失效项
	if err := os.RemoveAll(s.Dir); err != nil {
		t.Fatal(err)
	}
	cached, err = LoadCached(srv.URL)
	if err != nil {
		t.Fatalf("LoadCached after rm: %v", err)
	}
	if len(cached.Skills) != 0 {
		t.Fatalf("stale skill not filtered: %+v", cached.Skills)
	}
}

func TestUnzipRejectsZipSlip(t *testing.T) {
	dir := t.TempDir()
	evil := makeZip(t, map[string]string{"../evil.txt": "pwned"})
	if err := unzipTo(evil, filepath.Join(dir, "out")); err == nil {
		t.Fatal("zip-slip should be rejected")
	}
	if _, err := os.Stat(filepath.Join(dir, "evil.txt")); !os.IsNotExist(err) {
		t.Fatal("zip-slip file escaped")
	}
}

func TestUnzipRejectsTooManyFiles(t *testing.T) {
	files := map[string]string{}
	for i := range maxUnzipFiles + 1 {
		files[fmt.Sprintf("f%d.txt", i)] = "x"
	}
	if err := unzipTo(makeZip(t, files), t.TempDir()); err == nil {
		t.Fatal("too many files should be rejected")
	}
}

func TestAuthorizeURL(t *testing.T) {
	u := AuthorizeURL("https://mc.example.com/", "http://127.0.0.1:1234/callback", "st")
	if !strings.HasPrefix(u, "https://mc.example.com/api/v1/desktop/authorize?") ||
		!strings.Contains(u, "redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback") ||
		!strings.Contains(u, "state=st") {
		t.Fatalf("authorize url: %s", u)
	}
}
