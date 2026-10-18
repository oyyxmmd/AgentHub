// 号池定时同步调度（issue #89 / #92）：每 60s tick，命中 hourly / daily 规则则触发号池同步。
// 骨架与 usage-scheduler.cjs 一致：60s tick + 持久化记账（重启不重置，避免启动即同步）
// + 时间回拨保护 + 忙时跳过不推进记账（跨模块同步结束后自然补跑）。
// 号池同步携带 API Keys 与模型映射的共享配置包，定时化让「换台电脑」开箱即得（issue #92）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config.cjs");
const webdav = require("../webdav.cjs");

let timer = null;
let lastHourlyAt = 0;
let lastDailyDate = ""; // "YYYY-M-D"，当天已跑过 daily 记录

// ===== 记账持久化（proxy/poolsync-sched.json：重启后接着原节奏调度） =====

function stateFile() {
  const store = require("./store.cjs");
  return path.join(store.proxyDir(), "poolsync-sched.json");
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    lastHourlyAt = Number(s.lastHourlyAt) || 0;
    lastDailyDate = typeof s.lastDailyDate === "string" ? s.lastDailyDate : "";
  } catch {
    /* 首次启动视为从未触发 */
  }
}

function saveState() {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ lastHourlyAt, lastDailyDate }, null, 2), "utf8");
  } catch {
    /* 记账写失败仅意味着重启后可能多跑一次，不影响正确性 */
  }
}

/** 读取并钳制周期配置：非法值回默认，不写回（调度侧兜底，不阻塞设置页保存） */
function schedCfg() {
  const p = (config.loadConfig().proxy || {}).poolsyncSchedule || {};
  const dailyTime = typeof p.dailyTime === "string" && /^\d{1,2}:\d{2}$/.test(p.dailyTime.trim())
    ? p.dailyTime.trim()
    : "04:00";
  return {
    hourly: p.hourly === true,
    interval: Math.min(12, Math.max(1, Math.floor(Number(p.hourlyInterval) || 6))),
    daily: p.daily === true,
    dailyTime,
  };
}

function tick() {
  try {
    if (webdav.syncBusyTag()) return; // 其他模块同步中：不推进记账，结束后下轮补跑
    const c = schedCfg();
    if (!c.hourly && !c.daily) return;
    const poolsync = require("./poolsync.cjs");
    if (!poolsync.configured()) return;

    const now = Date.now();
    if (now < lastHourlyAt) lastHourlyAt = now; // 时间回拨保护：避免差值虚大导致立即误触发
    const d = new Date(now);
    const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const [h, m] = c.dailyTime.split(":").map(Number);
    // daily 优先：当天首次 tick 且已过设定时刻（追赶式补跑，错过不丢）
    const dailyDue = c.daily && today !== lastDailyDate && d.getHours() * 60 + d.getMinutes() >= h * 60 + m;
    const hourlyDue = c.hourly && now - lastHourlyAt >= c.interval * 60 * 60 * 1000;
    if (!dailyDue && !hourlyDue) return;

    lastHourlyAt = now;
    const prevDailyDate = lastDailyDate;
    if (dailyDue) lastDailyDate = today;
    saveState();
    // 失败回滚记账（审查整改）：busy 跳过不推进记账、真失败也不能吞掉整个周期——
    // daily 失败当天后续 tick 继续补跑，hourly 失败下一轮 tick 重试（60s 级）
    const hourlyDueWas = hourlyDue;
    const dailyDueWas = dailyDue;
    // 失败回滚记账（审查整改）：busy 跳过不推进记账、真失败也不能吞掉整个周期——
    // daily 失败当天后续 tick 继续补跑，hourly 失败下一轮 tick 重试（60s 级）。
    // poolsync.run() 在 state.running / tryBeginSync 被拒时是 **throw** 而非返回 ok:false，
    // 故回滚必须同时挂到 catch 上：原先 .catch(() => {}) 空吞会让这两条路径静默吞掉整个
    // 周期（daily 的 lastDailyDate 已被写成今天，当天再也补不回来）。
    const rollback = () => {
      lastHourlyAt = hourlyDueWas ? now - c.interval * 60 * 60 * 1000 + 60 * 1000 : lastHourlyAt;
      if (dailyDueWas) lastDailyDate = prevDailyDate;
      saveState();
    };
    poolsync.run({}).then((r) => {
      if (r && r.ok !== false) return;
      rollback();
    }).catch(rollback);
  } catch {
    /* 调度异常静默，下一轮重试 */
  }
}

function start() {
  if (timer) return;
  loadState();
  timer = setInterval(tick, 60 * 1000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop };
