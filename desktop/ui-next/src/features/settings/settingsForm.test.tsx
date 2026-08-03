// settingsForm 纯逻辑测试。后缀 .tsx 是 vitest project 的约束:unit 工程只
// 收 src/{lib,gen,app} 下的 .test.ts,features 下的测试统一走 dom 工程
// (include: src/**/*.test.tsx)——纯函数在 jsdom 里跑同样成立。
import { describe, expect, it } from "vitest";

import type { DesktopConfig } from "@/lib/ipc/config";
import {
  buildPayload,
  draftFromConfig,
  mcpsToServers,
  parseKV,
  payloadEquals,
  serversToMcps,
  validateDraft,
  type McpEntry,
} from "./settingsForm";

const model = (over: Partial<import("@/lib/ipc/config").HostModel> = {}) => ({
  name: "m1",
  provider: "anthropic",
  base_url: "https://a",
  api_key: "sk",
  model: "claude",
  ...over,
});

const mcp = (over: Partial<McpEntry> = {}): McpEntry => ({
  name: "fetch",
  type: "http",
  url: "https://mcp",
  command: "",
  args: "",
  kv: "",
  ...over,
});

const cfg = (over: Partial<DesktopConfig> = {}): DesktopConfig => ({
  models: [model({ default: true }), model({ name: "m2", model: "gpt" })],
  mcp_servers: { fetch: { url: "https://mcp" } },
  kernel_env: "",
  mc_base_url: "https://mc.example",
  ...over,
});

describe("MCP 表单 ⇄ mcpServers 序列化", () => {
  it("parseKV:跳过无 = 行与空键,值 trim;全空返回 undefined", () => {
    expect(parseKV("A=1\nB = 2 \n无效行\n=x\n")).toEqual({ A: "1", B: "2" });
    expect(parseKV("")).toBeUndefined();
  });

  it("http/stdio 往返:表单外字段(disabled 等)经 extra 原样透传", () => {
    const servers = {
      web: { url: "https://x", headers: { Authorization: "Bearer t" }, disabled: true, source: "baizhi" },
      files: { command: "npx", args: ["-y", "server"], env: { HOME: "/h" } },
    };
    const entries = serversToMcps(servers);
    expect(entries).toEqual([
      {
        name: "web",
        type: "http",
        url: "https://x",
        command: "",
        args: "",
        kv: "Authorization=Bearer t",
        source: "baizhi",
        extra: { disabled: true },
      },
      { name: "files", type: "stdio", url: "", command: "npx", args: "-y server", kv: "HOME=/h", source: undefined, extra: undefined },
    ]);
    expect(mcpsToServers(entries)).toEqual({
      web: { disabled: true, url: "https://x", headers: { Authorization: "Bearer t" }, source: "baizhi" },
      files: { command: "npx", args: ["-y", "server"], env: { HOME: "/h" } },
    });
  });

  it("序列化跳过:空名、http 缺 URL、stdio 缺命令", () => {
    expect(
      mcpsToServers([
        mcp({ name: "" }),
        mcp({ name: "nourl", url: "" }),
        mcp({ name: "nocmd", type: "stdio", url: "", command: "" }),
        mcp({ name: "ok" }),
      ]),
    ).toEqual({ ok: { url: "https://mcp", headers: undefined } });
  });
});

describe("草稿 ⇄ 载荷(全量写回)", () => {
  it("draftFromConfig:default 定位到行下标,无默认回落 0", () => {
    expect(draftFromConfig(cfg()).defaultIdx).toBe(0);
    expect(draftFromConfig(cfg({ models: [model(), model({ name: "m2", default: true })] })).defaultIdx).toBe(1);
    expect(draftFromConfig(cfg({ models: [model()] })).defaultIdx).toBe(0);
  });

  it("buildPayload:白名单收敛(未知字段不透传)、default 重算、表单外顶层字段透传", () => {
    const base = cfg({ models: [{ ...model(), legacy_flag: true } as never] });
    const draft = draftFromConfig(base);
    draft.defaultIdx = 0;
    const payload = buildPayload(base, draft);
    expect(payload.models).toEqual([
      {
        name: "m1",
        provider: "anthropic",
        base_url: "https://a",
        api_key: "sk",
        model: "claude",
        default: true,
        context_window: undefined,
        max_output: undefined,
        think: undefined,
        vision: undefined,
        source: undefined,
        locked: undefined,
        owner: undefined,
      },
    ]);
    expect("legacy_flag" in (payload.models[0] as object)).toBe(false);
    expect(payload.mc_base_url).toBe("https://mc.example"); // 表单外字段原样透传
    expect(payload.kernel_env).toBe("");
  });

  it("锁定/同步标记(source/locked/owner)与高级字段随保存透传", () => {
    const base = cfg({
      models: [model({ source: "monkeycode", locked: true, owner: "team", context_window: 128000, think: "high" })],
    });
    const payload = buildPayload(base, draftFromConfig(base));
    expect(payload.models[0]).toMatchObject({
      source: "monkeycode",
      locked: true,
      owner: "team",
      context_window: 128000,
      think: "high",
    });
  });

  it("全空模型草稿行不进载荷(加了行没填 = 没加,不置脏)", () => {
    const base = cfg();
    const draft = draftFromConfig(base);
    draft.models.push({ name: "", provider: "anthropic", base_url: "", api_key: "", model: "" });
    expect(payloadEquals(buildPayload(base, draft), buildPayload(base, draftFromConfig(base)))).toBe(true);
  });

  it("脏判定:名称/kernel_env/MCP 任一改动即不等,还原后复等", () => {
    const base = cfg();
    const baseline = buildPayload(base, draftFromConfig(base));
    const d1 = draftFromConfig(base);
    d1.models = d1.models.map((m, i) => (i === 0 ? { ...m, name: "改名" } : m));
    expect(payloadEquals(buildPayload(base, d1), baseline)).toBe(false);

    const d2 = draftFromConfig(base);
    d2.kernelEnv = "wsl:Ubuntu";
    expect(payloadEquals(buildPayload(base, d2), baseline)).toBe(false);

    const d3 = draftFromConfig(base);
    d3.mcps = [...d3.mcps, mcp({ name: "extra" })];
    expect(payloadEquals(buildPayload(base, d3), baseline)).toBe(false);

    expect(payloadEquals(buildPayload(base, draftFromConfig(base)), baseline)).toBe(true);
  });
});

describe("validateDraft(保存前拦截,首错即返)", () => {
  const draftWith = (over: Partial<ReturnType<typeof draftFromConfig>>) => ({
    ...draftFromConfig(cfg()),
    ...over,
  });

  it("合法草稿通过;全空行不参与校验", () => {
    expect(validateDraft(draftFromConfig(cfg()))).toBeNull();
    expect(
      validateDraft(draftWith({ models: [model(), { name: "", provider: "anthropic", base_url: "", api_key: "", model: "" }] })),
    ).toBeNull();
  });

  it("模型:有内容无名 → modelName;重名 → modelDup", () => {
    expect(validateDraft(draftWith({ models: [model({ name: "" })] }))).toEqual({ kind: "modelName" });
    expect(validateDraft(draftWith({ models: [model(), model({ name: " m1 " })] }))).toEqual({
      kind: "modelDup",
      name: "m1",
    });
  });

  it("MCP:非法字符 → mcpName;重名 → mcpDup;有名缺 URL/命令 → mcpIncomplete", () => {
    expect(validateDraft(draftWith({ mcps: [mcp({ name: "带 空格" })] }))).toEqual({ kind: "mcpName", name: "带 空格" });
    expect(validateDraft(draftWith({ mcps: [mcp(), mcp()] }))).toEqual({ kind: "mcpDup", name: "fetch" });
    expect(validateDraft(draftWith({ mcps: [mcp({ url: "" })] }))).toEqual({ kind: "mcpIncomplete", name: "fetch" });
    expect(validateDraft(draftWith({ mcps: [mcp({ type: "stdio", url: "", command: "" })] }))).toEqual({
      kind: "mcpIncomplete",
      name: "fetch",
    });
  });
});
