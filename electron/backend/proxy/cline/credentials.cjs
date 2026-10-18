// 反代网关 · Cline 凭据层（workos: 前缀 + JWT 解析 + 桌面端 providers.json 读取）
//
// 协议事实（2026-09 参考实现 agent2api 实测）：
// ① accessToken 带 workos: 前缀，发请求必须原样带上（去掉 401）——
//    该前缀是 Cline 标记「这是 WorkOS 令牌」的，不是可选装饰；
// ② providers.json（~/.cline/data/settings/providers.json → providers.cline.settings.auth）
//    的 expiresAt 是毫秒；/auth/refresh 响应的 expiresAt 是 ISO 8601 字符串——
//    同名不同型，解析按两种形态都认（parseExpiresAt）；
// ③ 账号 id（usr-... 形态，余额路径 /users/{userId}/balance 认的那个）在 JWT 的
//    external_id 声明里（sub 是 WorkOS 自己的 user_...，不能用于 Cline API 路径）。
//
// AgentHub 的导入纪律与参考实现不同：providers.json 是 Cline 客户端自己的文件，
// 导入即**复制**凭据入 AgentHub 账号库（DPAPI 加密落库），运行时不再回读客户端文件、
// 也绝不回写它——续期结果只回写 AgentHub 自己的账号记录（方案 §9）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/** access token 必需前缀（实测：去掉它上游 401） */
const TOKEN_PREFIX = "workos:";

/** 幂等补 workos: 前缀（登录返回带前缀、续期返回裸 JWT、用户手填两种形态都规范化） */
function ensureTokenPrefix(token) {
  const t = String(token || "").trim();
  if (!t) return "";
  return t.startsWith(TOKEN_PREFIX) ? t : `${TOKEN_PREFIX}${t}`;
}

/** 解出 JWT 的 payload 声明（非 JWT / 解码失败 → null） */
function jwtClaims(token) {
  const raw = String(token || "").trim().replace(/^workos:/, "");
  const payload = raw.split(".")[1];
  if (!payload) return null;
  try {
    // base64url → Buffer（容忍无 padding）
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    const claims = JSON.parse(json);
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

/** JWT 里的 exp（秒）→ 毫秒时间戳；解析失败返回 0（靠 401 懒刷新兜底） */
function expiresAtFromJwt(token) {
  const claims = jwtClaims(token);
  const exp = Number(claims && claims.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

/** JWT 里的 Cline 账号 id（usr-... 形态，余额路径参数）：external_id > clineUserId > sub */
function accountIdFromJwt(token) {
  const claims = jwtClaims(token) || {};
  for (const key of ["external_id", "clineUserId", "sub"]) {
    const v = String(claims[key] || "").trim();
    if (v) return v;
  }
  return "";
}

/** JWT 里的展示身份（email 优先，其次姓名，最后账号 id） */
function identityFromJwt(token) {
  const claims = jwtClaims(token) || {};
  const text = (key) => String(claims[key] || "").trim();
  const email = text("email");
  const external = text("external_id");
  const account = accountIdFromJwt(token);
  // 中文姓名习惯「姓+名」，西文「名 姓」；只取其一不拼空格
  const last = text("lastName");
  const first = text("firstName");
  let person = "";
  if (last && first) person = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(last + first) ? `${last}${first}` : `${first} ${last}`;
  else person = last || first;
  return email || person || account;
}

/**
 * 解析 expiresAt 的两种形态（同名不同型）：
 * 毫秒数字 / 数字字符串（providers.json）与 ISO 8601 字符串（/auth/refresh 响应）都认。
 * 解析失败返回 0（不是错误：过期判不出时靠临期窗口 + 401 懒刷新兜底）。
 */
function parseExpiresAt(value) {
  if (value == null) return 0;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const t = String(value).trim();
  if (!t) return 0;
  if (/^\d+$/.test(t)) {
    const ms = Number(t);
    return ms > 0 ? ms : 0;
  }
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 桌面端登录态文件绝对路径（~/.cline/data/settings/providers.json） */
function desktopProvidersPath() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (!home) return null;
  return path.join(home, ".cline", "data", "settings", "providers.json");
}

/**
 * 读本机 Cline 登录态（providers.cline.settings.auth）。
 * 返回 { ok, auth } / { ok: false, silent, reason }：
 *   silent=true  = 「没装/没登录」类（文件不存在、文件在但没有 cline 凭证）——
 *                  扫描时不出候选（与 AutoClaw「无登录态直接跳过」同口径）；
 *   silent=false = 「登录态在但读不了」（JSON 坏等）——如实出行让用户看到原因。
 * 只读不写：providers.json 属于 Cline 客户端，导入时复制凭据入池，运行时不回读不回写。
 */
function readDesktopProviders() {
  const file = desktopProvidersPath();
  if (!file) return { ok: false, silent: false, reason: "无法确定用户主目录" };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, silent: true, reason: "absent" };
  }
  let root;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { ok: false, silent: false, reason: `登录态文件不是合法 JSON：${e.message}` };
  }
  const auth = root && root.providers && root.providers.cline && root.providers.cline.settings && root.providers.cline.settings.auth;
  if (!auth || typeof auth !== "object") return { ok: false, silent: true, reason: "登录态文件里没有 cline 凭证（请先在 Cline 客户端登录）" };
  const token = String(auth.accessToken || "").trim();
  if (!token) return { ok: false, silent: true, reason: "cline 凭证缺少 accessToken" };
  return {
    ok: true,
    auth: {
      accessToken: ensureTokenPrefix(token),
      refreshToken: String(auth.refreshToken || "").trim(),
      expiresAt: parseExpiresAt(auth.expiresAt),
      accountId: String(auth.accountId || "").trim(),
      email: String((auth.metadata && auth.metadata.userInfo && auth.metadata.userInfo.email) || "").trim(),
      name: String((auth.metadata && auth.metadata.userInfo && auth.metadata.userInfo.name) || "").trim(),
    },
  };
}

module.exports = {
  TOKEN_PREFIX,
  ensureTokenPrefix,
  jwtClaims,
  expiresAtFromJwt,
  accountIdFromJwt,
  identityFromJwt,
  parseExpiresAt,
  desktopProvidersPath,
  readDesktopProviders,
};
