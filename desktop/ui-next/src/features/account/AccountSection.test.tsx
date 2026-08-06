import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McUsage } from "@/lib/ipc/account";
import { AccountSection } from "./AccountSection";

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

type Handler = (args?: Record<string, unknown>) => unknown;

/** 命令级可变桩:handlers 按 cmd 出应答(测试中途可改),未知命令回 null。 */
function stubShell(handlers: Record<string, Handler>) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        const h = handlers[cmd];
        if (!h) return Promise.resolve(null);
        try {
          return Promise.resolve(h(args));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    },
  };
  return { calls };
}

const never = () => new Promise(() => {});
const bzOut = () => ({ logged_in: false, host: "baizhi.cloud" });
const bzIn = () => ({ logged_in: true, host: "baizhi.cloud", profile: { name: "张三" } });
const mcOut = () => ({ logged_in: false, host: "monkeycode-ai.com" });
const mcIn = () => ({ logged_in: true, host: "monkeycode-ai.com", user: { id: "u1", name: "云端用户" } });

const usageFixture = (): McUsage => ({
  base_url: "https://mc.example",
  wallet: { balance: 12345, daily_token_balance: 1_500_000, daily_token_limit: 3_000_000 },
  subscription: { plan: "pro", expires_at: "2026-12-31T00:00:00Z" },
  checked_in: false,
  invitations: { count: 2, items: [{ id: "i1", name: "甲" }] },
});

describe("账号分区:门与登录面板", () => {
  it("浏览器模式:仅提示「桌面应用可用」,不发任何命令", () => {
    render(<AccountSection />);
    expect(screen.getByRole("alert").textContent).toContain("账号功能仅在桌面应用中可用");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("未登录默认微信 tab:自动拉码展示二维码与「待扫」提示", async () => {
    stubShell({
      baizhi_status: bzOut,
      mc_status: mcOut,
      baizhi_wechat_start: () => ({ qr: "data:image/jpeg;base64,QQ" }),
      baizhi_wechat_poll: never,
    });
    render(<AccountSection />);
    const img = (await screen.findByAltText("微信扫码登录")) as HTMLImageElement;
    expect(img.src).toBe("data:image/jpeg;base64,QQ");
    expect(await screen.findByText("用微信扫一扫登录")).toBeDefined();
  });

  it("expired:二维码上覆「重新获取」,点击重新拉码", async () => {
    let polls = 0;
    const { calls } = stubShell({
      baizhi_status: bzOut,
      mc_status: mcOut,
      baizhi_wechat_start: () => ({ qr: "data:qr" }),
      baizhi_wechat_poll: () => (++polls === 1 ? { status: "expired" } : never()),
    });
    render(<AccountSection />);
    const retry = await screen.findByRole("button", { name: "重新获取二维码" });
    expect(screen.getByText("二维码已过期")).toBeDefined();
    await userEvent.click(retry);
    await waitFor(() => expect(calls.filter((c) => c.cmd === "baizhi_wechat_start")).toHaveLength(2));
    expect(await screen.findByText("用微信扫一扫登录")).toBeDefined();
  });

  it("扫码 ok:刷新登录态、顺带桥接 MonkeyCode,且两路自动同步(登录即同步,不用手点)", async () => {
    let statusCalls = 0;
    let mcConnected = false;
    const { calls } = stubShell({
      baizhi_status: () => (++statusCalls === 1 ? bzOut() : bzIn()),
      mc_status: () => (mcConnected ? mcIn() : mcOut()),
      baizhi_wechat_start: () => ({ qr: "data:qr" }),
      baizhi_wechat_poll: () => ({ status: "ok" }),
      mc_login: () => {
        mcConnected = true;
        return { ok: true };
      },
      mc_usage: () => null,
      baizhi_sync: () => ({ models: [{ name: "g", base_url: "https://g", api_key: "k", model: "g" }], mcp_servers: {}, key_created: false }),
      mc_models_sync: () => ({ models: [{ name: "m", base_url: "https://m", api_key: "k", model: "m", source: "monkeycode" }] }),
    });
    render(<AccountSection />);
    expect(await screen.findByText("张三")).toBeDefined(); // 百智云卡已登录形态
    expect(await screen.findByText("云端用户")).toBeDefined(); // 桥接成功,MC 卡已连
    expect(calls.some((c) => c.cmd === "mc_login")).toBe(true);
    // 登录真实事件自动起两路同步(旧 UI 用户拍板行为;打开设置读到既有
    // 登录态不触发,由「已登录:同步按钮」用例的无自动同步前提反向钉住)
    await waitFor(() => expect(calls.some((c) => c.cmd === "baizhi_sync")).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.cmd === "mc_models_sync")).toBe(true));
  });
});

describe("短信验证码登录", () => {
  const smsHandlers = () => ({
    baizhi_status: bzOut,
    mc_status: mcOut,
    baizhi_wechat_start: never, // 微信 tab 初始挂载的拉码挂起即可
    baizhi_send_code: () => ({ ok: true }),
  });

  it("手机号无效:就地报错,不发 baizhi_send_code", async () => {
    const { calls } = stubShell(smsHandlers());
    render(<AccountSection />);
    await userEvent.click(await screen.findByRole("tab", { name: "短信验证码" }));
    await userEvent.type(screen.getByRole("textbox", { name: "手机号" }), "123");
    await userEvent.click(screen.getByRole("button", { name: "获取验证码" }));
    expect(screen.getByRole("alert").textContent).toContain("请输入有效的手机号");
    expect(calls.some((c) => c.cmd === "baizhi_send_code")).toBe(false);
  });

  it("发码成功:按钮进入 60s 倒计时禁用,读秒归零后恢复可点", async () => {
    const { calls } = stubShell(smsHandlers());
    render(<AccountSection />);
    // 导航与输入走真时钟(findBy/waitFor 不吃假时钟),读秒段再切假时钟
    await userEvent.click(await screen.findByRole("tab", { name: "短信验证码" }));
    await userEvent.type(screen.getByRole("textbox", { name: "手机号" }), "13800000000");

    vi.useFakeTimers();
    // fireEvent(同步)而非 userEvent:后者内部靠 setTimeout 排步,假时钟下会悬死
    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));
    await act(async () => {}); // 冲掉发码 promise 链(壳应答→setCountdown)

    expect(calls.filter((c) => c.cmd === "baizhi_send_code").map((c) => c.args)).toEqual([{ phone: "13800000000" }]);
    const at60 = screen.getByRole("button", { name: "60s" }) as HTMLButtonElement;
    expect(at60.disabled).toBe(true);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("button", { name: "59s" })).toBeDefined();
    for (let i = 0; i < 59; i++) act(() => vi.advanceTimersByTime(1000));
    const restored = screen.getByRole("button", { name: "获取验证码" }) as HTMLButtonElement;
    expect(restored.disabled).toBe(false);
  });

  it("登录成功:baizhi_login 携带手机号与验证码,并顺带桥接 MonkeyCode", async () => {
    let loggedIn = false;
    let mcConnected = false;
    const { calls } = stubShell({
      ...smsHandlers(),
      baizhi_status: () => (loggedIn ? bzIn() : bzOut()),
      mc_status: () => (mcConnected ? mcIn() : mcOut()),
      baizhi_login: () => {
        loggedIn = true;
        return { ok: true };
      },
      mc_login: () => {
        mcConnected = true;
        return { ok: true };
      },
      mc_usage: () => null,
    });
    render(<AccountSection />);
    await userEvent.click(await screen.findByRole("tab", { name: "短信验证码" }));
    await userEvent.type(screen.getByRole("textbox", { name: "手机号" }), "13800000000");
    await userEvent.type(screen.getByRole("textbox", { name: "短信验证码" }), "654321");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("张三")).toBeDefined();
    expect(calls.find((c) => c.cmd === "baizhi_login")?.args).toEqual({ phone: "13800000000", code: "654321" });
    expect(calls.some((c) => c.cmd === "mc_login")).toBe(true);
  });
});

describe("MonkeyCode 账号密码登录入口", () => {
  it("全未登录:MonkeyCode 组照出,入口归本卡;不摆「连接」死钮(桥接要百智云会话)", async () => {
    stubShell({ baizhi_status: bzOut, mc_status: mcOut, baizhi_wechat_start: never });
    render(<AccountSection />);
    expect(await screen.findByText("MonkeyCode 云端")).toBeDefined();
    expect(screen.queryByRole("button", { name: "连接 MonkeyCode 云端" })).toBeNull();
    // 展开 → 收起:表单在 MonkeyCode 卡内,不再挂在百智云登录卡下方
    await userEvent.click(screen.getByRole("button", { name: "使用 MonkeyCode 账号密码登录" }));
    expect(screen.getByRole("textbox", { name: "邮箱" })).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByRole("textbox", { name: "邮箱" })).toBeNull();
  });

  it("百智云已登录、MC 未连:出「连接」主钮,账密入口仍在同一张卡", async () => {
    stubShell({ baizhi_status: bzIn, mc_status: mcOut, mc_usage: () => null });
    render(<AccountSection />);
    expect(await screen.findByRole("button", { name: "连接 MonkeyCode 云端" })).toBeDefined();
    expect(screen.getByRole("button", { name: "使用 MonkeyCode 账号密码登录" })).toBeDefined();
  });

  it("空提交拦截;正确提交 mc_password_login 原样携带 email/password", async () => {
    let mcConnected = false;
    const { calls } = stubShell({
      baizhi_status: bzOut,
      mc_status: () => (mcConnected ? mcIn() : mcOut()),
      baizhi_wechat_start: never,
      mc_password_login: () => {
        mcConnected = true;
        return { ok: true };
      },
      mc_usage: () => null,
      mc_models_sync: () => ({ models: [{ name: "m", base_url: "https://m", api_key: "k", model: "m", source: "monkeycode" }] }),
    });
    render(<AccountSection />);
    await userEvent.click(await screen.findByRole("button", { name: "使用 MonkeyCode 账号密码登录" }));

    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(screen.getByRole("alert").textContent).toContain("请输入邮箱和密码");
    expect(calls.some((c) => c.cmd === "mc_password_login")).toBe(false);

    await userEvent.type(screen.getByRole("textbox", { name: "邮箱" }), "a@b.c");
    await userEvent.type(screen.getByLabelText("密码"), "p w");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("云端用户")).toBeDefined();
    expect(calls.find((c) => c.cmd === "mc_password_login")?.args).toEqual({ email: "a@b.c", password: "p w" });
    // MC 已连、百智云未登录:补百智云登录入口但不再给账密入口
    expect(screen.queryByRole("button", { name: "使用 MonkeyCode 账号密码登录" })).toBeNull();
    // 账密直连同样是登录真实事件:会员模型自动同步
    await waitFor(() => expect(calls.some((c) => c.cmd === "mc_models_sync")).toBe(true));
  });
});

describe("已登录:用量面板/签到/同步/断开", () => {
  const connectedHandlers = (usage: { current: McUsage }) => ({
    baizhi_status: bzIn,
    mc_status: mcIn,
    mc_usage: () => usage.current,
  });

  it("身份副行:主机名 + 用户 ID(长串按 头8…尾6 掩码),点击复制完整原值", async () => {
    const longId = "5f8a12c3-9b4d-4e7a-8c1f-0a2b3c4d9d21";
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    stubShell({
      baizhi_status: bzIn,
      mc_status: () => ({ logged_in: true, host: "monkeycode-ai.com", user: { id: longId, name: "云端用户" } }),
      mc_usage: () => null,
    });
    render(<AccountSection />);
    const btn = await screen.findByRole("button", { name: "复制用户 ID" });
    expect(btn.textContent).toBe("5f8a12c3...4d9d21");
    expect(btn.getAttribute("title")).toBe(`用户 ID:${longId}(点击复制)`);

    await userEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith(longId); // 复制的是完整原值,不是掩码
    expect(await screen.findByRole("button", { name: "用户 ID 已复制" })).toBeDefined();
  });

  it("用量面板:会员档 badge、有效期、额度 progress、积分、邀请;签到成功后刷为已签", async () => {
    const usage = { current: usageFixture() };
    const { calls } = stubShell({
      ...connectedHandlers(usage),
      mc_checkin: () => {
        usage.current = {
          ...usageFixture(),
          checked_in: true,
          wallet: { balance: 112345, daily_token_balance: 1_500_000, daily_token_limit: 3_000_000 },
        };
        return { ok: true };
      },
    });
    render(<AccountSection />);
    expect(await screen.findByText("专业会员")).toBeDefined();
    expect(screen.getByText("有效期至 2026-12-31")).toBeDefined();
    const bar = screen.getByRole("progressbar") as HTMLProgressElement;
    expect(bar.value).toBe(1_500_000);
    expect(bar.max).toBe(3_000_000);
    expect(screen.getByText("剩余 1.5M / 3.0M")).toBeDefined();
    // 积分改 stats 大数值卡:标题与数值分节点
    expect(screen.getByText("积分")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("已邀请 2 人")).toBeDefined();
    // 邀请链接收进复制按钮(title 露全链接),不再明文铺链接
    expect(screen.getByTitle("https://mc.example/?ic=u1")).toBeDefined();
    expect(screen.getByRole("button", { name: "复制邀请链接" })).toBeDefined();

    // 签到三态:可签 → 成功后刷新为「今日已签到」禁用;积分随重拉一起更新
    await userEvent.click(screen.getByRole("button", { name: "签到 +100" }));
    expect(calls.some((c) => c.cmd === "mc_checkin")).toBe(true);
    const done = (await screen.findByRole("button", { name: "今日已签到" })) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(screen.getByText("112")).toBeDefined();
  });

  it("签到失败(重复签到等业务提示):就地报错,按钮不进入已签态", async () => {
    const usage = { current: usageFixture() };
    stubShell({
      ...connectedHandlers(usage),
      mc_checkin: () => {
        throw new Error("今日已签到,请明天再来");
      },
    });
    render(<AccountSection />);
    await userEvent.click(await screen.findByRole("button", { name: "签到 +100" }));
    expect((await screen.findByRole("alert")).textContent).toContain("今日已签到,请明天再来");
    expect(screen.getByRole("button", { name: "签到 +100" })).toBeDefined();
  });

  it("同步按钮:baizhi_sync 携带 knownKeys,mc_models_sync 结果提示条数与 note", async () => {
    const usage = { current: usageFixture() };
    const { calls } = stubShell({
      ...connectedHandlers(usage),
      baizhi_sync: () => ({
        models: [{}, {}, {}],
        mcp_servers: { "baizhi-toolkit": {} },
        key_created: false,
        notes: [],
      }),
      mc_models_sync: () => ({ models: [{}, {}], notes: ["1 条模型使用了不支持的协议,已跳过"] }),
    });
    render(<AccountSection />);
    await userEvent.click(await screen.findByRole("button", { name: "同步模型与 MCP" }));
    expect(calls.find((c) => c.cmd === "baizhi_sync")?.args).toEqual({ knownKeys: [] });
    expect((await screen.findByText(/已获取 3 个模型、1 个 MCP 配置/)).textContent).toContain("保存后生效");

    await userEvent.click(screen.getByRole("button", { name: "同步会员模型" }));
    expect(calls.some((c) => c.cmd === "mc_models_sync")).toBe(true);
    expect((await screen.findByText(/已获取 2 个会员模型/)).textContent).toContain("不支持的协议");
  });

  it("断开连接:mc_models_revoke 先于 mc_logout(顺序钉死),断开后回连接入口", async () => {
    let mcConnected = true;
    const usage = { current: usageFixture() };
    const { calls } = stubShell({
      baizhi_status: bzIn,
      mc_status: () => (mcConnected ? mcIn() : mcOut()),
      mc_usage: () => usage.current,
      mc_models_revoke: () => ({ ok: true }),
      mc_logout: () => {
        mcConnected = false;
        return { ok: true };
      },
    });
    render(<AccountSection />);
    await userEvent.click(await screen.findByRole("button", { name: "断开连接" }));
    expect(await screen.findByRole("button", { name: "连接 MonkeyCode 云端" })).toBeDefined();
    const names = calls.map((c) => c.cmd);
    const revokeAt = names.indexOf("mc_models_revoke");
    const logoutAt = names.indexOf("mc_logout");
    expect(revokeAt).toBeGreaterThanOrEqual(0);
    expect(logoutAt).toBeGreaterThan(revokeAt);
  });

  it("断开时吊销失败:不阻断登出(仍按序走 mc_logout),失败信息外显", async () => {
    let mcConnected = true;
    const usage = { current: usageFixture() };
    const { calls } = stubShell({
      baizhi_status: bzIn,
      mc_status: () => (mcConnected ? mcIn() : mcOut()),
      mc_usage: () => usage.current,
      mc_models_revoke: () => {
        throw new Error("网络不可达");
      },
      mc_logout: () => {
        mcConnected = false;
        return { ok: true };
      },
    });
    render(<AccountSection />);
    await userEvent.click(await screen.findByRole("button", { name: "断开连接" }));
    expect(await screen.findByRole("button", { name: "连接 MonkeyCode 云端" })).toBeDefined();
    expect(calls.map((c) => c.cmd)).toContain("mc_logout");
    expect((await screen.findByRole("alert")).textContent).toContain("网络不可达");
  });
});
