package provider

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// 自签名 HTTPS 服务(httptest 的证书不在任何根池里)。
func newSelfSignedServer(t *testing.T) *httptest.Server {
	t.Helper()
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)
	return ts
}

func TestHTTPClient_RejectsSelfSigned(t *testing.T) {
	ts := newSelfSignedServer(t)
	c := newHTTPClient(false)
	if _, err := c.Get(ts.URL); err == nil {
		t.Fatal("自签名证书应被拒绝(系统根与内置根都不认)")
	}
}

func TestHTTPClient_InsecureSkipsVerify(t *testing.T) {
	ts := newSelfSignedServer(t)
	c := newHTTPClient(true)
	resp, err := c.Get(ts.URL)
	if err != nil {
		t.Fatalf("insecure 模式应放行自签名: %v", err)
	}
	resp.Body.Close()
}

// TestVerifyPeer_FallbackRoots 系统根验不过、fallback 根池认得时放行
// (即内置 Mozilla 根兜底老系统过旧根库的机制)。
func TestVerifyPeer_FallbackRoots(t *testing.T) {
	ts := newSelfSignedServer(t)
	pool := x509.NewCertPool()
	pool.AddCert(ts.Certificate())

	c := &http.Client{Transport: &http.Transport{
		ResponseHeaderTimeout: 10 * time.Second,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
			VerifyConnection: func(cs tls.ConnectionState) error {
				return verifyPeer(cs, pool)
			},
		},
	}}
	resp, err := c.Get(ts.URL)
	if err != nil {
		t.Fatalf("fallback 根池应放行: %v", err)
	}
	resp.Body.Close()

	// 同一机制,空 fallback 池必须拒绝
	empty := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
			VerifyConnection: func(cs tls.ConnectionState) error {
				return verifyPeer(cs, x509.NewCertPool())
			},
		},
	}}
	if _, err := empty.Get(ts.URL); err == nil {
		t.Fatal("空 fallback 池应拒绝")
	}
}

func TestEmbeddedRootsLoaded(t *testing.T) {
	if embeddedRoots().Equal(x509.NewCertPool()) {
		t.Fatal("内置 CA 包解析为空(cacert.pem 损坏?)")
	}
}
