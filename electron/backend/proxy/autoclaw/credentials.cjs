// 反代网关 · AutoClaw 桌面端登录态读取
// 新版按地区分别存于 %APPDATA%/AutoClaw-official 与 AutoClaw-oversea-official；
// 旧版 %APPDATA%/AutoClaw/auth.json 与 ~/.openclaw-autoclaw/openclaw.json 继续兼容。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const qoderAuth = require("../qoderAuth.cjs");
const { jwtDecode } = require("../util.cjs");

const MAX_AUTH_FILE_SIZE = 256 * 1024;
const ACCOUNT_KEY_RE = /^[0-9a-f]{64}$/i;
const PRODUCTS = {
  autoclaw: "AutoClaw-official",
  autoclaw_intl: "AutoClaw-oversea-official",
};

function roamingDir() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

function desktopPaths(product) {
  const officialDir = PRODUCTS[product] ? path.join(roamingDir(), PRODUCTS[product]) : "";
  const legacyDir = path.join(roamingDir(), "AutoClaw");
  return {
    officialDir,
    activeAccountFile: officialDir ? path.join(officialDir, "device", "active-product-account.json") : "",
    accountsDir: officialDir ? path.join(officialDir, "accounts") : "",
    deviceFile: officialDir ? path.join(officialDir, "device", "device-id.json") : "",
    localState: officialDir ? path.join(officialDir, "Local State") : "",
    authFile: path.join(legacyDir, "auth.json"),
    legacyLocalState: path.join(legacyDir, "Local State"),
    openclawFile: path.join(os.homedir(), ".openclaw-autoclaw", "openclaw.json"),
  };
}

function regularFileSize(file, maxSize = MAX_AUTH_FILE_SIZE) {
  if (!file) return 0;
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0 && st.size <= maxSize ? st.size : 0;
  } catch { return 0; }
}

function readJsonFile(file, label) {
  if (!regularFileSize(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
  catch (e) { throw new Error(`${label} 无法解析（不是有效 JSON）：${String((e && e.message) || e).slice(0, 80)}`); }
}

function loadOsCryptKey(localStatePath) {
  if (process.platform !== "win32") return null;
  const state = readJsonFile(localStatePath, "AutoClaw Local State");
  const b64 = state && state.os_crypt && state.os_crypt.encrypted_key;
  if (!b64) return null;
  try { return qoderAuth.dpapiUnprotectKey(b64); } catch { return null; }
}

function decryptV10Json(blob, key) {
  if (!Buffer.isBuffer(blob) || blob.length < 32 || blob.subarray(0, 3).toString("ascii") !== "v10") {
    throw new Error("AutoClaw 凭据不是合法 v10 信封");
  }
  if (!key) throw new Error("登录态是加密格式但无法取得解密密钥（仅支持 Windows 上已登录的 AutoClaw 客户端）");
  let plain;
  try { plain = qoderAuth.decryptV10(blob, key).toString("utf8").replace(/^﻿/, ""); }
  catch { throw new Error("AutoClaw 登录态解密失败（常见于与客户端不同的 Windows 用户）"); }
  try { return JSON.parse(plain); }
  catch (e) { throw new Error(`AutoClaw 凭据解密后不是有效 JSON：${String((e && e.message) || e).slice(0, 80)}`); }
}

function decryptEncValue(value, key) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!raw.startsWith("enc:")) return raw.replace(/^Bearer\s+/i, "").trim();
  const b64 = raw.slice(4).trim();
  const blob = Buffer.from(b64, "base64");
  if (!b64 || blob.length < 32 || blob.subarray(0, 3).toString("ascii") !== "v10") throw new Error("AutoClaw 加密字段不是合法 v10/base64");
  if (!key) throw new Error("登录态是加密格式但无法取得解密密钥（仅支持 Windows 上已登录的 AutoClaw 客户端）");
  try { return qoderAuth.decryptV10(blob, key).toString("utf8").replace(/^Bearer\s+/i, "").trim(); }
  catch { throw new Error("AutoClaw 登录态解密失败（常见于与客户端不同的 Windows 用户）"); }
}

function uidFromToken(token) {
  try { const p = jwtDecode(token); return String((p && (p.user_id || p.userId || p.uid || p.sub)) || ""); }
  catch { return ""; }
}

function first(obj, names) {
  if (!obj || typeof obj !== "object") return "";
  for (const name of names) if (obj[name] != null && String(obj[name]).trim()) return obj[name];
  return "";
}

function tokenFromOpenclaw(parsed) {
  const providers = parsed && parsed.models && parsed.models.providers;
  if (!providers || typeof providers !== "object") return "";
  for (const p of Object.values(providers)) for (const m of (p && Array.isArray(p.models) ? p.models : [])) {
    const h = m && m.headers;
    const t = h && String(h["X-Authorization"] || h["x-authorization"] || "").trim();
    if (t) return t.replace(/^Bearer\s+/i, "").trim();
  }
  return "";
}

function readOfficialLogin(product, opts = {}) {
  const paths = desktopPaths(product);
  if (!paths.officialDir || !fs.existsSync(paths.officialDir)) return null;
  const active = readJsonFile(paths.activeAccountFile, "AutoClaw active-product-account") || {};
  const accountKey = String(first(active, ["accountKey", "account_key"])).trim();
  if (!accountKey) return null;
  if (!ACCOUNT_KEY_RE.test(accountKey)) throw new Error("AutoClaw accountKey 格式异常（应为 64 位十六进制）");
  const accountDir = path.join(paths.accountsDir, accountKey);
  const credFile = path.join(accountDir, "account-credentials.enc");
  if (!regularFileSize(credFile)) return null;
  const keyLoader = typeof opts.keyLoader === "function" ? opts.keyLoader : loadOsCryptKey;
  const root = decryptV10Json(fs.readFileSync(credFile), keyLoader(paths.localState));
  const cred = root.credentials && typeof root.credentials === "object"
    ? root.credentials : root.auth && typeof root.auth === "object" ? root.auth : root;
  const token = String(first(cred, ["accessToken", "access_token", "token", "deviceToken", "device_token"]) || "")
    .replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("AutoClaw account-credentials.enc 中没有 access token");
  const refreshToken = String(first(cred, ["refreshToken", "refresh_token"]) || "").trim();
  const profileRoot = readJsonFile(path.join(accountDir, "account-profile.json"), "AutoClaw account-profile") || {};
  const profile = profileRoot.profile || profileRoot.user || profileRoot.userInfo || profileRoot;
  const deviceRoot = readJsonFile(paths.deviceFile, "AutoClaw device-id") || {};
  const device = deviceRoot.device || deviceRoot;
  // uid 口径必须与短信/OAuth 登录路径（saveAutoclawAccount → uidFromToken）一致，
  // 否则同一账号经两条路径导入会各建一条记录。实测 profile.accountId 是 32 位 hex，
  // 而 token 里的 uid（= profile.numericUserId）才是登录接口返回的 user_id —— 优先取后者。
  const uid = String(uidFromToken(token) || first(profile, ["numericUserId", "id", "userId", "user_id", "uid", "accountId", "account_id"]) || first(cred, ["userId", "user_id", "uid", "accountId", "account_id"]) || accountKey);
  return {
    ok: true, product, token, refreshToken,
    deviceId: String(first(device, ["deviceId", "device_id", "id"]) || first(cred, ["deviceId", "device_id"])),
    uid,
    // 新版 profile 常只有脱敏手机号可展示
    name: String(first(profile, ["name", "nickname", "userName", "user_name", "displayName", "display_name", "phone", "mobile", "phoneNumber"])),
    email: String(first(profile, ["email", "mail"])),
    source: `${PRODUCTS[product]}/accounts/${accountKey}/account-credentials.enc`,
  };
}

function readLegacyLogin() {
  const paths = desktopPaths();
  if (fs.existsSync(paths.authFile)) {
    const parsed = readJsonFile(paths.authFile, "AutoClaw auth.json");
    if (parsed && typeof parsed === "object") {
      const key = loadOsCryptKey(paths.legacyLocalState);
      const token = decryptEncValue(first(parsed, ["token", "accessToken", "access_token"]), key);
      if (!token) throw new Error("AutoClaw auth.json 中没有 token");
      let refreshToken = "";
      try { refreshToken = decryptEncValue(first(parsed, ["refreshToken", "refresh_token"]), key); } catch { /* optional */ }
      const info = parsed.userInfo || parsed.user || {};
      return { ok: true, token, refreshToken, deviceId: String(first(parsed, ["deviceId", "device_id"])), uid: String(first(info, ["id", "userId", "user_id", "uid"]) || uidFromToken(token)), name: String(first(info, ["name", "nickname", "userName", "user_name"])), email: String(first(info, ["email"])), source: "AutoClaw/auth.json" };
    }
  }
  const oc = readJsonFile(paths.openclawFile, "AutoClaw 网关配置 openclaw.json");
  const token = oc && tokenFromOpenclaw(oc);
  if (token) return { ok: true, token, refreshToken: "", deviceId: "", uid: uidFromToken(token), name: "", email: "", source: "openclaw.json" };
  return null;
}

function readDesktopLogin(product, opts) {
  if (PRODUCTS[product]) {
    const official = readOfficialLogin(product, opts);
    if (official) return official;
  }
  const legacy = readLegacyLogin();
  return legacy || { ok: false, message: "本机未找到 AutoClaw 登录态" };
}

/** 逐地区读登录态。**单个地区读失败不得掩盖其它地区**：新版两区各有独立登录态，
 *  一个坏掉（换过 Windows 用户/文件损坏）只应让该地区如实出行，不能把好的一起标成不可读。
 *  返回 { autoclaw?, autoclaw_intl?, legacy?, errors: { <地区|legacy>: 原因 } }。 */
function readDesktopLogins(opts) {
  const out = { errors: {} };
  for (const product of Object.keys(PRODUCTS)) {
    try {
      const login = readOfficialLogin(product, opts);
      if (login) out[product] = login;
    } catch (e) {
      out.errors[product] = String((e && e.message) || e).slice(0, 90);
    }
  }
  try {
    const legacy = readLegacyLogin();
    if (legacy) out.legacy = legacy;
  } catch (e) {
    // 旧布局是两区共用的单一来源，读失败对每个渠道都算数（与历史行为一致）
    out.errors.legacy = String((e && e.message) || e).slice(0, 90);
  }
  return out;
}

module.exports = { PRODUCTS, readDesktopLogin, readDesktopLogins, readOfficialLogin, desktopPaths, decryptEncValue, decryptV10Json, tokenFromOpenclaw, uidFromToken };
