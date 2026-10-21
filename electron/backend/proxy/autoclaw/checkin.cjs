// 反代网关 · AutoClaw 每日签到（协议事实：官方客户端实测）
//
// task_id: daily_signin 走「完成客户端任务」通用入口。判据的关键：**不能只看 HTTP 状态码**——
// 当天已签到时上游返回 HTTP 200 + success:false + already_completed:true + reward_points:0。
// 「本次真领到」的判据 = reward_points > 0 或 (success && !already_completed)。
"use strict";

const DAILY_SIGNIN_TASK_ID = "daily_signin";

/** 「登录」端点（客户端启动同款 user-info）：活动福利的发放钩子挂在它上面 */
const USER_INFO_PATH = "/userapi/v1/user-info";

/**
 * 签到主流程（纯协议函数）：
 *   env = { cfg, token, headers, httpJson, deviceId? }
 * 返回对齐 AgentHub 签到契约：{ ok, already?, message, credit?, reward? }；失效带 authError。
 */
async function checkin(env) {
  const { cfg, headers, httpJson } = env;
  const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
  const completeUrl = `${base}${cfg.taskCompletePath || "/autoclaw-proxy/proxy/autoclaw-task-complete"}`;
  const r = await httpJson(completeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ task_id: DAILY_SIGNIN_TASK_ID }),
  }).catch((e) => {
    throw new Error(`签到请求失败：${String((e && e.message) || e).slice(0, 120)}`);
  });
  if (r.status === 401) return { ok: false, authError: true, message: "登录态已过期，无法签到" };
  const data = r.data;
  if (!r.ok || !data || typeof data !== "object") {
    return { ok: false, message: `签到接口 HTTP ${r.status}` };
  }
  // 业务码只在**字段真的存在**时判：`Number(undefined)` 是 NaN，而 `NaN !== 0` 恒为真——
  // 上游成功响应不带 code 时会被整条判成「签到失败」（守住 `if let Some(code)` 这点）。
  const hasCode = data.code !== undefined && data.code !== null;
  const code = Number(data.code);
  if (hasCode && (code === 410000 || code === 400000)) return { ok: false, authError: true, message: "登录态已过期，无法签到" };
  if (hasCode && code !== 0) {
    return { ok: false, message: String(data.msg || data.message || "签到失败") };
  }
  const d = data.data && typeof data.data === "object" ? data.data : {};
  const rewardPoints = Number(d.reward_points) || 0;
  const alreadyCompleted = d.already_completed === true;
  const success = d.success === true;
  // 本次真领到：拿到正积分，或上游明确 success 且不是「已领过」回执
  const claimed = rewardPoints > 0 || (success && !alreadyCompleted);
  if (claimed) {
    const message = rewardPoints > 0 ? `签到成功，获得 ${rewardPoints} 积分` : "签到成功";
    return { ok: true, message, credit: rewardPoints, reward: rewardPoints };
  }
  if (alreadyCompleted) {
    return { ok: true, already: true, message: "今天已签到", credit: rewardPoints, reward: rewardPoints };
  }
  // 未领到且非「已领过」：拉任务列表归因（只读辅助，失败不升级错误）
  const hint = await taskListHint(env);
  return { ok: false, message: hint ? `签到未领取（${hint}）` : "签到未领取" };
}

/** task-list 归因：仅用于失败分支解释「为什么没领到」；接口失败返回空串（不拼进用户消息） */
async function taskListHint(env) {
  const { cfg, headers, httpJson } = env;
  try {
    const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
    const r = await httpJson(`${base}${cfg.taskListPath || "/autoclaw-proxy/proxy/autoclaw-task-list"}`, {
      method: "GET",
      headers,
    });
    const data = r.data;
    if (!r.ok || !data || Number(data.code) !== 0 || !Array.isArray(data.data)) return "";
    const hit = data.data.find((t) => t && t.task_id === DAILY_SIGNIN_TASK_ID);
    if (hit && hit.completed === true) return "任务列表显示今天已完成";
  } catch { /* 辅助查询失败静默 */ }
  return "";
}

/**
 * 「登录活跃」触发：POST user-info（客户端启动时打的同一个动作）。
 *
 * 活动福利（Weekly Perks / 登录奖励这类「活跃即发」的活动）**没有领取接口**，服务端把
 * 「登录」的判据挂在这个动作上（2026-10-15 逐条实测：签到本身、refresh 强制刷新、
 * home-fetch 都不触发发放，只有 user-info 打下去才入账）。签到后顺手触发一次，用户当天
 * 开过客户端时这一步是幂等的、不会重复入账。
 *
 * 返回是否成功打出这次请求；**失败静默**——活动福利是签到之外的附加收益，绝不因它把一次
 * 真签到判成失败（与 balance.cjs「订阅失败不影响积分结果」同一取向）。
 */
async function triggerLoginActive(env) {
  const { cfg, headers, httpJson, deviceId } = env;
  const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
  const r = await httpJson(`${base}${cfg.userInfoPath || USER_INFO_PATH}`, {
    method: "POST",
    headers,
    // body 与客户端 withWebInfo 一致：source_id + device_id（device_id 可能为空串）
    body: JSON.stringify({ source_id: "autoclaw", device_id: deviceId || "" }),
  });
  return !!(r && r.ok);
}

/**
 * 签到状态探测（只读）：task-list 里 daily_signin 的 completed 字段。
 * 列表拿不到 → unavailable（不是假装可领）；completed → already。
 */
async function checkinStatus(env) {
  const { cfg, headers, httpJson } = env;
  try {
    const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
    const r = await httpJson(`${base}${cfg.taskListPath || "/autoclaw-proxy/proxy/autoclaw-task-list"}`, {
      method: "GET",
      headers,
    });
    if (r.status === 401) return { authError: true, message: "登录态已过期" };
    const data = r.data;
    if (!r.ok || !data || Number(data.code) !== 0 || !Array.isArray(data.data)) {
      return { ok: false, unavailable: true, message: `任务列表 HTTP ${r.status}` };
    }
    const hit = data.data.find((t) => t && t.task_id === DAILY_SIGNIN_TASK_ID);
    if (!hit) return { ok: false, unavailable: true, message: "任务列表无每日签到项" };
    if (hit.completed === true) return { ok: true, already: true, message: "今天已签到" };
    return { ok: true, claimable: true, message: "今日可签到" };
  } catch (e) {
    return { ok: false, unavailable: true, message: `任务列表请求失败：${String((e && e.message) || e).slice(0, 120)}` };
  }
}

module.exports = { DAILY_SIGNIN_TASK_ID, USER_INFO_PATH, checkin, checkinStatus, taskListHint, triggerLoginActive };
