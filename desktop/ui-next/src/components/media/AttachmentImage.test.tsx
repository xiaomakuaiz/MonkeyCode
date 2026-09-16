import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AttachmentImage } from "./AttachmentImage";

describe("云端附件图片", () => {
  it("显示加载状态，失败可重试", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("expired")).mockResolvedValue("data:image/png;base64,AA==");
    render(<AttachmentImage url="/api/v1/assets?key=image.png" load={load} alt="image.png" />);
    expect(screen.getByRole("status")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "图片加载失败，点击重试" }));
    expect((await screen.findByRole("img")).getAttribute("src")).toBe("data:image/png;base64,AA==");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("URL/账号读取通道变化后，迟到结果不能盖回旧图片", async () => {
    let finishOld!: (src: string) => void;
    const oldLoad = vi.fn(() => new Promise<string>((resolve) => { finishOld = resolve; }));
    const newLoad = vi.fn(() => Promise.resolve("data:image/png;base64,NEW"));
    const { rerender } = render(<AttachmentImage url="/api/v1/assets?key=old.png" load={oldLoad} alt="图片" />);
    await waitFor(() => expect(oldLoad).toHaveBeenCalledOnce());
    rerender(<AttachmentImage url="https://oss.example/new.png?signature=ws" load={newLoad} alt="图片" />);
    expect((await screen.findByRole("img")).getAttribute("src")).toBe("data:image/png;base64,NEW");
    await act(async () => finishOld("data:image/png;base64,OLD"));
    expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,NEW");

    const nextAccount = vi.fn(() => new Promise<string>(() => {}));
    rerender(<AttachmentImage url="https://oss.example/new.png?signature=ws" load={nextAccount} alt="图片" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
