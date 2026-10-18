// 反代网关 · 平台适配层入口：按运行环境分发到 Electron 或纯 Node 实现
// 上层模块（events / adapters / poolsync / 网关入口等）只许 require 本文件，
// 绝不直接 require("electron")——同一份代码因此能在桌面壳与 headless 容器下运行。
//
// isElectron 判定三条铁律：
//   ① electron 包在纯 Node 下 require 不报错、而是返回可执行文件路径（truthy），
//      不能用 !!require("electron") 判定；
//   ② ELECTRON_RUN_AS_NODE 下 versions.electron 仍在但 electron API 全不可用
//      （require 只拿得到路径字符串；项目自测全走该通道），该模式按 node 处理；
//   ③ 其余以 versions.electron 为准。
"use strict";

const isElectron = !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE;

const impl = isElectron ? require("./electron.cjs") : require("./node.cjs");

// 启动期契约断言（与 adapters 的 assertAdapterContract 同构）：新增平台能力时两个实现
// 缺一即在 require 阶段 fail-fast，而不是运行到调用点才炸出 undefined
const REQUIRED_PLATFORM_METHODS = ["emit", "onEmit", "getDataDir", "solveCaptcha", "version", "log", "openExternal", "openPath"];
for (const m of REQUIRED_PLATFORM_METHODS) {
  if (typeof impl[m] !== "function") {
    throw new Error(`平台实现（${isElectron ? "electron" : "node"}）缺少必需方法 ${m}()`);
  }
}

module.exports = {
  isElectron,
  form: () => (isElectron ? "electron" : "node"),
  emit: impl.emit,
  onEmit: impl.onEmit,
  getDataDir: impl.getDataDir,
  solveCaptcha: impl.solveCaptcha,
  version: impl.version,
  log: impl.log,
  openExternal: impl.openExternal,
  openPath: impl.openPath,
};
