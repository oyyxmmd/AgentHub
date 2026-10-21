// 反代网关 · Cline 上游请求头构造（唯一实现，对话 / 登录 / 续期三处共用）
//
// 契约：伪装头**默认值 ∪ 逐键覆盖**——
//   覆盖值非空 → 按键覆盖默认值；
//   覆盖值空串 → 该头不发（显式删除）；
//   Authorization / Content-Type / Accept / X-Task-ID 拒绝覆盖
//   （前三个是协议必需头，末一个每请求动态生成，被覆盖会直接坏掉请求）。
//
// 收敛原因：此前 chat（disguiseHeaders）与 registerSession / refreshToken 各写一份，
// 空串语义还不一致（前者跳过、后者发空值头），且后两处未保护协议必需头——
// 同一份 headers.json 配置在三处产生三种行为。收敛到本文件后「改一处即三处生效」。
"use strict";

/** 拒绝被 upstreamHeaders 覆盖的键（协议必需 / 每请求动态生成） */
const PROTECTED_HEADERS = new Set(["authorization", "content-type", "accept", "x-task-id"]);

/**
 * 构造上游请求头。
 * @param {object} cfg   headers.json 的 cline 段（热重载），读其 upstreamHeaders 作覆盖层
 * @param {object} base  协议必需头（content-type / accept / authorization / x-task-id 等）
 * @returns {object} 键统一小写的头对象（fetch 的 Headers 语义）
 */
function buildUpstreamHeaders(cfg, base) {
  const out = {};
  for (const [k, v] of Object.entries(base || {})) out[String(k).toLowerCase()] = String(v);
  for (const [k, v] of Object.entries((cfg && cfg.upstreamHeaders) || {})) {
    const key = String(k).toLowerCase();
    if (PROTECTED_HEADERS.has(key)) continue; // 协议必需 / 每请求动态生成：拒绝覆盖
    const val = String(v == null ? "" : v);
    if (!val) {
      delete out[key]; // 空串 = 显式删除该头
      continue;
    }
    out[key] = val;
  }
  return out;
}

module.exports = { buildUpstreamHeaders, PROTECTED_HEADERS };
