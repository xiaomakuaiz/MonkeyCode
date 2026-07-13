// 测试用最小 stdio MCP server:一个只读 echo 工具 + 一个报错工具。
package main

import (
	"context"
	"fmt"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type echoArgs struct {
	Text string `json:"text" jsonschema:"要回显的文本"`
}

func main() {
	s := sdk.NewServer(&sdk.Implementation{Name: "echo", Version: "0.0.1"}, nil)

	ro := true
	sdk.AddTool(s, &sdk.Tool{
		Name:        "echo",
		Description: "回显输入文本",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: ro},
	}, func(_ context.Context, _ *sdk.CallToolRequest, in echoArgs) (*sdk.CallToolResult, any, error) {
		return &sdk.CallToolResult{
			Content: []sdk.Content{&sdk.TextContent{Text: "echo: " + in.Text}},
		}, nil, nil
	})

	sdk.AddTool(s, &sdk.Tool{
		Name:        "boom",
		Description: "总是返回错误",
	}, func(_ context.Context, _ *sdk.CallToolRequest, _ echoArgs) (*sdk.CallToolResult, any, error) {
		return nil, nil, fmt.Errorf("故意失败")
	})

	if err := s.Run(context.Background(), &sdk.StdioTransport{}); err != nil {
		panic(err)
	}
}
