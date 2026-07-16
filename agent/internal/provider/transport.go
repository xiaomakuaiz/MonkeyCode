package provider

import (
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// 内置 Mozilla CA 根证书包(https://curl.se/ca/cacert.pem)。
// 老系统(如未更新的 Win7)根证书库停在出厂状态,系统校验对现代 CA 链
// (Let's Encrypt 等)必然失败;系统校验不过时用内置根再验一次——仍是
// 完整的证书链与主机名校验,只是信任锚多一份,不降低安全性。
//
//go:embed cacert.pem
var embeddedCAPEM []byte

var embeddedRoots = sync.OnceValue(func() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(embeddedCAPEM)
	return pool
})

// newHTTPClient LLM 客户端共用的 HTTP 客户端。
// 总超时不设(流式长连接),连接与响应头超时由 Transport 控制。
// insecureTLS 为 true 时跳过全部证书校验(仅供自签名内网网关,配置层显式开启)。
func newHTTPClient(insecureTLS bool) *http.Client {
	tr := &http.Transport{ResponseHeaderTimeout: 60 * time.Second}
	if insecureTLS {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	} else {
		// InsecureSkipVerify 只是关闭默认校验,由 VerifyConnection 接管:
		// 先按系统根验,失败再按内置 Mozilla 根验,两者都完整校验链与主机名
		tr.TLSClientConfig = &tls.Config{
			InsecureSkipVerify: true,
			VerifyConnection:   verifySystemThenEmbedded,
		}
	}
	return &http.Client{Transport: tr}
}

func verifySystemThenEmbedded(cs tls.ConnectionState) error {
	return verifyPeer(cs, embeddedRoots())
}

// verifyPeer 先按系统根验证对端证书链,失败再按 fallback 根池验证。
// 两次都是完整的链与主机名校验(cs.ServerName 由 http.Transport 设置,
// 含 IP 直连场景,x509 对 IP 字符串同样校验 SAN)。
func verifyPeer(cs tls.ConnectionState, fallback *x509.CertPool) error {
	if len(cs.PeerCertificates) == 0 {
		return fmt.Errorf("对端未提供证书")
	}
	opts := x509.VerifyOptions{
		DNSName:       cs.ServerName,
		Intermediates: x509.NewCertPool(),
	}
	for _, c := range cs.PeerCertificates[1:] {
		opts.Intermediates.AddCert(c)
	}
	// 1. 系统根(保留企业自装根/中间人代理场景)
	sysErr := error(nil)
	if _, sysErr = cs.PeerCertificates[0].Verify(opts); sysErr == nil {
		return nil
	}
	// 2. fallback 根(内置 Mozilla 包,系统根库过旧的回退)
	opts.Roots = fallback
	if _, err := cs.PeerCertificates[0].Verify(opts); err == nil {
		return nil
	}
	return fmt.Errorf("证书校验失败(系统根: %v);如为自签名内网网关,可在模型高级配置开启跳过校验", sysErr)
}
