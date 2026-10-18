// Web 托管形态的事件订阅：fetch 流而非 EventSource（EventSource 带不了 Authorization）。
// 信封与桌面 IPC 的 app:event 完全同形（{event:"proxy", ...}），订阅方消费逻辑两种形态共用。
// 断线自动重连（1s 起指数退避到 30s，连上后复位）。
import { getToken } from "./web-transport";

export function subscribeWebEvents(cb: (payload: unknown) => void): () => void {
  let closed = false;
  let ctl: AbortController | null = null;
  let retryMs = 1000;

  const connect = async () => {
    if (closed) return;
    ctl = new AbortController();
    try {
      const res = await fetch("/api/events", {
        headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {},
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      retryMs = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue; // ": ka" 心跳等注释行跳过
            try {
              cb(JSON.parse(line.slice(5).trim()));
            } catch {
              /* 坏帧忽略 */
            }
          }
        }
      }
    } catch {
      /* 网络中断 / 服务重启：走下面的重试 */
    }
    if (closed) return;
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  };
  void connect();

  return () => {
    closed = true;
    try {
      ctl?.abort();
    } catch {
      /* 已中断 */
    }
  };
}
