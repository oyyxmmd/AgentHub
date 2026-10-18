// 反代网关 · AutoClaw token 刷新（参照实现 providers/autoclaw/refresh.rs）
//
// 关键取舍（方案 §7）：刷新结果**不落盘不落库**，只进适配器进程级凭证缓存。
// 理由：AutoClaw 桌面端的 auth.json 是 safeStorage 加密登录态，服务端轮换 refresh_token
// 后网关若持久化新值会与桌面端自己的刷新互相顶掉（掉登录根因）；代价是网关重启后
// 可能要用库里旧 refresh_token 再刷一次（服务端宽限期内有效）。
"use strict";

const REFRESH_FALLBACK_CODE = 400002;

/** 剥 Bearer 前缀（服务端返回的 token 可能自带） */
function stripBearer(v) {
  const s = String(v || "").trim();
  return s.replace(/^Bearer\s+/i, "").trim();
}

/**
 * 刷新主流程（纯协议函数）：
 *   env = { cfg, refreshToken, token, deviceId?, httpJson }
 * 头由调用方给（headers：signedAuthHeaders 产物，authorization 用当前 access token）。
 * 成功返回 { ok, token, refreshToken, expiresAt, userId, noPersist: true }；
 * 失效返回 { ok: false, authError: true, message }；其余 { ok: false, message }。
 */
async function refreshToken(env) {
  const { cfg, headers, httpJson } = env;
  const rt = stripBearer(env.refreshToken);
  if (!rt) return { ok: false, message: "无 refreshToken，请重新导入或登录" };
  const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
  const body = { refresh_token: rt, source_id: "autoclaw" };
  if (env.deviceId) body.device_id = env.deviceId;

  const call = async (path) =>
    httpJson(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }).catch((e) => {
      throw new Error(`AutoClaw 刷新接口请求失败：${String((e && e.message) || e).slice(0, 120)}`);
    });

  let r = await call(cfg.refreshPath || "/userapi/v1/refresh");
  // 400002 = /userapi/v1/refresh 签名校验失败 → 同头同 body 降级 agent-refresh 再试一次
  if (r.data && Number(r.data.code) === REFRESH_FALLBACK_CODE) {
    r = await call(cfg.refreshFallbackPath || "/userapi/v1/agent-refresh");
  }
  if (r.status === 401) return { ok: false, authError: true, message: "登录态已过期，请重新导入或登录" };
  const data = r.data;
  if (!r.ok || !data || typeof data !== "object") {
    return { ok: false, message: `AutoClaw 刷新接口失败（HTTP ${r.status}）` };
  }
  const code = Number(data.code);
  if (code === 401 || code === 410000) return { ok: false, authError: true, message: "登录态已过期，请重新导入或登录" };
  if (code !== 0) {
    const msg = String(data.msg || data.message || "服务器未返回新 token");
    return { ok: false, message: `AutoClaw token 刷新失败 code=${code} msg=${msg}` };
  }
  const d = data.data && typeof data.data === "object" ? data.data : {};
  const token = stripBearer(d.access_token);
  if (!token) return { ok: false, message: "AutoClaw token 刷新失败：服务器未返回新 token" };
  // refresh_token 轮换制：缺失/空 → 沿用旧值
  const nextRt = stripBearer(d.refresh_token) || rt;
  // expiresAt 取新 access token 的 JWT exp（解不出沿用 0 = 未知）
  let expiresAt = 0;
  let userId = "";
  try {
    const { jwtDecode } = require("../util.cjs");
    const payload = jwtDecode(token);
    if (payload && payload.exp) expiresAt = Number(payload.exp) * 1000;
    if (payload && payload.user_id) userId = String(payload.user_id);
  } catch { /* 非 JWT 形态：到期未知，不阻断 */ }
  return { ok: true, token, refreshToken: nextRt, expiresAt, userId, noPersist: true };
}

module.exports = { refreshToken, stripBearer, REFRESH_FALLBACK_CODE };
