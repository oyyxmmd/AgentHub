// 反代网关 · AutoClaw 模型路由与目录（协议事实：模型 + 目录实测）
//
// 两个模型标识必须分清：X-Request-Model 头 = 完整路由 ID（带通道前缀，前缀决定计费通道），
// body.model = 剥掉路由前缀后的模型 ID。只发对一个，上游要么选错计费通道要么认不出模型。
"use strict";

/** 已知路由前缀：顺序有意义——先 zaicoding_ 再 zai_，反过来会把 zaicoding_glm-5.3 错剥成 coding_glm-5.3 */
const KNOWN_ROUTE_PREFIXES = ["zaicoding_", "zai_"];

/** 目录拉不到时的静态兜底（两地共用同一份，规格书 §5.4）：routeId 无法从剥前缀的 id 反推，必须显式带 */
const STATIC_MODELS = [
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    routeId: "zaicoding_glm-5.3",
    rate: null,
    capabilities: { images: false, reasoning: true, tools: true },
    contextLength: 1048576,
    maxOutputTokens: 307200,
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    routeId: "zai_glm-5.3-flash",
    rate: null,
    capabilities: { images: true, reasoning: true, tools: true },
    contextLength: 1048576,
    maxOutputTokens: 131072,
  },
];

/** 默认路由（模型名解析全不中时的最终兜底；上游按它自动选型） */
const DEFAULT_ROUTE = "zai_auto";

/** 剥路由前缀：依次试 zaicoding_ / zai_，命中即剥，无前缀原样返回 */
function stripRoutePrefix(model) {
  const s = String(model || "");
  for (const p of KNOWN_ROUTE_PREFIXES) {
    if (s.startsWith(p)) return s.slice(p.length);
  }
  return s;
}

/** 合法路由 ID 形态：小写字母开头、首个 _ 前全为 [a-z0-9]、_ 后 1..127 个 [A-Za-z0-9._:-] */
function isRouteId(s) {
  const m = /^[a-z][a-z0-9]*_[A-Za-z0-9._:-]{1,127}$/.exec(String(s || ""));
  return !!m;
}

/** 目录条目里找路由 ID：依次精确匹配 id / name / routeId（trim + 忽略大小写），命中返回条目 */
function matchCatalogEntry(catalogModels, raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key || !Array.isArray(catalogModels)) return null;
  for (const field of ["id", "name", "routeId"]) {
    for (const m of catalogModels) {
      if (m && String(m[field] || "").trim().toLowerCase() === key) return m;
    }
  }
  return null;
}

/**
 * 解析客户端请求的模型名 → { routeModelId, bodyModelId }。
 * 解析顺序（resolve_model_route 的简化版，目录优先）：
 *   1. 空/纯空白 → 默认路由 zai_auto，body 同名；
 *   2. catalog 条目命中（id/name/routeId）→ 用条目的 routeId，body 用剥前缀 id；
 *   3. 以已知前缀开头 → 整串当路由 ID（大小写原样），body 剥前缀；
 *   4. 合法路由形态 → 原样透传，body 剥前缀；
 *   5. 全不中 → 默认路由 zai_auto，body 保留原名。
 */
function resolveRoute(raw, catalogModels) {
  const name = String(raw || "").trim();
  if (!name) return { routeModelId: DEFAULT_ROUTE, bodyModelId: stripRoutePrefix(DEFAULT_ROUTE) };
  const hit = matchCatalogEntry(catalogModels, name);
  if (hit && hit.routeId) {
    return { routeModelId: String(hit.routeId), bodyModelId: stripRoutePrefix(hit.id || name) };
  }
  for (const p of KNOWN_ROUTE_PREFIXES) {
    if (name.startsWith(p)) return { routeModelId: name, bodyModelId: name.slice(p.length) };
  }
  if (isRouteId(name)) return { routeModelId: name, bodyModelId: stripRoutePrefix(name) };
  return { routeModelId: DEFAULT_ROUTE, bodyModelId: name };
}

/**
 * 远程目录条目归一（上游 GET autoclaw-model-config → AgentHub catalog.json 条目）。
 * 上游顶层直接是 {models:[…]}（无 code/data 信封）；条目允许裸字符串简写。
 * id 一律存剥前缀形态（客户端用它请求），routeId 存完整路由（转发发 X-Request-Model 用）。
 */
function normalizeCatalogEntry(entry) {
  if (entry == null) return null;
  if (typeof entry === "string") {
    return { id: stripRoutePrefix(entry), name: stripRoutePrefix(entry).toUpperCase(), routeId: entry, capabilities: {}, contextLength: 0, maxOutputTokens: 0 };
  }
  if (typeof entry !== "object") return null;
  const routeId = String(entry.id || "").trim();
  if (!routeId) return null;
  const input = Array.isArray(entry.input) ? entry.input : [];
  const out = {
    id: stripRoutePrefix(routeId),
    name: String(entry.name || stripRoutePrefix(routeId).toUpperCase()),
    routeId,
    rate: null,
    capabilities: {
      images: input.includes("image"),
      reasoning: entry.reasoning !== false,
      tools: true,
    },
    contextLength: Number(entry.contextWindow) || 0,
    maxOutputTokens: Number(entry.maxTokens) || 0,
  };
  if (entry.creditConsumptionLevel) out.credits = String(entry.creditConsumptionLevel);
  return out;
}

module.exports = { KNOWN_ROUTE_PREFIXES, STATIC_MODELS, DEFAULT_ROUTE, stripRoutePrefix, isRouteId, matchCatalogEntry, resolveRoute, normalizeCatalogEntry };
