// 反代网关 · AutoClaw 登录协议（协议事实：登录 + oauth 实测）
//
// 国内版 = 手机验证码两跳（send-code / agent-login/）；国际版 = OAuth 三跳
// （captcha-config → zai-oauth-url 带 ali_captcha_verify_param → 浏览器登录 → zai-oauth-login）。
// 上游错误码是**人话翻译层**：631002 实义是「缺风控验证」、630014 是「验证码校验未通过」，
// 直接透传原文会把用户引向完全错误的方向。
"use strict";

const headersMod = require("./headers.cjs");

/** 上游错误码 → 用户可读文案（登录 / oauth 错误表） */
const LOGIN_ERR_MESSAGES = {
  400001: "请求参数有误，请检查手机号与验证码格式后重试",
  630101: "获取验证码过于频繁，请稍后再试",
  630202: "验证码不正确，请检查后重试",
  631001: "授权码无效或已过期，请重新点击登录",
  630014: "风控验证未通过，请重新点击登录再试一次",
  631002: "本次登录缺少风控验证（验证码未通过或已过期），请重新点击登录再试一次",
};

/** 上游 {code,msg|message} 响应 → 翻译后的失败（message 优先走错误码表，其次上游原文） */
function translateError(data, fallback) {
  const code = Number(data && data.code);
  if (code && LOGIN_ERR_MESSAGES[code]) return LOGIN_ERR_MESSAGES[code];
  return String((data && (data.msg || data.message)) || fallback || `请求失败（HTTP 层 code=${code}）`);
}

/** 手机号归一：去空白/连字符、去 +86/86 前缀；必须是 11 位 1[2-9] 开头（不合法返回空串） */
function normalizePhone(input) {
  let s = String(input || "").replace(/[\s-]/g, "");
  s = s.replace(/^\+86/, "").replace(/^86(?=1[2-9])/, "");
  return /^1[2-9]\d{9}$/.test(s) ? s : "";
}

/** device_id：32 字节密码学随机 → 64 位小写十六进制（官方是公钥 SHA-256，服务端只当不透明串） */
function newDeviceId() {
  return require("node:crypto").randomBytes(32).toString("hex");
}

/**
 * 国内版发验证码：POST {userapi}/userapi/v1/agent-send-code（匿名签名头，token 空串）。
 * 成功判据：code==0 **且** data.result===true（result 假也算失败）。**不带 device_id 实测 400001**。
 * 返回 { ok, deviceId } / { ok:false, message }。
 */
async function sendSmsCode(env) {
  const { cfg, httpJson } = env;
  const phone = normalizePhone(env.phone);
  if (!phone) return { ok: false, message: "手机号格式不正确（需 11 位国内手机号）" };
  const deviceId = env.deviceId || newDeviceId();
  const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
  const r = await httpJson(`${base}${cfg.sendCodePath || "/userapi/v1/agent-send-code"}`, {
    method: "POST",
    headers: headersMod.signedAuthHeaders(cfg, ""),
    body: JSON.stringify({ phone, source_id: "autoclaw", device_id: deviceId }),
  }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
  if (!r.ok || !r.data) return { ok: false, message: `验证码发送失败（HTTP ${r.status}）` };
  if (Number(r.data.code) !== 0 || (r.data.data && r.data.data.result) !== true) {
    return { ok: false, message: translateError(r.data, "验证码发送失败，请稍后重试") };
  }
  return { ok: true, deviceId, phone };
}

/**
 * 国内版登录：POST {userapi}/userapi/v1/agent-login/（结尾斜杠是上游要求）。
 * code 必须是 **JSON number**——传字符串上游回 400001「请求数据有问题」。
 * 登录沿用发码时的 device_id。成功 { ok, token, refreshToken, deviceId, phoneTail }。
 */
async function smsLogin(env) {
  const { cfg, httpJson } = env;
  const phone = normalizePhone(env.phone);
  if (!phone) return { ok: false, message: "手机号格式不正确（需 11 位国内手机号）" };
  const codeNum = Number(String(env.code || "").trim());
  if (!Number.isInteger(codeNum) || codeNum <= 0) return { ok: false, message: "验证码格式不正确" };
  const deviceId = env.deviceId || newDeviceId();
  const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
  const r = await httpJson(`${base}${cfg.loginPath || "/userapi/v1/agent-login/"}`, {
    method: "POST",
    headers: headersMod.signedAuthHeaders(cfg, ""),
    body: JSON.stringify({ phone, code: codeNum, platform: "web", source_id: "autoclaw", device_id: deviceId }),
  }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
  if (!r.ok || !r.data) return { ok: false, message: `登录请求失败（HTTP ${r.status}）` };
  if (Number(r.data.code) !== 0) return { ok: false, message: translateError(r.data, "登录失败，请稍后重试") };
  const d = r.data.data && typeof r.data.data === "object" ? r.data.data : {};
  const token = String(d.access_token || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, message: "登录成功但服务器未返回 token，请稍后重试" };
  return {
    ok: true,
    token,
    refreshToken: String(d.refresh_token || "").replace(/^Bearer\s+/i, "").trim(),
    deviceId,
    phoneTail: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
  };
}

/**
 * 国际版风控配置：POST {userapi}/userapi/overseasv1/oauth-captcha-config。
 * 上游 data {enabled, region, prefix, scene_id, captcha_supplier} → 归一 sceneId/supplier 驼峰。
 */
async function oauthCaptchaConfig(env) {
  const { cfg, httpJson } = env;
  const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
  const r = await httpJson(`${base}${cfg.oauthCaptchaConfigPath || "/userapi/overseasv1/oauth-captcha-config"}`, {
    method: "POST",
    headers: headersMod.signedAuthHeaders(cfg, ""),
    body: "{}",
  }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
  if (!r.ok || !r.data || Number(r.data.code) !== 0) {
    return { ok: false, message: `风控配置获取失败（HTTP ${r.status}）` };
  }
  const d = r.data.data && typeof r.data.data === "object" ? r.data.data : {};
  return {
    ok: true,
    enabled: d.enabled === true,
    region: String(d.region || ""),
    prefix: String(d.prefix || ""),
    sceneId: String(d.scene_id || ""),
    supplier: String(d.captcha_supplier || ""),
  };
}

/** OAuth 路径族：zai / google 两变体 */
function oauthPaths(cfg, vendor) {
  return vendor === "google"
    ? { url: cfg.oauthGoogleUrlPath || "/userapi/overseasv1/google-oauth-url", login: cfg.oauthGoogleLoginPath || "/userapi/overseasv1/google-oauth-login", callback: "/auth/callback-google" }
    : { url: cfg.oauthUrlPath || "/userapi/overseasv1/zai-oauth-url", login: cfg.oauthLoginPath || "/userapi/overseasv1/zai-oauth-login", callback: "/auth/callback-zai" };
}

/**
 * OAuth 第②跳：验证串换授权地址。captchaVerifyParam（前端阿里云 SDK 产物）原样转交上游
 * ali_captcha_verify_param——网关不解析。631002/630014 在此翻译（参数校验顺序实测：
 * 先验验证码、后验 navigate_uri）。
 */
async function oauthStart(env) {
  const { cfg, httpJson } = env;
  const param = String(env.captchaVerifyParam || "").trim();
  if (!param) return { ok: false, message: "缺少风控验证参数，请先完成验证码" };
  const deviceId = env.deviceId || newDeviceId();
  const paths = oauthPaths(cfg, env.vendor);
  const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
  const r = await httpJson(`${base}${paths.url}`, {
    method: "POST",
    headers: headersMod.signedAuthHeaders(cfg, ""),
    body: JSON.stringify({
      source_id: "autoclaw",
      device_id: deviceId,
      navigate_uri: env.navigateUri,
      ali_captcha_verify_param: param,
    }),
  }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
  if (!r.ok || !r.data) return { ok: false, message: `授权地址获取失败（HTTP ${r.status}）` };
  if (Number(r.data.code) !== 0) return { ok: false, message: translateError(r.data, "授权地址获取失败") };
  const oauthUrl = String(r.data.data && r.data.data.oauth_url || "").trim();
  if (!oauthUrl) return { ok: false, message: "上游未返回授权地址，请重试" };
  return { ok: true, oauthUrl, deviceId, callbackPath: paths.callback, loginPath: paths.login };
}

/**
 * OAuth 第③跳：授权码换 token（本步**不需要**验证码——假 code 回 631001 而非 630014）。
 * navigate_uri 必须与第②跳逐字相同。成功 { ok, token, refreshToken, userId, userName }。
 */
async function oauthExchange(env) {
  const { cfg, httpJson } = env;
  const paths = oauthPaths(cfg, env.vendor);
  const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
  const r = await httpJson(`${base}${paths.login}`, {
    method: "POST",
    headers: headersMod.signedAuthHeaders(cfg, ""),
    body: JSON.stringify({
      source_id: "autoclaw",
      device_id: env.deviceId,
      code: String(env.code || ""),
      state: String(env.state || ""),
      navigate_uri: env.navigateUri,
    }),
  }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
  if (!r.ok || !r.data) return { ok: false, message: `换码请求失败（HTTP ${r.status}）` };
  if (Number(r.data.code) !== 0) return { ok: false, message: translateError(r.data, "登录失败，请重试") };
  const d = r.data.data && typeof r.data.data === "object" ? r.data.data : {};
  const token = String(d.access_token || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, message: "换码成功但服务器未返回 token，请重试" };
  return {
    ok: true,
    token,
    refreshToken: String(d.refresh_token || "").replace(/^Bearer\s+/i, "").trim(),
    userId: String(d.user_id || ""),
    userName: String(d.user_name || ""),
  };
}

/** best-effort 邮箱回填（user-profile 的 source_id 固定 autotyper）。失败返回空串 */
async function fetchUserEmail(env) {
  const { cfg, httpJson } = env;
  try {
    const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
    const r = await httpJson(`${base}${cfg.userProfilePath || "/userapi/v1/user-profile"}`, {
      method: "POST",
      headers: headersMod.signedAuthHeaders(cfg, env.token || ""),
      body: JSON.stringify({ source_id: "autotyper", ...(env.deviceId ? { device_id: env.deviceId } : {}) }),
    });
    if (r.ok && r.data && Number(r.data.code) === 0) {
      const d = r.data.data && typeof r.data.data === "object" ? r.data.data : {};
      return String(d.email || "").trim();
    }
  } catch { /* best-effort */ }
  return "";
}

module.exports = { sendSmsCode, smsLogin, oauthCaptchaConfig, oauthStart, oauthExchange, fetchUserEmail, normalizePhone, newDeviceId, oauthPaths, LOGIN_ERR_MESSAGES };
