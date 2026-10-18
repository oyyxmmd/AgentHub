// 反代网关 · 事件广播：请求完成 / OAuth 结果等按运行形态分发——Electron 推渲染层 IPC，
// headless 走结构化日志（见 platform/index.cjs）
"use strict";

const platform = require("./platform/index.cjs");

function emit(payload) {
  platform.emit(payload);
}

module.exports = { emit };
