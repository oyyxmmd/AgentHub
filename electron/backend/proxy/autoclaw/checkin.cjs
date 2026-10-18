// 反代网关 · AutoClaw 每日签到（参照实现 providers/autoclaw/checkin.rs）
//
// task_id: daily_signin 走「完成客户端任务」通用入口。判据的关键：**不能只看 HTTP 状态码**——
// 当天已签到时上游返回 HTTP 200 + success:false + already_completed:true + reward_points:0。
// 「本次真领到」的判据 = reward_points > 0 或 (success && !already_completed)。
"use strict";

const DAILY_SIGNIN_TASK_ID = "daily_signin";

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
  const code = Number(data.code);
  if (code === 410000 || code === 400000) return { ok: false, authError: true, message: "登录态已过期，无法签到" };
  if (code !== 0) {
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

module.exports = { DAILY_SIGNIN_TASK_ID, checkin, checkinStatus, taskListHint };
