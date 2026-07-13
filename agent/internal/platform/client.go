// Package platform 对接 MonkeyCode 平台的桌面端 API:
// 授权码登录(/api/v1/desktop/token)、运行时模型 key 换取(/runtime-key,
// LLM 流量走平台 LLMProxy 不旁路)、技能/规则下发(/agent-resources,
// 规则内联、技能 presigned zip 下载后本地缓存)。
package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client 平台 API 客户端。Token 为空时仅可调用 ExchangeCode。
type Client struct {
	BaseURL string // 平台地址,如 https://monkeycode.example.com
	Token   string // 桌面访问令牌(mcd_*)
	HTTP    *http.Client
}

// New 创建客户端,规范化 BaseURL(去尾部斜杠)。
func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTP:    &http.Client{Timeout: 30 * time.Second},
	}
}

// TokenResp 授权码换取的桌面令牌。
type TokenResp struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int64  `json:"expires_in"`
	User        struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"user"`
}

// RuntimeKey 运行时模型 key(短时效语义:每次任务启动重新换取,不落盘)。
type RuntimeKey struct {
	APIKey   string `json:"api_key"`
	Model    string `json:"model"`
	Protocol string `json:"protocol"` // anthropic | openai_chat | openai_responses
}

// Rule 平台下发的规则(内容内联)。
type Rule struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

// SkillRef 平台下发的技能引用(presigned zip)。
type SkillRef struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
	ZipURL      string `json:"zip_url"`
}

// Resources 平台技能/规则集合。
type Resources struct {
	Rules  []Rule     `json:"rules"`
	Skills []SkillRef `json:"skills"`
}

// AuthorizeURL 拼装浏览器授权地址。
func AuthorizeURL(platformURL, redirectURI, state string) string {
	q := url.Values{}
	q.Set("redirect_uri", redirectURI)
	q.Set("state", state)
	return strings.TrimRight(platformURL, "/") + "/api/v1/desktop/authorize?" + q.Encode()
}

// ExchangeCode 用一次性授权码换桌面令牌。
func (c *Client) ExchangeCode(ctx context.Context, code string) (*TokenResp, error) {
	var out TokenResp
	if err := c.call(ctx, http.MethodPost, "/api/v1/desktop/token", map[string]string{"code": code}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// FetchRuntimeKey 换取运行时模型 key;modelID 为空用平台默认模型。
func (c *Client) FetchRuntimeKey(ctx context.Context, modelID string) (*RuntimeKey, error) {
	var out RuntimeKey
	if err := c.call(ctx, http.MethodPost, "/api/v1/desktop/runtime-key", map[string]string{"model_id": modelID}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// FetchResources 拉取平台技能/规则。
func (c *Client) FetchResources(ctx context.Context) (*Resources, error) {
	var out Resources
	if err := c.call(ctx, http.MethodGet, "/api/v1/desktop/agent-resources", nil, &out); err != nil {
		return nil, err
	}
	if out.Rules == nil {
		out.Rules = []Rule{}
	}
	if out.Skills == nil {
		out.Skills = []SkillRef{}
	}
	return &out, nil
}

// call 发起请求并解开平台响应包壳 {code, message, data}。
func (c *Client) call(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("请求平台失败: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("平台鉴权失败(令牌过期?):请重新 mc-agent login")
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("平台返回 HTTP %d: %s", resp.StatusCode, truncate(string(data), 200))
	}

	var envelope struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return fmt.Errorf("平台响应解析失败: %w", err)
	}
	if envelope.Code != 0 {
		return fmt.Errorf("平台错误(code=%d): %s", envelope.Code, envelope.Message)
	}
	if out != nil && len(envelope.Data) > 0 {
		if err := json.Unmarshal(envelope.Data, out); err != nil {
			return fmt.Errorf("平台响应数据解析失败: %w", err)
		}
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
