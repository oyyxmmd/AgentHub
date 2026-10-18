// 反代网关 · 平台适配层 · 纯 Node 实现（Docker headless 形态）
// 无 Electron 环境时：能做的做（结构化日志），不能做的诚实拒绝（人机校验交回 needCaptcha）。
// 日志统一过 redact——容器日志会被 docker logs / 采集器落盘，凭据明文不得进日志。
"use strict";

let redact = (s) => String(s);
try { redact = require("../redact.cjs").redact; } catch { /* redact 不可用时原样输出 */ }

function log(level, msg, meta) {
  const text = meta === undefined ? String(msg) : `${msg} ${JSON.stringify(meta)}`;
  (console[level] || console.log)(redact(text));
}

// request 事件每请求一条，日志按 5% 采样；订阅者（SSE）永远收到全部事件
const REQUEST_LOG_SAMPLE = 0.05;

/** 事件订阅（网关 SSE 广播用）：返回退订函数 */
const emitListeners = new Set();
function onEmit(fn) {
  emitListeners.add(fn);
  return () => emitListeners.delete(fn);
}

module.exports = {
  emit(payload) {
    const t = payload && payload.type;
    if (!t) return;
    if (t !== "request" || Math.random() < REQUEST_LOG_SAMPLE) log("log", `[gateway] ${t}`, payload);
    for (const fn of emitListeners) {
      try {
        fn(payload);
      } catch {
        /* 单个订阅者异常不影响其它 */
      }
    }
  },

  onEmit,

  getDataDir() {
    return require("../../config.cjs").dataDir();
  },

  // 无图形环境：不假装能过人机校验，交回 needCaptcha 让调用方走人工
  // （桌面版号池页手动领取，账号经 WebDAV/S3 号池同步过来）
  solveCaptcha() {
    return Promise.resolve({
      ok: false,
      needCaptcha: true,
      message: "无图形环境无法过人机校验；请在桌面版号池页手动领取（账号经号池同步过来）",
    });
  },

  version() {
    // 上四级即仓库根（electron/backend/proxy/platform → 容器内 /app），读根 package.json 的版本
    try { return require("../../../../package.json").version || ""; } catch { return ""; }
  },

  log,

  // 无图形环境：打开外链/目录的调用点均为桌面 IPC，容器形态不可达，安静忽略
  openExternal() { return Promise.resolve(); },
  openPath() { return Promise.resolve(); },
};
