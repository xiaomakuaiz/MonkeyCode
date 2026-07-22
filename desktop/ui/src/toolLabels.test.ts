import { describe, expect, it } from "vitest";
import { localizedToolTitleText, localizeToolTitle, toolDisplayName } from "./toolLabels";

describe("工具标题本地化", () => {
  it("覆盖当前所有内置活动工具与别名", () => {
    const tools = [
      "Agent", "Task", "AskUserQuestion", "Bash", "Cmd", "PowerShell",
      "SendUserMessage", "Brief", "Config", "CronCreate", "CronDelete", "CronList",
      "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
      "Edit", "Read", "Write", "Glob", "Grep", "ListMcpResourcesTool",
      "ReadMcpResourceTool", "LSP", "NotebookEdit", "RemoteTrigger", "SendMessage",
      "Skill", "StructuredOutput", "TaskCreate", "TaskGet", "TaskList", "TaskOutput",
      "AgentOutputTool", "BashOutputTool", "TaskStop", "KillShell", "TaskUpdate",
      "TeamCreate", "TeamDelete", "TodoWrite", "ToolSearch", "WebFetch", "WebSearch",
    ];
    for (const tool of tools) expect(toolDisplayName(tool), tool).not.toBe("调用工具");
  });

  it("翻译内置工具动作但保留参数", () => {
    expect(localizeToolTitle("Read src/main.rs")).toEqual({
      action: "读取文件",
      target: "src/main.rs",
      rawTool: "Read",
    });
    expect(localizedToolTitleText("Bash cargo test --all")).toBe("执行命令 cargo test --all");
    expect(toolDisplayName("TaskUpdate")).toBe("更新任务");
  });

  it("中文上游标题原样保留", () => {
    expect(localizedToolTitleText("读取文件 README.md")).toBe("读取文件 README.md");
  });

  it("MCP 工具显示服务名并轻量翻译常见动作", () => {
    expect(localizeToolTitle("mcp__github__create_issue MonkeyCode")).toEqual({
      action: "调用 GitHub",
      target: "创建 事项 MonkeyCode",
      rawTool: "mcp__github__create_issue",
    });
  });

  it("未知工具使用可读兜底且保留原名", () => {
    expect(localizeToolTitle("CustomSearchTool keyword")).toEqual({
      action: "调用工具",
      target: "Custom 搜索 Tool keyword",
      rawTool: "CustomSearchTool",
    });
  });

  it("英文模式恢复原始工具名", () => {
    expect(localizeToolTitle("WebSearch Rust news", "en")).toEqual({
      action: "WebSearch",
      target: "Rust news",
      rawTool: "WebSearch",
    });
  });
});
