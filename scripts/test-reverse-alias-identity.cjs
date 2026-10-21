// 反向映射恒等映射自测（issue #145）
// 运行：node scripts/test-reverse-alias-identity.cjs
// 覆盖：原生模型同名/仅大小写不同必须可转发；非原生虚拟名同名仍拒绝；普通映射不受影响。
"use strict";
const adapters = require("../electron/backend/proxy/adapters.cjs");

let pass = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", msg);
  } else {
    failed++;
    console.log("  \u2717", msg, got !== undefined ? `→ got ${JSON.stringify(got)}` : "");
  }
}

const channel = "modelscope";
const native = adapters.get(channel).models();
ok(native.length > 0, "测试渠道有原生模型清单", native.length);
const target = native[0];
const unified = target.toUpperCase();
const cfg = { modelReverseAliases: { [unified]: { [channel]: target } } };

console.log("\n[1] 原生模型的恒等映射（仅大小写不同）");
{
  ok(unified.toLowerCase() === target.toLowerCase(), "构造的映射确实是大小写不敏感的恒等映射", { unified, target });
  const r = adapters.resolveModelTarget(unified, channel, cfg);
  ok(r === target, "resolveModelTarget 返回渠道原生模型名（原实现返回 null）", r);
}

console.log("\n[2] 非原生虚拟名同名仍必须拒绝");
{
  const dirty = { modelReverseAliases: { "AgentHub-1.0": { [channel]: "AgentHub-1.0" } } };
  const r = adapters.resolveModelTarget("AgentHub-1.0", channel, dirty);
  ok(r === null, "虚拟名自映射不构成可转发目标", r);
}

console.log("\n[3] 普通映射（目标与统一名不同）不受影响");
{
  const name2 = "My-Unified-Model";
  const cfg2 = { modelReverseAliases: { [name2]: { [channel]: target } } };
  const r = adapters.resolveModelTarget(name2, channel, cfg2);
  ok(r === target, "普通映射仍返回渠道目标", r);
}

console.log("\n[4] 未配映射时原生模型仍可直接使用（issue #78 备选语义）");
{
  const r = adapters.resolveModelTarget(target, channel, { modelReverseAliases: {} });
  ok(r === target, "无映射的原生模型名仍可作为目标", r);
}

console.log(`\n${failed ? "\u2717" : "OK"} 反向映射恒等映射自测：${pass} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
