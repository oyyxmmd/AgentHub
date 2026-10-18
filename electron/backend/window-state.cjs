// 轻量模式的**窗口状态持久化**：记住尺寸/位置/最大化，销毁窗口后重建时原样恢复。
//
// 为什么必须有它：销毁窗口会丢掉一切渲染层状态。若不落盘，用户点托盘「显示主界面」
// 会得到一个 1280×820 居中窗口 —— 那等于每次轻量化都把用户的窗口摆放清一次，
// 体验上不可接受（改造前 hide() 不丢状态，所以这是引入 destroy 必须一起补的功课）。
//
// 职责边界：这里只管**窗口几何**（只有主进程知道）。用户停留的页面由渲染层的
// localStorage 自己记住（与 agenthub.fx 同款镜像做法），无需 IPC 往来。
//
// 越界保护：显示器拔掉/分辨率变化后，旧坐标可能落在已不存在的屏幕上（窗口"打开但看不见"）。
// clampBounds 是纯函数，不 require electron —— displays 由调用方从 screen 模块传入，
// 既方便自测覆盖各种畸形输入，也避免把 Electron 依赖带进 backend。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** 至少要有这么多像素留在屏内，才认为这个坐标可用（够抓住标题栏拖回来） */
const MIN_VISIBLE = 80;
/** 与 main.cjs 的 BrowserWindow minWidth/minHeight 保持一致，防止恢复出比下限更小的窗口 */
const MIN_W = 920;
const MIN_H = 640;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function statePath(dataDir) {
  return path.join(dataDir, "window-state.json");
}

/** 读取状态：任何异常/畸形都退回空对象，绝不因状态文件损坏而影响启动 */
function load(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(dataDir), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

/** 写入状态：先写临时文件再原子替换（与 config.cjs 落盘同款，断电不留半个 JSON） */
function save(dataDir, state) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const p = statePath(dataDir);
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false; // 状态存不下只影响下次恢复位置，不该打断关窗流程
  }
}

/** 只取需要的字段，避免把外部塞进来的任意键写进磁盘 */
function pickState(input) {
  const it = input || {};
  const out = {};
  const b = it.bounds;
  if (b && typeof b === "object") {
    const w = Math.round(Number(b.width));
    const h = Math.round(Number(b.height));
    if (isNum(w) && isNum(h)) {
      out.bounds = { width: w, height: h };
      if (isNum(b.x) && isNum(b.y)) {
        out.bounds.x = Math.round(b.x);
        out.bounds.y = Math.round(b.y);
      }
    }
  }
  if (it.maximized === true) out.maximized = true;
  return out;
}

/**
 * 把窗口矩形收敛到「某块屏幕上看得见」的位置。
 *
 * @param {{x?:number,y?:number,width?:number,height?:number}} bounds 期望矩形（可能含非法值）
 * @param {Array<{workArea:{x:number,y:number,width:number,height:number}}>} displays 屏幕列表（screen.getAllDisplays()）
 * @param {{width:number,height:number}} fallback 无可用屏幕时的默认尺寸
 * @returns {{x?:number,y?:number,width:number,height:number,adjusted:boolean,reason:string}}
 */
function clampBounds(bounds, displays, fallback) {
  const fb = fallback || { width: 1280, height: 820 };
  const list = (Array.isArray(displays) ? displays : []).filter(
    (d) => d && d.workArea && isNum(d.workArea.width) && isNum(d.workArea.height) && d.workArea.width > 0 && d.workArea.height > 0
  );
  if (!list.length) {
    return { width: fb.width, height: fb.height, adjusted: true, reason: "no-display" };
  }
  const primary = list[0];
  const b = bounds || {};

  // 尺寸：非法就用默认；再夹到「主屏工作区」内，避免恢复出比屏幕还大的窗口。
  // sizeChanged 必须单独记：夹尺寸也是"调整过"，不能对调用方谎报 adjusted=false
  // （调用方据此决定要不要落盘回写与写日志）。
  const wantW = isNum(b.width) ? Math.round(b.width) : fb.width;
  const wantH = isNum(b.height) ? Math.round(b.height) : fb.height;
  const width = Math.max(MIN_W, Math.min(wantW, primary.workArea.width));
  const height = Math.max(MIN_H, Math.min(wantH, primary.workArea.height));
  const sizeChanged = width !== wantW || height !== wantH;

  // 位置：没有可用坐标 → 交给 Electron 居中（返回不带 x/y）
  if (!isNum(b.x) || !isNum(b.y)) {
    return { width, height, adjusted: true, reason: "no-position" };
  }
  const x = Math.round(b.x);
  const y = Math.round(b.y);

  // 该矩形是否与某块屏幕有足够的可见交集
  const visibleOn = list.some((d) => {
    const wa = d.workArea;
    const ix = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x);
    const iy = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y);
    return ix >= MIN_VISIBLE && iy >= MIN_VISIBLE;
  });
  if (visibleOn) return { x, y, width, height, adjusted: sizeChanged, reason: sizeChanged ? "size-clamped" : "ok" };

  // 落在屏幕外（显示器被拔掉/换分辨率）：挪到主屏工作区内，并保证整窗可见
  const wa = primary.workArea;
  const nx = Math.max(wa.x, Math.min(x, wa.x + wa.width - MIN_VISIBLE));
  const ny = Math.max(wa.y, Math.min(y, wa.y + wa.height - MIN_VISIBLE));
  return {
    x: Math.max(wa.x, Math.min(nx, wa.x + wa.width - width)),
    y: Math.max(wa.y, Math.min(ny, wa.y + wa.height - height)),
    width,
    height,
    adjusted: true,
    reason: "offscreen",
  };
}

module.exports = { MIN_VISIBLE, MIN_W, MIN_H, statePath, load, save, pickState, clampBounds };
