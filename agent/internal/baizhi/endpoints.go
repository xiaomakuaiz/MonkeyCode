package baizhi

import (
	"os"
	"strings"
)

// Endpoints 百智云的三个可配地址。私有化部署时账号域、模型网关、MCP 网关
// 都会变(官方云是 baizhi.cloud 一族子域,私有化换成客户自己的域名),
// 因此三者独立可配,默认指向官方云。优先级:显式传入 > 环境变量 > 默认。
type Endpoints struct {
	// Account 账号/登录域(验证码、手机号/微信登录、profile)。
	Account string
	// ModelGateway 模型网关(大模型 API 管理网关):
	// /api/console/* 取 key 与模型列表;/api/openai、/api/anthropic 为推理 base_url。
	ModelGateway string
	// MCPGateway Agent 工具包(MCP 服务)。
	MCPGateway string
}

// 官方云默认地址。ai-models / model-square 是模型网关的历史别名,
// 统一收敛到 ai-api-gateway(与其前端 bundle 的 /api/console/* 契约一致)。
const (
	defaultAccount      = "https://baizhi.cloud"
	defaultModelGateway = "https://ai-api-gateway.app.baizhi.cloud"
	defaultMCPGateway   = "https://agent-toolkit.app.baizhi.cloud"
)

// resolveEndpoints 组装最终地址:入参为空则取环境变量,再空则取官方云默认。
// 环境变量:MC_AGENT_BAIZHI_URL(账号,保持既有名向后兼容)、
// MC_AGENT_BAIZHI_MODEL_GATEWAY、MC_AGENT_BAIZHI_MCP_GATEWAY。
func resolveEndpoints(in Endpoints) Endpoints {
	pick := func(explicit, env, def string) string {
		v := explicit
		if v == "" {
			v = os.Getenv(env)
		}
		if v == "" {
			v = def
		}
		return strings.TrimRight(v, "/")
	}
	return Endpoints{
		Account:      pick(in.Account, "MC_AGENT_BAIZHI_URL", defaultAccount),
		ModelGateway: pick(in.ModelGateway, "MC_AGENT_BAIZHI_MODEL_GATEWAY", defaultModelGateway),
		MCPGateway:   pick(in.MCPGateway, "MC_AGENT_BAIZHI_MCP_GATEWAY", defaultMCPGateway),
	}
}
