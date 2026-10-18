// 反代网关 · Cline 续期（POST {apiBase}/auth/refresh）
//
// 协议事实（2026-09 参考实现 agent2api 实测，三处口径别按直觉改）：
// ① **grantType 是 camelCase**（不是 OAuth 标准的 grant_type），源实现 @cline/core
//    的 gB() 发的就是这个键名；
// ② 返回的 accessToken 是**裸 JWT 不带 workos: 前缀**（登录返回的带），而发请求
//    必须带 —— 写入前统一过 ensureTokenPrefix；
// ③ expiresAt 是 ISO 8601 字符串（providers.json 里那个毫秒 expiresAt 是两种形态，
//    parseExpiresAt 两种都认）。
//
// refreshToken 协议允许轮换（实测本次返回同一个值）：响应给新值就用新值，旧值作废
// 是正常语义。并发互斥（single-flight）由 adapters.refreshTokenLocked 统一提供，
// 这里只做单次刷新。刷新结果**要落库**：AgentHub 的账号记录是自己的库（DPAPI 加密），
// 不是 Cline 客户端文件——providers.json 绝不回写（方案 §9）。
"use strict";
const credentials = require("./credentials.cjs");
const headersMod = require("./headers.cjs");

/** 上游错误体 → 可读文案（{"error":"..."} 与 {"error":{"code":..,"message":..}} 都认） */
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
 * 单次续期（纯协议函数，由 adapter.refreshToken 调用）：
 *   p = { cfg, refreshToken, httpJson }
 * 成功返回 { ok, token, refreshToken, expiresAt }（token 已统一补 workos: 前缀）；
 * refreshToken 被拒绝返回 { ok: false, authError: true, message }（上层标 relogin）；
 * 其它失败返回 { ok: false, message }。
 */
async function refreshToken(p) {
  const { cfg, refreshToken, httpJson } = p;
  if (!refreshToken) return { ok: false, message: "无 refreshToken，请重新登录或导入登录态" };
  const base = String(cfg.apiBase || "https://api.cline.bot/api/v1").replace(/\/+$/, "");
  // 伪装头走唯一实现（与对话/登录同一口径）：空串=不发、协议必需头拒绝覆盖
  const headers = headersMod.buildUpstreamHeaders(cfg, { "content-type": "application/json", accept: "application/json" });
  const r = await httpJson(`${base}${cfg.refreshPath || "/auth/refresh"}`, {
    method: "POST",
    headers,
    // 键名照抄源实现：camelCase 的 grantType（不是 grant_type）
    body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
  }).catch((e) => ({ status: 0, ok: false, data: null, text: String((e && e.message) || e) }));
  const d = r.data;
  if (r.status === 401 || r.status === 403) {
    return { ok: false, authError: true, message: "Cline 登录态已失效（refreshToken 被拒绝），请重新登录" };
  }
  if (!r.ok || !d) {
    return { ok: false, message: `Cline 续期失败（HTTP ${r.status}）：${upstreamErrorMessage(d, String(r.text || "").slice(0, 120))}` };
  }
  const data = d.data || d;
  const accessToken = String(data.accessToken || "").trim();
  if (!accessToken) return { ok: false, message: "Cline 续期响应缺少 accessToken，旧凭证未被覆盖" };
  return {
    ok: true,
    // 续期返回的是裸 JWT（登录返回的带前缀），统一补上（幂等）
    token: credentials.ensureTokenPrefix(accessToken),
    // 协议允许轮换：响应给新值就用新值，没给沿用旧值
    refreshToken: String(data.refreshToken || "").trim() || refreshToken,
    expiresAt: credentials.parseExpiresAt(data.expiresAt),
  };
}

module.exports = { refreshToken, upstreamErrorMessage };
