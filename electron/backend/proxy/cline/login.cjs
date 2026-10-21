// 反代网关 · Cline 登录（WorkOS 设备授权，RFC 8628 四步）
//
// 协议事实（2026-09 实测）：
// ① POST {workosBase}/user_management/authorize/device（form：client_id）
//    → { device_code, user_code, verification_uri, verification_uri_complete, expires_in:300, interval:5 }
// ② 用户在浏览器打开 verification_uri_complete 确认（不需要本地回调端口，少一处失败面）
// ③ POST {workosBase}/user_management/authenticate（form：grant_type=urn:ietf:params:oauth:grant-type:device_code
//    &device_code&client_id，每 interval 秒轮询）
//    → 200 { access_token, refresh_token }（已确认）
//    → 400 authorization_pending（继续轮询）/ slow_down（拉长间隔）
//    → 400 expired_token / access_denied（终止）
// ④ POST {apiBase}/auth/register（JSON：WorkOS 令牌对）→ data{ accessToken, refreshToken, ... }
//    **不能省**：WorkOS 给的是身份令牌，还要经 Cline 的 /auth/register 换成它自己的
//    会话令牌（带 workos: 前缀 + accountId），才能打 LLM 端点。
//
// 本文件只提供纯协议函数（无轮询循环）：轮询编排在 discovery.beginClineOAuth
// 的 oauthSession tick 里（与其它渠道同一套会话/超时/取消机制，少一套状态管理）。
"use strict";
const credentials = require("./credentials.cjs");
const headersMod = require("./headers.cjs");

/** 表单 POST（WorkOS 两个端点都是 x-www-form-urlencoded，不是 JSON） */
async function postForm(cfg, path, body, httpJson) {
  const base = String(cfg.workosBase || "https://api.workos.com").replace(/\/+$/, "");
  const r = await httpJson(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  }).catch((e) => ({ status: 0, ok: false, data: null, text: String((e && e.message) || e) }));
  return r;
}

/**
 * 第一步：发起设备授权。
 * 成功返回 { ok, deviceCode, userCode, verificationUri, verificationUriComplete, intervalMs }；
 * 失败返回 { ok: false, message }。
 */
async function startDeviceAuth(cfg, httpJson) {
  const path = cfg.workosDevicePath || "/user_management/authorize/device";
  const r = await postForm(cfg, path, { client_id: cfg.workosClientId || "" }, httpJson);
  const d = r.data;
  if (!r.ok || !d) {
    const detail = (d && (d.error_description || d.error)) || `HTTP ${r.status}`;
    return { ok: false, message: `设备授权请求失败：${detail}` };
  }
  const deviceCode = String(d.device_code || "").trim();
  const userCode = String(d.user_code || "").trim();
  if (!deviceCode || !userCode) return { ok: false, message: "设备授权响应缺少 device_code / user_code" };
  const interval = Math.max(1, Number(d.interval) || 5);
  return {
    ok: true,
    deviceCode,
    userCode,
    verificationUri: String(d.verification_uri || "").trim() || cfg.deviceVerifyFallback || "https://authkit.cline.bot/device",
    verificationUriComplete: String(d.verification_uri_complete || "").trim(),
    intervalMs: interval * 1000,
    // 设备码有效期（实测 300s）：会话超时应跟随它，而不是套用通用渠道的 3 分钟——
    // 上游允许用户在 5 分钟内确认，本机更早放弃会让用户白等一次
    expiresIn: Math.max(1, Number(d.expires_in) || 300),
  };
}

/** 轮询结果分类：confirmed（拿到令牌）/ pending（继续等）/ slowDown / failed（终局） */
function classifyPollResult(status, data) {
  const errCode = String((data && data.error) || "").trim().toLowerCase();
  if (status >= 200 && status < 300) {
    const accessToken = String((data && data.access_token) || "").trim();
    const refreshToken = String((data && data.refresh_token) || "").trim();
    if (accessToken && refreshToken) return { kind: "confirmed", accessToken, refreshToken };
    return { kind: "failed", message: "设备授权响应缺少令牌（access_token / refresh_token）" };
  }
  if (errCode === "authorization_pending") return { kind: "pending" };
  if (errCode === "slow_down") return { kind: "slowDown" };
  if (errCode === "expired_token") return { kind: "failed", message: "授权码已过期，请重新发起登录" };
  if (errCode === "access_denied") return { kind: "failed", message: "登录被拒绝（用户在授权页取消了）" };
  return { kind: "failed", message: `登录轮询失败（HTTP ${status}）${errCode ? `：${errCode}` : ""}` };
}

/**
 * 第三步：轮询一次 authenticate。
 * 返回 { kind: "confirmed", accessToken, refreshToken } / { kind: "pending" }
 * / { kind: "slowDown" } / { kind: "failed", message }。
 */
async function pollDeviceToken(cfg, deviceCode, httpJson) {
  const path = cfg.workosTokenPath || "/user_management/authenticate";
  const r = await postForm(cfg, path, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: cfg.workosClientId || "",
  }, httpJson);
  return classifyPollResult(r.status, r.data);
}

/** 错误体 → 可读文案（{"error":"..."} 与 {"error":{"code":..,"message":..}} 两种形态都认） */
function upstreamErrorMessage(data, fallback) {
  if (data && data.error) {
    if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
    if (typeof data.error === "object") {
      const msg = String(data.error.message || "").trim();
      if (msg) return msg;
    }
  }
  return fallback || "上游错误";
}

/**
 * 第四步：WorkOS 令牌 → Cline 会话令牌（**不能省**）。
 * 成功返回 { ok, accessToken, refreshToken }；失败返回 { ok: false, message }。
 */
async function registerSession(cfg, workosAccessToken, workosRefreshToken, httpJson) {
  const base = String(cfg.apiBase || "https://api.cline.bot/api/v1").replace(/\/+$/, "");
  // 伪装头走唯一实现（默认值 ∪ 逐键覆盖；空串=不发；协议必需头拒绝覆盖），与对话/续期同一口径
  const headers = headersMod.buildUpstreamHeaders(cfg, { "content-type": "application/json", accept: "application/json" });
  const r = await httpJson(`${base}${cfg.registerPath || "/auth/register"}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ accessToken: workosAccessToken, refreshToken: workosRefreshToken }),
  }).catch((e) => ({ status: 0, ok: false, data: null, text: String((e && e.message) || e) }));
  const d = r.data;
  if (!r.ok || !d) {
    return { ok: false, message: `令牌登记失败（HTTP ${r.status}）：${upstreamErrorMessage(d, String(r.text || "").slice(0, 120))}` };
  }
  const data = d.data || d;
  const accessToken = String(data.accessToken || "").trim();
  if (!accessToken) return { ok: false, message: "令牌登记响应缺少 accessToken" };
  return {
    ok: true,
    accessToken: credentials.ensureTokenPrefix(accessToken),
    refreshToken: String(data.refreshToken || "").trim() || workosRefreshToken,
  };
}

module.exports = { startDeviceAuth, pollDeviceToken, registerSession, classifyPollResult, upstreamErrorMessage };
