// reasoning_effort:"off" 存活闸：node scripts/test-reasoning-effort-off.cjs
//
// 钉的是一个问题——模型目录页提供「关闭思考 (off)」，server.cjs 会把它写进请求体，
// 但 util.normalizeReasoningEffort 的「降到 ≤ 请求档的最高支持档」在支持档不含 off 时
// 会把 off 抬成最低档：用户明确关了思考，却被静默改成继续思考。
// ① ② 真跑纯函数（不碰库、不碰网络）；④ 钉住这条路径在生产里是活的；⑤ 内置正对照，
// 防 ① 退化成恒真判据。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const util = require("../electron/backend/proxy/util.cjs");

const ROOT = path.join(__dirname, "..");
let pass = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { failed++; console.log("  ✗ " + msg); }
}

// ===== ① off 必须原样存活 =====
{
  const T = [
    [["low", "medium", "high"], "支持档最低是 low 时不得抬成 low"],
    [["minimal", "low", "medium", "high"], "不得抬成 minimal（minimal 仍然在思考）"],
    [["high"], "只支持 high 时也不得抬档"],
    [[], "支持档为空数组时函数直接返回，off 不动"],
    [["off", "low", "high"], "支持档含 off 时本来就该原样保留"],
  ];
  for (const [supported, why] of T) {
    const obj = { model: "some-model", reasoning_effort: "off" };
    util.normalizeReasoningEffort(obj, { supportedEfforts: supported });
    ok(obj.reasoning_effort === "off", `① off + 支持档 [${supported.join(",")}] 仍是 off —— ${why}（实测 ${obj.reasoning_effort}）`);
  }
  // 别名与大小写：只有精确的 "off" 才是关思考的标记，别的字符串走原逻辑（不认领、也不误保护）
  const weird = { model: "m", reasoning_effort: "OFF" };
  util.normalizeReasoningEffort(weird, { supportedEfforts: ["low", "high"] });
  ok(weird.reasoning_effort === "OFF", `① 大写 "OFF" 不在 EFFORT_RANK 里，按未知档原样透传（实测 ${weird.reasoning_effort}）`);
}

// ===== ② 真实档位的降级不得被这次改动波及（否则「提前 return」可以是万能糊布） =====
{
  const D = [
    ["high", ["low", "medium"], "medium", "请求 high、支持到 medium → 降到最高支持档 medium"],
    ["medium", ["low", "high"], "low", "请求 medium、支持档跨过它 → 降到 ≤ 请求档的最高支持档 low"],
    ["low", ["medium", "high"], "medium", "支持档全高于请求档 → 取最低支持档 medium"],
    ["max", ["low", "high"], "high", "请求 max → 降到 high"],
    ["minimal", ["minimal", "high"], "minimal", "已在支持集内 → 原样"],
  ];
  for (const [cur, supported, want, why] of D) {
    const obj = { model: "m", reasoning_effort: cur };
    util.normalizeReasoningEffort(obj, { supportedEfforts: supported });
    ok(obj.reasoning_effort === want, `② ${why}：${cur} + [${supported.join(",")}] → ${want}（实测 ${obj.reasoning_effort}）`);
  }
  const noMeta = { model: "m", reasoning_effort: "ultra" };
  util.normalizeReasoningEffort(noMeta, null);
  ok(noMeta.reasoning_effort === "ultra", "② 目录没声明 reasoning 元数据时整函数不动请求值");
}

// ===== ③ off 与 deepseek 思考注入的配合 =====
{
  const obj = { model: "deepseek-v3.2", reasoning_effort: "off" };
  util.injectThinking(obj, "high");
  ok(obj.reasoning_effort === "off", `③ deepseek 且无 thinking 字段时，显式 off 不得被补成默认档（实测 ${obj.reasoning_effort}）`);
  const obj2 = { model: "deepseek-v3.2", thinking: { type: "enabled" } };
  util.injectThinking(obj2, "high");
  ok(obj2.reasoning_effort === "high", `② 对照：没写 effort 时仍按默认档补齐（实测 ${obj2.reasoning_effort}）`);
}

// ===== ④ 这条路径是活的：UI 能选 off → server 会写进请求体 → adapters 在请求路径上调降级 =====
{
  const pins = [
    ["src/views/proxy/ProxyModelsView.vue", /\{ value: "off", label: "[^"]*关闭思考/, "模型目录页把 off 作为可选项呈现给用户"],
    ["electron/backend/proxy/server.cjs", /custom\.reasoningEffort === "off"[\s\S]{0,120}effectiveBody\.reasoning_effort = "off"/, "server 把用户选的 off 写进发往上游的请求体"],
    ["electron/backend/proxy/adapters.cjs", /util\.normalizeReasoningEffort\(out, catEntry && catEntry\.reasoning\)/, "adapters 在每次构造上游请求体时调用降级函数"],
  ];
  for (const [rel, re, label] of pins) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const n = (src.match(new RegExp(re.source, "g")) || []).length;
    ok(n === 1, `④ ${rel}：${label} 恰好一处（实测 ${n} 处）`);
  }
}

// ===== ⑤ 正对照：去掉守卫的实现必须真的把 off 抬档，否则 ① 是恒真判据 =====
{
  const EFFORT_RANK = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };
  const naive = (cur, supported) => {
    if (!supported.length) return cur;
    if (EFFORT_RANK[cur] == null) return cur;
    const sorted = [...new Set(supported)].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
    if (sorted.includes(cur)) return cur;
    const lower = sorted.filter((s) => EFFORT_RANK[s] <= EFFORT_RANK[cur]);
    return lower.length ? lower[lower.length - 1] : sorted[0];
  };
  ok(naive("off", ["low", "medium", "high"]) === "low",
    `⑤ 正对照：无守卫的写法确实把 off 抬成 low（实测 ${naive("off", ["low", "medium", "high"])}）`);
  const shipped = { model: "m", reasoning_effort: "off" };
  util.normalizeReasoningEffort(shipped, { supportedEfforts: ["low", "medium", "high"] });
  ok(shipped.reasoning_effort !== naive("off", ["low", "medium", "high"]),
    "⑤ 现实现与无守卫写法在同一输入上分岔（判据不是两边都过的摆设）");
}

console.log(`\n${failed ? "FAIL" : "OK"} reasoning_effort:off 存活自测：${pass} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
