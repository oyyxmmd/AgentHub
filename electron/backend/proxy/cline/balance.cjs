// 反代网关 · Cline 余额与订阅（credit 余额 + 当前套餐）
//
// 协议事实（2026-09 实测）：
// ① GET {apiBase}/users/{userId}/balance → {"data":{"userId":"usr-...","balance":-17704},"success":true}
//    **balance 是微 credit，要 ÷1e6**：实测 -17704 对应官方界面 -0.0177，官方前端格式化
//    就是 format(e / 1e6)。负值表示已欠费，如实保留符号（换算不改变符号）。
// ② GET {apiBase}/users/me/plan → 200 有订阅 / **404 没订阅（正常状态，不是失败）**。
//    套餐查询失败只记空，不影响余额结果（余额是主结果，套餐是附加信息）。
// ③ 余额接口不需要 X-CLIENT-TYPE（实测只带 Authorization 就 200）——那是 LLM 端点的
//    产品面校验，管理接口没有。仍带上，与转发一致，无代价。
//
// 刻度换算只此一处（CREDITS_PER_MICRO），将来上游改刻度改这里即可。
"use strict";
const headersMod = require("./headers.cjs");

/** 上游 balance 的刻度：1 credit = 1e6 微 credit（官方前端 format(e/1e6)，实测核对） */
const CREDITS_PER_MICRO = 1e6;

/** userId 三级来源：账号 uid（usr-...）→ JWT external_id → /users/me 兜底 */
async function resolveUserId(env, token) {
  const { httpJson, cfg } = env;
  const base = String(cfg.apiBase || "https://api.cline.bot/api/v1").replace(/\/+$/, "");
  if (String(env.userId || "").startsWith("usr-")) return env.userId;
  const fromJwt = env.jwtAccountId || "";
  if (fromJwt.startsWith("usr-")) return fromJwt;
  // 前两级都取不到才打 /users/me（多一个往返，必须留着兜底）
  const r = await httpJson(`${base}/users/me`, { method: "GET", headers: authHeaders(env.cfg, token) }).catch(() => null);
  const id = String((r && r.data && r.data.data && r.data.data.id) || "").trim();
  return id;
}

function authHeaders(cfg, token) {
  // 伪装头走唯一实现（headers.json upstreamHeaders 覆盖层；空串=不发；协议必需头拒绝覆盖），
  // 与对话/登录/续期同一口径——不再硬编码 x-client-type（单一来源契约）
  return { ...headersMod.buildUpstreamHeaders(cfg, { accept: "application/json" }), authorization: `Bearer ${token}` };
}

/** GET 并解包 {"data":..,"success":true} 信封；allowed 状态码返回 null（调用方按语义处理） */
async function getJson(base, path, token, httpJson, cfg, allowed) {
  const r = await httpJson(`${base}${path}`, { method: "GET", headers: authHeaders(cfg, token) }).catch((e) => {
    throw new Error(`Cline 接口请求失败：${String((e && e.message) || e).slice(0, 120)}`);
  });
  if (allowed && allowed.includes(r.status)) return null;
  if (r.status === 401) {
    // 原样透出 authError：上层据此走「刷新后重试一次」的既有处置
    throw Object.assign(new Error("Cline 登录态已失效，请刷新凭证后重试"), { authError: true });
  }
  if (!r.ok) {
    const detail = (r.data && (r.data.error && (r.data.error.message || r.data.error))) || `HTTP ${r.status}`;
    throw new Error(`Cline 接口返回 ${r.status}：${String(detail).slice(0, 120)}`);
  }
  return r.data;
}

/** 订阅归一：planName 候选字段（上游 displayName/name/plan 三种命名实测不稳定）+
 *  expireAt 转**毫秒**（上游给 ISO 字符串，直接透传会让前端显示 Invalid Date） */
function normalizeSubscription(plan, parseExpiresAt) {
  if (!plan || typeof plan !== "object") return null;
  const out = {};
  for (const key of ["displayName", "name"]) {
    const name = String(plan[key] || "").trim();
    if (name) { out.planName = name; break; }
  }
  if (!out.planName && plan.plan && typeof plan.plan === "object") {
    const name = String(plan.plan.displayName || plan.plan.name || "").trim();
    if (name) out.planName = name;
  }
  for (const key of ["currentPeriodEnd", "cancelAt"]) {
    const ms = parseExpiresAt(plan[key]);
    if (ms > 0) { out.expireAt = ms; break; }
  }
  const status = String(plan.status || "").trim();
  if (status) out.status = status;
  return Object.keys(out).length ? out : null;
}

/**
 * 余额查询主流程（纯协议函数，由 adapter.queryCredits 组装 env）：
 *   env = { cfg, token, httpJson, userId?, jwtAccountId?, parseExpiresAt }
 * 成功返回 { credits, expiresAt, unit, wallets, subscription, detail }；
 * 登录态失效抛 authError；余额响应缺 balance 字段抛错（不返回 0——0 会被判成「余额耗尽」）；
 * 其余失败抛错（由 adapter 包成 { error }）。
 *
 * credits 的既有边界：store.updateAccount 把 < -1 的余额归 0（-1 是企业版无限哨兵）——
 * Cline 欠费通常是小额负值（-0.02 级），能如实落库展示；大额欠费显示 0，
 * 原始微 credit 值留在 raw 里备查。
 */
async function queryBalance(env) {
  const { cfg, token, httpJson } = env;
  const base = String(cfg.apiBase || "https://api.cline.bot/api/v1").replace(/\/+$/, "");
  const userId = await resolveUserId(env, token);
  if (!userId) throw new Error("Cline 余额查询失败：拿不到账号 id（上游 /users/me 未返回 id）");
  const balancePayload = await getJson(base, `/users/${encodeURIComponent(userId)}/balance`, token, httpJson, cfg);
  const data = (balancePayload && balancePayload.data) || balancePayload || {};
  const rawBalance = Number(data.balance);
  // 上游 200 但缺 balance（字段改名/结构变化）：**如实报错**，不返回 0——0 会落库后被
  // routeUsable 当成「余额已耗尽」把可用渠道静默踢出（且污染账号余额），违背「如实展示」
  if (!Number.isFinite(rawBalance)) throw new Error("Cline 余额响应缺少 balance 字段（上游结构可能已变）");
  const credits = rawBalance / CREDITS_PER_MICRO;
  const wallets = [
    {
      type: "cline_credit",
      displayName: credits < 0 ? "Cline Credits（已欠费）" : "Cline Credits",
      balance: Math.round(credits * 100) / 100,
    },
  ];
  // 订阅（404 = 没订阅，正常状态；其余失败不影响余额结果）
  let subscription = null;
  let subscriptionError = "";
  try {
    const planPayload = await getJson(base, "/users/me/plan", token, httpJson, cfg, [404]);
    subscription = planPayload ? normalizeSubscription(planPayload.data, env.parseExpiresAt) : null;
  } catch (e) {
    subscriptionError = String((e && e.message) || e).slice(0, 120);
  }
  return {
    credits: Math.round(credits * 100) / 100,
    // credit 余额无 token 到期概念：expire 信息在 subscription 里，不冒充凭据到期
    expiresAt: 0,
    unit: "credit",
    wallets,
    subscription,
    detail: {
      userId,
      balanceMicrocredits: rawBalance,
      ...(subscriptionError ? { subscriptionError } : {}),
    },
  };
}

module.exports = { queryBalance, CREDITS_PER_MICRO, normalizeSubscription };
