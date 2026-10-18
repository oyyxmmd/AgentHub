// 反代网关 · Cline 模型目录（recommended-models 解析 + 按分组归池 + 友好名归一）
//
// 协议事实（2026-09 参考实现 agent2api 实测）：
// ① GET {apiBase}/ai/cline/recommended-models 无需鉴权（实测无 Authorization 头也 200），
//    一次返回四组：recommended（4 条，与两池有重叠）/ free（5 条）/ clinePass（14 条）/
//    clineCloud（3 条，实测 403 未开通——广告一个必然 403 的模型只会让客户端选中后失败）。
// ② **归池一律以响应里的分组为准，不按 id 前缀猜**：free 组里有 2 条是别家的裸 id
//    （z-ai/glm-5.3-flash、poolside/laguna-s-2.1:free），它们同样是免费池成员
//    （实测免费账号打返回 200）。按前缀猜会把它们错判进订阅池——订阅池没有账号时
//    整家不广告，模型在界面上彻底消失（参考实现踩过的真实 bug）。
// ③ **前缀必须原样发给上游**：cline-free/ / cline-pass/ 是计费通道选择器，
//    剥掉转发会被上游 404（实测 model not found）。对下游的友好名（剥前缀）由
//    resolveBodyModel 的目录内匹配给出：客户端用短名请求、网关补上本池前缀再转发。
//    匹配依据是本渠道目录里的完整 id（管理页可见），不是静默替换。
"use strict";

/** 云池前缀（已知但不收录：实测 403） */
const CLOUD_PREFIX = "cline-cloud/";

/** 解析 recommended-models 响应 → 条目表（pool 按**分组**标注，不看前缀）。
 *  pool: "free" | "pass"；recommended 组没有池归属信息（上游只按「推荐」分组），
 *  按前缀兜底判池（带 cline-free/ → free，其余归 pass 保守处理）。
 *  返回 [{ id, name, pool }]；全部条目去重（同 id 只留第一条）。 */
function parseRecommended(payload) {
  const out = [];
  const seen = new Set();
  const push = (item, group) => {
    if (!item || typeof item !== "object") return;
    const id = String(item.id || "").trim();
    if (!id || seen.has(id)) return;
    if (id.startsWith(CLOUD_PREFIX)) return; // 实测 403，不收录
    seen.add(id);
    let pool = group;
    if (!pool) {
      // recommended 组：无池信息，按前缀兜底（带 free 前缀 → free，其余保守归 pass）
      pool = id.startsWith("cline-free/") ? "free" : "pass";
    }
    const name = String(item.name || "").trim() || id;
    out.push({ id, name, pool });
  };
  const groupOf = (key) => (key === "clinePass" ? "pass" : key === "free" ? "free" : null);
  for (const key of ["clinePass", "free", "recommended"]) {
    const items = payload && payload[key];
    if (!Array.isArray(items)) continue;
    const group = groupOf(key);
    for (const item of items) push(item, group);
  }
  return out;
}

/** 按池过滤解析结果（fetchModels 返回本池那一批：两渠道各拉各的，互不混池） */
function filterByPool(entries, pool) {
  return entries.filter((e) => e.pool === pool);
}

/** 上游 id → 对下游的友好名（剥池前缀；无可剥返回 null）。
 *  免费池的裸厂商 id（z-ai/glm-5.3-flash）不剥厂商前缀——那是承载方写进通道位的，
 *  与模型身份前缀（openai/gpt-... 是不同模型）不同类，剥掉会造出上游不存在的名字。 */
function friendlyAlias(id) {
  const s = String(id || "").trim();
  for (const prefix of ["cline-free/", "cline-pass/", CLOUD_PREFIX]) {
    if (s.startsWith(prefix)) return s.slice(prefix.length) || null;
  }
  return null;
}

/**
 * 请求模型名 → 发上游的 body 模型名（完整 id 原样；短名在本渠道目录里补本池前缀）。
 * entries 是本渠道的目录条目（catalog.json 对应段，含拉取后的完整清单）。
 * 归一容错与 ModelScope 简写回退同款：大小写不敏感、去空白。
 * 匹配不到目录条目时原样返回（转发试错语义保留，未知模型由上游 404 如实报错）。
 */
function resolveBodyModel(model, entries, pool) {
  const raw = String(model || "").trim();
  if (!raw || !Array.isArray(entries) || !entries.length) return raw;
  const prefix = pool === "free" ? "cline-free/" : "cline-pass/";
  const lower = raw.toLowerCase();
  // ① 完整 id（含本池前缀）原样
  for (const e of entries) {
    if (String(e.id || "").toLowerCase() === lower) return String(e.id);
  }
  // ② 含**另一池**前缀的 id 不改写：跨池模型由各自渠道承接（cline_pass 渠道收到
  //    cline-free/xxx 时原样转发试错，不静默换成 cline-pass/xxx——那会改变计费通道）
  if (raw.includes("/")) return raw;
  // ③ 短名（友好名）→ 本池目录里「去前缀后等于」的条目补本池前缀
  for (const e of entries) {
    const alias = friendlyAlias(e.id);
    if (alias && alias.toLowerCase() === lower && String(e.id).startsWith(prefix)) return String(e.id);
  }
  return raw;
}

module.exports = { CLOUD_PREFIX, parseRecommended, filterByPool, friendlyAlias, resolveBodyModel };
