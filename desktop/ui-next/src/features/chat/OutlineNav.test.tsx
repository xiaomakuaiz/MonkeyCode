import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OutlineItem } from "@/lib/ipc/controls";
import type { ChatItem } from "@/lib/protocol/types";
import { OutlineNav, outlineEntriesOf } from "./OutlineNav";

describe("outlineEntriesOf:目录 + 流内实时合并", () => {
  it("流内带 seq 的用户消息补到目录尾部;同 seq 以目录为准去重", () => {
    const outline: OutlineItem[] = [
      { seq: 1, offset: 0, text: "第一问", timestamp: new Date(2026, 0, 1, 9, 5).getTime() },
      { seq: 5, offset: 40, text: "第二问" },
    ];
    const items: ChatItem[] = [
      { kind: "user", text: "第二问", seq: 5 }, // 目录已有,不重复
      { kind: "agent", text: "回答" },
      { kind: "user", text: "刚发的第三问", seq: 9 }, // 尚未物化,从流内补
      { kind: "user", text: "无 seq 的旧记录" }, // 无锚,进不了大纲
    ];
    const entries = outlineEntriesOf(outline, items);
    expect(entries.map((e) => [e.seq, e.label])).toEqual([
      [1, "第一问"],
      [5, "第二问"],
      [9, "刚发的第三问"],
    ]);
    expect(entries[0]?.time).toBe("09:05");
    expect(entries[1]?.time).toBe("");
  });

  it("附件行剥离与截断:纯附件消息回退附件计数,长文截 60 字", () => {
    const entries = outlineEntriesOf(
      [
        { seq: 1, offset: 0, text: "[图片] .monkeycode/uploads/a.png\n[文件] .monkeycode/uploads/b.txt" },
        { seq: 2, offset: 0, text: `看看这个\n[图片] .monkeycode/uploads/c.png` },
        { seq: 3, offset: 0, text: "长".repeat(80) },
      ],
      [],
    );
    expect(entries[0]?.label).toBe("");
    expect(entries[0]?.attCount).toBe(2);
    expect(entries[1]?.label).toBe("看看这个");
    expect(entries[2]?.label).toBe(`${"长".repeat(60)}…`);
  });
});

describe("OutlineNav 交互", () => {
  const entries = outlineEntriesOf(
    [
      { seq: 1, offset: 0, text: "第一问" },
      { seq: 5, offset: 40, text: "" },
    ],
    [],
  );

  it("少于 2 条不占轨道", () => {
    render(<OutlineNav entries={entries.slice(0, 1)} onJump={() => {}} />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("悬停点列浮出面板;点条目回调 seq 并收起;空消息给兜底文案", () => {
    const onJump = vi.fn();
    render(<OutlineNav entries={entries} onJump={onJump} />);
    const nav = screen.getByRole("navigation", { name: "提问大纲" });
    expect(screen.queryByText("第一问")).toBeNull(); // 未悬停不浮面板
    fireEvent.mouseEnter(nav.firstElementChild!);
    expect(screen.getByText("第一问")).toBeTruthy();
    expect(screen.getByText("(空消息)")).toBeTruthy();
    fireEvent.click(screen.getByText("第一问"));
    expect(onJump).toHaveBeenCalledWith(1);
    expect(screen.queryByText("第一问")).toBeNull(); // 跳转即收起
  });
});
