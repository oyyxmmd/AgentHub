// 远程网关：桌面连接远程 Docker 版的目标管理与命令转发。
//
// 请求在主进程执行而非渲染层——令牌不进渲染进程、没有 CORS 问题、地址安全校验内聚一处。
// 目标存 config.json（token 走 encryptSecret 加密，与 WebDAV 密码同机制）；列表接口只回
// hasToken，密文永不出主进程，转发时才解密。
"use strict";
const crypto = require("node:crypto");
const config = require("../config.cjs");

const LOCAL = "local";
const RPC_TIMEOUT_MS = 30000;

function loadTargets() {
  const cfg = config.loadConfig();
  return {
    activeId: String(cfg.remoteActiveId || LOCAL),
    targets: Array.isArray(cfg.remoteTargets) ? cfg.remoteTargets : [],
  };
}

/** 地址规范化与安全校验：http 会明文发送管理令牌，只允许私网；公网必须自带 https */
function sanitizeBaseUrl(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("地址格式不正确（示例：http://192.168.1.10:9528）");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 http/https 地址");
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new Error("公网地址必须用 https——http 会把管理令牌明文发到网上");
  }
  return value;
}

function isPrivateHost(host) {
  const h = String(host || "").toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 ULA（fc00::/7，去方括号后）
  return false;
}

function view(targets) {
  return targets.map((t) => ({ id: t.id, alias: t.alias, baseUrl: t.baseUrl, hasToken: !!t.tokenEnc, createdAt: t.createdAt }));
}

function listTargets() {
  const { activeId, targets } = loadTargets();
  return { activeId, targets: view(targets) };
}

function saveTarget(payload = {}) {
  const cfg = config.loadConfig();
  const list = Array.isArray(cfg.remoteTargets) ? cfg.remoteTargets : [];
  const baseUrl = sanitizeBaseUrl(payload.baseUrl);
  const alias = String(payload.alias || "").trim();
  const token = String(payload.token || "").trim();
  const existing = payload.id ? list.find((t) => t.id === payload.id) : null;
  if (existing) {
    if (alias) existing.alias = alias;
    existing.baseUrl = baseUrl;
    if (token) existing.tokenEnc = config.encryptSecret(token); // 空 = 保留原令牌
  } else {
    if (!alias) throw new Error("给它起个名字（例如：家里服务器）");
    if (!token) throw new Error("请填管理令牌（服务器上的 AGENTHUB_ADMIN_TOKEN）");
    list.push({ id: crypto.randomUUID(), alias, baseUrl, tokenEnc: config.encryptSecret(token), createdAt: Date.now() });
  }
  cfg.remoteTargets = list;
  config.saveConfig(cfg);
  return listTargets();
}

function deleteTarget(id) {
  const cfg = config.loadConfig();
  cfg.remoteTargets = (Array.isArray(cfg.remoteTargets) ? cfg.remoteTargets : []).filter((t) => t.id !== id);
  if (cfg.remoteActiveId === id) cfg.remoteActiveId = LOCAL;
  config.saveConfig(cfg);
  return listTargets();
}

function activateTarget(id) {
  const cfg = config.loadConfig();
  const next = String(id || LOCAL);
  if (next !== LOCAL && !(cfg.remoteTargets || []).some((t) => t.id === next)) throw new Error("目标不存在");
  cfg.remoteActiveId = next;
  config.saveConfig(cfg);
  return listTargets();
}

/** 当前激活的目标（token 已解密）；本机模式返回 null */
function activeTarget() {
  const { activeId, targets } = loadTargets();
  if (activeId === LOCAL) return null;
  const t = targets.find((x) => x.id === activeId);
  if (!t) return null;
  const token = config.decryptSecret(t.tokenEnc);
  if (!token) throw new Error(`远程「${t.alias}」的令牌解不开（可能换过机器），请编辑后重新保存令牌`);
  return { id: t.id, alias: t.alias, baseUrl: t.baseUrl, token };
}

async function rpc(cmd, args) {
  const t = activeTarget();
  if (!t) throw new Error("当前是本机模式");
  const name = String(cmd || "");
  if (!name) throw new Error("缺命令名");
  let res;
  try {
    res = await fetch(`${t.baseUrl}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ cmd: name, args: args || {} }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`连接远程「${t.alias}」失败：${(e && e.message) || e}`);
  }
  if (res.status === 401) throw new Error(`远程「${t.alias}」拒绝访问：管理令牌不正确`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.message) || `远程命令 ${name} 失败（HTTP ${res.status}）`);
  return data;
}

/** 测试连接：capabilities（免凭据）验证可达 + status（带令牌）验证令牌；表单可直接传值试连 */
async function testTarget(payload = {}) {
  let baseUrl = payload.baseUrl;
  let token = payload.token;
  if (!baseUrl && payload.id) {
    const cfg = config.loadConfig();
    const t = (cfg.remoteTargets || []).find((x) => x.id === payload.id);
    if (!t) throw new Error("目标不存在");
    baseUrl = t.baseUrl;
    token = token || config.decryptSecret(t.tokenEnc);
  }
  const base = sanitizeBaseUrl(baseUrl);
  try {
    const caps = await fetch(`${base}/api/capabilities`, { signal: AbortSignal.timeout(8000) });
    if (!caps.ok) return { ok: false, message: `网关响应 HTTP ${caps.status}` };
    const cap = await caps.json().catch(() => null);
    const st = await fetch(`${base}/api/status`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (st.status === 401) return { ok: false, message: "管理令牌不正确" };
    if (!st.ok) return { ok: false, message: `网关响应 HTTP ${st.status}` };
    const status = await st.json().catch(() => null);
    return {
      ok: true,
      version: (cap && cap.version) || "",
      platform: (cap && cap.platform) || "",
      gatewayRunning: !!(status && status.gateway && status.gateway.running),
    };
  } catch (e) {
    return { ok: false, message: `连接失败：${(e && e.message) || e}` };
  }
}

module.exports = { listTargets, saveTarget, deleteTarget, activateTarget, rpc, testTarget, activeTarget };
