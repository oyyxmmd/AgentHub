// 反代网关 · 平台适配层 · Electron 实现（桌面壳）
// 各模块里散落的 require("electron") 收敛到这里；config 相关一律惰性 require，
// 避免顶层加载顺序耦合（config.cjs 顶层自带 electron 探测）
"use strict";

/** 事件订阅：桌面形态的事件主通道是 IPC 推送，这里同样支持订阅（网关 SSE 与语义对齐） */
const emitListeners = new Set();
function onEmit(fn) {
  emitListeners.add(fn);
  return () => emitListeners.delete(fn);
}

module.exports = {
  // 事件广播：推给所有渲染窗口（events.cjs 的出口）
  emit(payload) {
    try {
      const { BrowserWindow } = require("electron");
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("app:event", { event: "proxy", ...payload });
      }
    } catch { /* 无窗口时静默 */ }
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

  // 人机校验：内嵌沙箱验证窗跑阿里云官方 SDK（zcodeCapture 是本能力的唯一实现）
  solveCaptcha(cfg, opts) {
    return require("../zcodeCapture.cjs").solveCaptcha(cfg, opts);
  },

  version() {
    try { return require("electron").app.getVersion(); } catch { return ""; }
  },

  log(level, msg, meta) {
    const text = meta === undefined ? String(msg) : `${msg} ${JSON.stringify(meta)}`;
    let line = text;
    try { line = require("../redact.cjs").redact(text); } catch { /* redact 不可用时原样 */ }
    (console[level] || console.log)(line);
  },

  openExternal(url) {
    return require("electron").shell.openExternal(String(url)).catch(() => {});
  },

  openPath(p) {
    return require("electron").shell.openPath(String(p)).catch(() => {});
  },
};
