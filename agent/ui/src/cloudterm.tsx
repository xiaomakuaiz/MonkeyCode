// 云端 VM 终端:xterm.js + 内核代理 WS(协议对齐 web 端 common/terminal.tsx:
// 文本 JSON 帧 {type,data};上行 data=base64(输入)/resize=JSON{row,col}/5s ping;
// 下行 connected/data(base64)/resize/error/ping)。terminal_id 每次挂载新生成,
// 关掉面板即结束会话;共享/多 tab 等高级能力留给网页控制台。
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { cloudTerminalURL } from "./client";
import { MONO } from "./components";

export function CloudTerminal({ vmId }: { vmId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("连接终端…");

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: MONO,
      cursorBlink: true,
      theme: { background: "#1c1e22", foreground: "#d8dee9" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const b64 = {
      enc: (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))),
      dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
    };

    const ws = new WebSocket(cloudTerminalURL(vmId, crypto.randomUUID()));
    let closed = false;
    let ping: ReturnType<typeof setInterval> | null = null;

    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "resize", data: JSON.stringify({ row: term.rows, col: term.cols }) }));
    };

    ws.onopen = () => {
      setStatus("");
      sendResize();
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 5000);
    };
    ws.onmessage = (ev) => {
      let m: { type?: string; data?: string };
      try {
        m = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (m.type) {
        case "data":
          if (m.data) term.write(b64.dec(m.data));
          break;
        case "connected":
          setStatus("");
          break;
        case "error":
          setStatus(m.data || "终端出错");
          break;
        default: // ping/resize 等
      }
    };
    ws.onclose = () => {
      if (!closed) setStatus("终端连接已断开");
    };

    const offData = term.onData((input) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "data", data: b64.enc(input) }));
    });

    // 面板尺寸变化自适应并上报
    const ro = new ResizeObserver(() => {
      fit.fit();
      sendResize();
    });
    ro.observe(el);

    return () => {
      closed = true;
      if (ping) clearInterval(ping);
      ro.disconnect();
      offData.dispose();
      ws.close();
      term.dispose();
    };
  }, [vmId]);

  return (
    <div style={{ position: "relative", height: "100%", minHeight: 0, background: "#1c1e22" }}>
      <div ref={hostRef} style={{ position: "absolute", inset: "6px 0 6px 10px" }} />
      {status && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, color: "#8a919c", pointerEvents: "none" }}>
          {status}
        </div>
      )}
    </div>
  );
}
