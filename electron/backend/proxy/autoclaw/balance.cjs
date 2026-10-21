// 反代网关 · AutoClaw 余额（协议事实：官方客户端实测）
//
// 四个端点聚合：钱包 v2 → 兜底 v1 → 即将过期（失败不阻塞）→ 订阅（失败不影响积分）。
// 积分是原始数值透传（无单位换算；balance_view 是上游带格式的展示串）。
// 登录态失效业务码 410000/400000（HTTP 200 body 内）→ authError。
"use strict";

const AUTH_EXPIRED_CODES = [410000, 400000];

/** 业务码失效判定：HTTP 200 但 body.code 命中失效码族 */
function isAuthExpired(data) {
  const code = Number(data && data.code);
  return AUTH_EXPIRED_CODES.includes(code);
}

/** v2 钱包归一：display 真值过滤 → priority 升序（缺失视为最大） */
function normalizeWalletsV2(data) {
  const wallets = Array.isArray(data && data.wallets) ? data.wallets : [];
  return wallets
    .filter((w) => w && w.display)
    .sort((a, b) => (Number(a && a.priority) || Number.MAX_SAFE_INTEGER) - (Number(b && b.priority) || Number.MAX_SAFE_INTEGER))
    .map((w) => ({
      type: String(w.public_wallet_type || ""),
      displayName: String(w.display_name || w.public_wallet_type || "积分"),
      balance: Number(w.balance) || 0,
      balanceView: String(w.balance_view ?? w.balance ?? ""),
    }));
}

/** v1 兜底归一：仅 status=active 实例，按 scope 归类累加 */
const WALLET_SCOPE_LABELS = {
  daily: "赠送积分",
  monthly: "订阅积分",
  long_term: "通用积分",
  annual: "通用积分",
  campaign: "活动积分",
};

function normalizeWalletsV1(data) {
  const list = Array.isArray(data && data.wallet_instances) ? data.wallet_instances : [];
  const byScope = new Map();
  let total = 0;
  for (const w of list) {
    if (!w || String(w.status || "").toLowerCase() !== "active") continue;
    const scopeKey = String(w.wallet_scope || "").replace(/^wallet_scope_/, "") || "other";
    const label = WALLET_SCOPE_LABELS[scopeKey] || "其他积分";
    const bal = Number(w.balance) || 0;
    total += bal;
    const cur = byScope.get(scopeKey) || { type: scopeKey, displayName: label, balance: 0 };
    cur.balance += bal;
    byScope.set(scopeKey, cur);
  }
  return { total, wallets: [...byScope.values()] };
}

/** 订阅归一：结构未实测过（上游深嵌套形态不明），按浅层候选字段扫描（深度 ≤3）。
 *  找不到任何已知字段 → 返回 null（不编造订阅信息）。 */
const SUB_FIELDS = {
  planName: ["productName", "planName", "memberName", "subscribeName", "vipName"],
  status: ["status", "subscribeStatus", "memberStatus"],
  expireAt: ["expireAt", "expireTime", "expiredAt", "endTime", "validEndTime"],
  remainQuota: ["remainQuota", "remainingQuota", "remainCredits", "availableCredits", "leftQuota"],
  totalQuota: ["totalQuota", "credits", "totalCredits"],
};

function normalizeSubscription(root) {
  let found = null;
  const visit = (node, depth) => {
    if (found || !node || typeof node !== "object" || depth > 3) return;
    const pick = (names) => {
      for (const n of names) {
        const v = node[n];
        if (v !== undefined && v !== null && v !== "") return v;
      }
      return undefined;
    };
    const planName = pick(SUB_FIELDS.planName);
    const status = pick(SUB_FIELDS.status);
    if (planName !== undefined || status !== undefined) {
      found = {
        planName: planName !== undefined ? String(planName) : "",
        status: status !== undefined ? String(status) : "",
        ...(pick(SUB_FIELDS.expireAt) !== undefined ? { expireAt: pick(SUB_FIELDS.expireAt) } : {}),
        ...(pick(SUB_FIELDS.remainQuota) !== undefined ? { remainQuota: pick(SUB_FIELDS.remainQuota) } : {}),
        ...(pick(SUB_FIELDS.totalQuota) !== undefined ? { totalQuota: pick(SUB_FIELDS.totalQuota) } : {}),
      };
      return;
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") visit(v, depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

/**
 * 余额查询主流程（纯协议函数，由 adapter.queryCredits 注入 httpJson/头构造）：
 *   env = { cfg, token, headers, httpJson }；headers 为已构造好的 userapi 签名头。
 * 成功返回 { credits, expiresAt: 0, unit, wallets, subscription, detail }；
 * 失效返回 { authError: true, message }；其它失败抛错（由 adapter 包成 { error }）。
 */
async function queryBalance(env) {
  const { cfg, token, headers, httpJson } = env;
  const base = String(cfg.userapiBase || "").replace(/\/+$/, "");
  const get = async (path) => {
    const r = await httpJson(`${base}${path}`, { method: "GET", headers }).catch((e) => {
      throw new Error(`余额接口请求失败：${String((e && e.message) || e).slice(0, 120)}`);
    });
    if (r.status === 401) throw Object.assign(new Error("登录态已过期，无法查询余额"), { authError: true });
    return r;
  };
  const post = async (path, body) => {
    const r = await httpJson(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }).catch((e) => {
      throw new Error(`订阅接口请求失败：${String((e && e.message) || e).slice(0, 120)}`);
    });
    if (r.status === 401) throw Object.assign(new Error("登录态已过期，无法查询订阅"), { authError: true });
    return r;
  };

  // 主链路：钱包 v2（失败/结构不符 → v1 兜底）
  let totalBalance = null;
  let wallets = [];
  const v2 = await get(cfg.walletsPath || "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw");
  if (isAuthExpired(v2.data)) throw Object.assign(new Error("登录态已过期，无法查询余额"), { authError: true });
  if (v2.ok && v2.data && Number(v2.data.code) === 0 && Array.isArray(v2.data.data && v2.data.data.wallets)) {
    totalBalance = Number(v2.data.data.total_balance) || 0;
    wallets = normalizeWalletsV2(v2.data.data);
  } else {
    const v1 = await get(cfg.walletInstancesPath || "/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all");
    if (isAuthExpired(v1.data)) throw Object.assign(new Error("登录态已过期，无法查询余额"), { authError: true });
    if (v1.ok && v1.data && Number(v1.data.code) === 0 && v1.data.data) {
      const norm = normalizeWalletsV1(v1.data.data);
      totalBalance = Number(v1.data.data.total_balance);
      if (!Number.isFinite(totalBalance)) totalBalance = norm.total;
      wallets = norm.wallets;
    } else {
      throw new Error(`余额接口返回异常（HTTP ${v2.status}/${v1.status}，结构可能已变更）`);
    }
  }

  // 即将过期（辅助信息，失败不阻塞）
  let expiring = null;
  try {
    const r = await get(cfg.pointsExpiringPath || "/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw");
    if (r.ok && r.data && Number(r.data.code) === 0 && r.data.data && !isAuthExpired(r.data)) {
      const d = r.data.data;
      expiring = {
        points: Number(d.expiring_points) || 0,
        text: String(d.expiring_points_text || ""),
        expireTimeValue: d.expire_time_value ?? null,
        expireTimeType: String(d.expire_time_type || ""),
      };
    }
  } catch { /* 辅助查询失败不升级错误 */ }

  // 订阅（失败不影响积分结果）
  let subscription = null;
  let subscriptionError = "";
  try {
    const body = { source_id: "autoclaw" };
    const deviceId = env.deviceId;
    if (deviceId) body.device_id = deviceId;
    const r = await post(cfg.subscribePath || "/agentpay/v1/assistant/subscribe-info", body);
    if (isAuthExpired(r.data)) throw Object.assign(new Error("登录态已过期"), { authError: true });
    if (r.ok && r.data) subscription = normalizeSubscription(r.data.data !== undefined ? r.data.data : r.data);
  } catch (e) {
    subscriptionError = String((e && e.message) || e).slice(0, 120);
  }

  return {
    credits: Math.round(totalBalance * 100) / 100,
    expiresAt: 0, // 积分无统一到期概念；expire 信息在 expiring/subscription 里，不冒充 token 到期
    unit: "积分",
    wallets,
    subscription,
    detail: { expiring, ...(subscriptionError ? { subscriptionError } : {}) },
  };
}

module.exports = { queryBalance, isAuthExpired, normalizeWalletsV2, normalizeWalletsV1, normalizeSubscription, AUTH_EXPIRED_CODES };
