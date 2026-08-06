import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopConfig } from "@/lib/ipc/config";
import { SettingsView } from "./SettingsView";

afterEach(() => {
  localStorage.clear();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  // UA 覆写(WSL 条件渲染用)按实例属性打的,删掉即回落 jsdom 原型 getter
  Reflect.deleteProperty(window.navigator, "userAgent");
  vi.unstubAllGlobals();
});

const baseConfig: DesktopConfig = {
  models: [
    { name: "主力", provider: "anthropic", base_url: "https://a", api_key: "k1", model: "claude", default: true },
    { name: "备用", provider: "openai", base_url: "https://b", api_key: "k2", model: "gpt", default: false },
  ],
  mcp_servers: { fetch: { url: "https://mcp" } },
  kernel_env: "",
  mc_base_url: "https://mc.example",
};

function stubShell(opts?: {
  config?: DesktopConfig;
  sound?: boolean;
  distros?: string[];
  save?: () => Promise<unknown>;
  /** 额外命令(账号分区的 baizhi/mc 系列等),优先于内置分支 */
  extra?: Record<string, () => unknown>;
}) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const listeners: Record<string, (e: { payload: unknown }) => void> = {};
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (opts?.extra && cmd in opts.extra) return Promise.resolve(opts.extra[cmd]!());
        switch (cmd) {
          case "get_config":
            return Promise.resolve(structuredClone(opts?.config ?? baseConfig));
          case "sound_enabled":
            return Promise.resolve(opts?.sound ?? true);
          case "list_wsl_distros":
            return Promise.resolve(opts?.distros ?? []);
          case "host_info":
            return Promise.resolve({ version: "26080101", engine_version: "0.9.0" });
          case "save_config":
            return (opts?.save ?? (() => Promise.resolve(null)))();
          default:
            return Promise.resolve(null);
        }
      },
    },
    event: {
      listen: (name: string, cb: (e: { payload: unknown }) => void) => {
        listeners[name] = cb;
        return Promise.resolve(() => {});
      },
    },
  };
  return { calls, listeners };
}

const windowsUA = () =>
  Object.defineProperty(window.navigator, "userAgent", {
    value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    configurable: true,
  });

const openModels = async () => {
  await userEvent.click(screen.getByRole("button", { name: "模型" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /主力/ })).toBeDefined());
};

describe("设置视图:导航与载入", () => {
  it("非 Windows:导航为 通用/模型/MCP/关于,无「运行环境」;模型列表载入", async () => {
    stubShell();
    render(<SettingsView onClose={() => {}} />);
    for (const label of ["通用", "模型", "MCP", "关于"]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }
    expect(screen.queryByRole("button", { name: "运行环境" })).toBeNull();
    await openModels();
    expect(screen.getByRole("button", { name: /备用/ })).toBeDefined();
    expect(screen.getByText("默认")).toBeDefined(); // 主力行的默认徽标
  });

  it("导航含「账号」,点击挂载账号分区(登录 tab 可见)", async () => {
    stubShell(); // 未知命令(baizhi_status 等)回 null,分区按未登录形态渲染
    render(<SettingsView onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "账号" }));
    expect(await screen.findByRole("tab", { name: "微信扫码" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "短信验证码" })).toBeDefined();
    // 拉码命令回 null → 状态机按失败收束,给出重试入口(不留悬空 loading)
    expect(await screen.findByRole("button", { name: "重新获取二维码" })).toBeDefined();
  });

  it("返回按钮回调 onClose", async () => {
    stubShell();
    const onClose = vi.fn();
    render(<SettingsView onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("浏览器模式:模型分区降级为只读提示,不渲染保存条", async () => {
    render(<SettingsView onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "模型" }));
    expect(screen.getByRole("alert").textContent).toContain("浏览器模式下配置只读");
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });
});

describe("脏状态机与保存条", () => {
  it("改动 → 保存条现身;放弃 → 草稿还原、保存条收起", async () => {
    stubShell();
    render(<SettingsView onClose={() => {}} />);
    await openModels();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /主力/ }));
    const name = screen.getByRole("textbox", { name: "名称" });
    await userEvent.clear(name);
    await userEvent.type(name, "主力2");
    expect(screen.getByRole("button", { name: "保存" })).toBeDefined();
    expect(screen.getByText(/有未保存的修改/).textContent).toContain("重启引擎");

    await userEvent.click(screen.getByRole("button", { name: "放弃" }));
    expect((screen.getByRole("textbox", { name: "名称" }) as HTMLInputElement).value).toBe("主力");
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("保存:save_config 全量写回(default 重算、MCP 序列化、表单外字段透传),成功后保存条收起", async () => {
    const { calls } = stubShell();
    render(<SettingsView onClose={() => {}} />);
    await openModels();
    await userEvent.click(screen.getByRole("button", { name: /主力/ }));
    const name = screen.getByRole("textbox", { name: "名称" });
    await userEvent.clear(name);
    await userEvent.type(name, "主力2");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((c) => c.cmd === "save_config")).toBe(true));
    const payload = calls.find((c) => c.cmd === "save_config")?.args?.config;
    expect(payload).toEqual({
      models: [
        { name: "主力2", provider: "anthropic", base_url: "https://a", api_key: "k1", model: "claude", default: true },
        { name: "备用", provider: "openai", base_url: "https://b", api_key: "k2", model: "gpt", default: false },
      ],
      mcp_servers: { fetch: { url: "https://mcp" } },
      kernel_env: "",
      mc_base_url: "https://mc.example", // 表单外字段全量写回
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存" })).toBeNull());
  });

  it("保存失败:壳的中文 Err 外显在保存条,条不收起", async () => {
    stubShell({ save: () => Promise.reject(new Error("引擎启动失败: 模型配置无效")) });
    render(<SettingsView onClose={() => {}} />);
    await openModels();
    await userEvent.click(screen.getByRole("button", { name: /主力/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "名称" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("引擎启动失败: 模型配置无效"));
    expect(screen.getByRole("button", { name: "保存" })).toBeDefined();
  });

  it("校验拦截:清空模型名点保存,不发 save_config 且外显错误", async () => {
    const { calls } = stubShell();
    render(<SettingsView onClose={() => {}} />);
    await openModels();
    await userEvent.click(screen.getByRole("button", { name: /主力/ }));
    await userEvent.clear(screen.getByRole("textbox", { name: "名称" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert").textContent).toContain("模型名称不能为空");
    expect(calls.some((c) => c.cmd === "save_config")).toBe(false);
  });
});

describe("模型增删改与设默认", () => {
  it("添加模型:新行展开编辑,保存载荷含新条目", async () => {
    const { calls } = stubShell();
    render(<SettingsView onClose={() => {}} />);
    await openModels();
    await userEvent.click(screen.getByRole("button", { name: "添加模型" }));
    const name = screen.getByRole("textbox", { name: "名称" });
    await userEvent.type(name, "新模型");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_config")).toBe(true));
    const models = (calls.find((c) => c.cmd === "save_config")?.args?.config as DesktopConfig).models;
    expect(models.map((m) => m.name)).toEqual(["主力", "备用", "新模型"]);
    expect(models.map((m) => m.default)).toEqual([true, false, false]);
  });

  it("删除默认行:默认位回落到首行,保存载荷同步", async () => {
    const { calls } = stubShell();
    render(<SettingsView onClose={() => {}} />);
    await openModels();
    await userEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
    expect(screen.queryByRole("button", { name: /主力/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_config")).toBe(true));
    const models = (calls.find((c) => c.cmd === "save_config")?.args?.config as DesktopConfig).models;
    expect(models).toEqual([
      { name: "备用", provider: "openai", base_url: "https://b", api_key: "k2", model: "gpt", default: true },
    ]);
  });

  it("设为默认:default 标记随行重算", async () => {
    const { calls } = stubShell();
    render(<SettingsView onClose={() => {}} />);
    await openModels();
    await userEvent.click(screen.getByRole("button", { name: "设为默认" })); // 唯一非默认行(备用)
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_config")).toBe(true));
    const models = (calls.find((c) => c.cmd === "save_config")?.args?.config as DesktopConfig).models;
    expect(models.map((m) => [m.name, m.default])).toEqual([
      ["主力", false],
      ["备用", true],
    ]);
  });
});

describe("MCP 编辑(与模型同一份脏状态)", () => {
  it("添加 stdio 条目:命令/参数/环境变量序列化进 mcp_servers", async () => {
    const { calls } = stubShell();
    render(<SettingsView onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "MCP" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /fetch/ })).toBeDefined());
    await userEvent.click(screen.getByRole("button", { name: "添加 MCP" }));
    await userEvent.type(screen.getByRole("textbox", { name: "名称" }), "files");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "类型" }), "stdio");
    await userEvent.type(screen.getByRole("textbox", { name: "命令" }), "npx");
    await userEvent.type(screen.getByRole("textbox", { name: "参数(空格分隔)" }), "-y srv");
    await userEvent.type(screen.getByRole("textbox", { name: /环境变量/ }), "HOME=/h");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_config")).toBe(true));
    const servers = (calls.find((c) => c.cmd === "save_config")?.args?.config as DesktopConfig).mcp_servers;
    expect(servers).toEqual({
      fetch: { url: "https://mcp" },
      files: { command: "npx", args: ["-y", "srv"], env: { HOME: "/h" } },
    });
  });
});

describe("同步自动保存(旧 UI autoSaveDecision 随迁)", () => {
  // 账号分区已登录 + 会员同步返回一条模型
  const syncExtra = () => ({
    mc_status: () => ({ logged_in: true, user: { name: "李四" } }),
    baizhi_status: () => ({ logged_in: false, host: "baizhi.cloud" }),
    mc_models_sync: () => ({
      models: [{ name: "member-m", base_url: "https://m", api_key: "k", model: "mm", source: "monkeycode" }],
    }),
  });
  const syncMemberModels = async () => {
    await userEvent.click(screen.getByRole("button", { name: "账号" }));
    await userEvent.click(await screen.findByRole("button", { name: "同步会员模型" }));
  };

  it("干净表单+无任务在跑:同步后直接 save_config,提示「已自动保存」", async () => {
    const { calls } = stubShell({ extra: syncExtra() });
    render(<SettingsView onClose={() => {}} />);
    await openModels(); // 等配置载入(基线就绪)再去账号页
    await syncMemberModels();
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_config")).toBe(true));
    expect((await screen.findByText(/已获取 1 个会员模型/)).textContent).toContain("已自动保存");
    // 载荷含同步条目(落盘名带 @monkeycode 来源后缀)
    const saved = calls.find((c) => c.cmd === "save_config")?.args?.config as DesktopConfig;
    expect(saved.models.some((m) => m.name.startsWith("member-m@"))).toBe(true);
  });

  it("有任务在跑:不自动保存(重启引擎会踹掉任务),提示原因并留保存条", async () => {
    const { calls } = stubShell({ extra: syncExtra() });
    render(<SettingsView onClose={() => {}} hasRunningTask />);
    await openModels();
    await syncMemberModels();
    expect((await screen.findByText(/已获取 1 个会员模型/)).textContent).toContain("有任务正在运行");
    expect(calls.some((c) => c.cmd === "save_config")).toBe(false);
    expect(screen.getByRole("button", { name: "保存" })).toBeDefined(); // 合并已入草稿,保存条兜底
  });

  it("脏表单:不自动保存(不捎带未确认的修改),提示原因", async () => {
    const { calls } = stubShell({ extra: syncExtra() });
    render(<SettingsView onClose={() => {}} />);
    await openModels();
    // 先弄脏表单
    await userEvent.click(screen.getByRole("button", { name: /主力/ }));
    const name = screen.getByRole("textbox", { name: "名称" });
    await userEvent.clear(name);
    await userEvent.type(name, "主力2");
    await syncMemberModels();
    expect((await screen.findByText(/已获取 1 个会员模型/)).textContent).toContain("未保存的修改");
    expect(calls.some((c) => c.cmd === "save_config")).toBe(false);
  });
});

describe("提示音双向同步", () => {
  it("初值来自 sound_enabled;切换发 set_sound_enabled;壳广播回来盖一次", async () => {
    const { calls, listeners } = stubShell({ sound: false });
    render(<SettingsView onClose={() => {}} />);
    const toggle = () => screen.getByRole("checkbox", { name: "事件提示音" }) as HTMLInputElement;
    await waitFor(() => expect(toggle().checked).toBe(false));

    await userEvent.click(toggle());
    expect(toggle().checked).toBe(true); // 乐观置位
    expect(calls.some((c) => c.cmd === "set_sound_enabled" && c.args?.enabled === true)).toBe(true);

    // 托盘那头把它关了:sound-enabled 广播驱动设置页跟上
    act(() => listeners["sound-enabled"]?.({ payload: false }));
    expect(toggle().checked).toBe(false);
  });
});

describe("运行环境(仅 Windows 壳)", () => {
  it("Windows:导航含「运行环境」,WSL 发行版进下拉,选择后走保存条", async () => {
    windowsUA();
    const { calls } = stubShell({ distros: ["Ubuntu"] });
    render(<SettingsView onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "运行环境" }));
    const select = await screen.findByRole("combobox", { name: "内核运行环境" });
    expect(screen.getByRole("option", { name: "本机(Windows)" })).toBeDefined();
    await waitFor(() => expect(screen.getByRole("option", { name: "WSL · Ubuntu" })).toBeDefined());

    await userEvent.selectOptions(select, "wsl:Ubuntu");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_config")).toBe(true));
    const payload = calls.find((c) => c.cmd === "save_config")?.args?.config as DesktopConfig;
    expect(payload.kernel_env).toBe("wsl:Ubuntu");
  });

  it("记忆的发行版已卸载:保留为「未检测到」选项,不静默改值", async () => {
    windowsUA();
    stubShell({ config: { ...baseConfig, kernel_env: "wsl:Gone" }, distros: ["Ubuntu"] });
    render(<SettingsView onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "运行环境" }));
    const select = await screen.findByRole("combobox", { name: "内核运行环境" });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("wsl:Gone"));
    expect(screen.getByRole("option", { name: /Gone.*未检测到/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull(); // 载入不置脏
  });
});
