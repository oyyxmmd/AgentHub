// 轻量模式（Lightweight Mode）的**纯决策逻辑**：不 require electron，便于自测直接覆盖。
//
// 背景（为什么需要它）：
//   应用是托盘常驻形态（反代网关/定时同步/记忆中枢都在主进程跑），窗口只是「看板」。
//   实测：hide() 只是把窗口藏起来，渲染进程照旧常驻（本机实测 390.1 → 390.3 MB，
//   渲染进程 151.2 → 148.0 MB，等于没省）；只有 destroy() 才会让渲染进程整只消失。
//   真实实例里渲染进程单独占 298 MB，而空闲 CPU 实测 ≈0% —— 所以这是个**内存**问题。
//
// 语义边界（务必与 main.cjs 的 close 分支一致）：
//   · quitting         —— 托盘「退出」/更新重启：放行，真正退出
//   · minimizeToTray=false —— 用户没开托盘常驻：关窗即释放（改造前就是这个行为，不动它）
//   · minimizeToTray=true  —— 关窗缩到托盘：lightweightMode 决定「藏」还是「放」
"use strict";

/** 关窗动作：quit=放行真退出 / hide=仅隐藏（保留渲染进程）/ destroy=销毁窗口（释放渲染进程） */
const ACTIONS = Object.freeze(["quit", "hide", "destroy"]);

/**
 * 决定「用户点了关闭按钮」时该做什么。
 *
 * @param {{quitting?: boolean, minimizeToTray?: boolean, lightweightMode?: boolean}} input
 * @returns {"quit"|"hide"|"destroy"}
 */
function decideCloseAction(input) {
  const it = input || {};
  if (it.quitting === true) return "quit";
  // 没开托盘常驻：关窗就是关窗（既有行为）。此时应用仍靠托盘活着，
  // 但窗口本身会被销毁 —— 与轻量模式殊途同归，故直接归到 destroy。
  if (it.minimizeToTray !== true) return "destroy";
  return it.lightweightMode === true ? "destroy" : "hide";
}

/** 该动作是否真的销毁窗口（用于日志与托盘文案，避免各处再写一遍字符串比较） */
function releasesRenderer(action) {
  return action === "destroy";
}

/**
 * 托盘/设置页共用的开关可用性判定：未开托盘常驻时，轻量开关没有意义
 * （关窗本来就释放渲染进程），此时应置灰并给出解释，而不是让用户点了没反应。
 *
 * @param {{minimizeToTray?: boolean}} input
 * @returns {{enabled: boolean, reason: string}}
 */
function lightweightToggleState(input) {
  const it = input || {};
  if (it.minimizeToTray !== true) {
    return { enabled: false, reason: "已关闭「关闭最小化到托盘」：关窗本身就会释放界面，无需轻量模式" };
  }
  return { enabled: true, reason: "" };
}

module.exports = { ACTIONS, decideCloseAction, releasesRenderer, lightweightToggleState };
