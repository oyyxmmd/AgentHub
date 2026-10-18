// issue #96 回归守卫：未配置价格的模型 → 归并 → 确认归并，必须「有反应」
//
// 现象（GitHub issue #96）：部分模型没有价格 → 拉取价格 → 归并 → 确认归并后
// 模型仍滞留未配置列表、费用不变，看起来什么都没发生。
// 主根因（effective_from 晚于历史记录）已随 v1.59.1 修复（schema 5→6）；本守卫锁三件事：
//   A. 归并记录放开供应商限制（schema 6→7）：目标只有其它供应商精确价时回落套用，
//      通配价优先于错配精确价；无任何可匹配价格行时 addAlias 返回 unresolved>0 供前端明示
//   B. 别名记录放开生效下限（schema 5→6 的既有契约，防回退）
//   C. replacePrices 对未携带 aliases 的旧版远端 payload 不清空本机归并映射
//
// 全部在沙箱数据目录内运行，带安全闸门，绝不触碰真实用量库。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-issue96-"));
process.env.USERPROFILE = SANDBOX; // os.homedir() 在 Windows 上取 USERPROFILE，用量库随之进沙箱
process.env.APPDATA = path.join(SANDBOX, "appdata"); // 隔离真实 %APPDATA%，防止 migrateLegacyAppData 把旧版 DosageSync 库拷进沙箱

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}

const syncConfig = require("../electron/backend/sync-config.cjs");
const dbPath = syncConfig.dbPath();
console.log("=== 安全闸门 ===");
console.log("  沙箱 = " + SANDBOX);
console.log("  用量库 = " + dbPath);
ok("用量库路径在沙箱内（绝不写真实库）",
  path.resolve(dbPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase()));
if (!path.resolve(dbPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase())) {
  console.error("拒绝运行：用量库路径不在沙箱内"); process.exit(2);
}

const db = require("../electron/backend/db.cjs");
const day = 24 * 60 * 60 * 1000;
const oldTs = Date.now() - 90 * day; // 90 天前的老记录

function rec(id, model, provider, tokens, startedAt) {
  return {
    id, deviceId: "dev-a", deviceName: "测试机", source: "claude",
    providerId: provider, modelId: model,
    inputTokens: tokens, outputTokens: tokens, reasoningTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0,
    startedAt: startedAt ?? oldTs, status: "success",
  };
}
function unpricedHas(model) {
  return db.listUnpricedModels().some((u) => u.modelId === model);
}
function priceRowOf(model) {
  return db.get().prepare(
    "SELECT p.provider_id AS providerId, p.input_per_m AS inPrice FROM v_record_cost r JOIN model_price p ON p.id = r.price_id WHERE r.model_id = ? LIMIT 1"
  ).get(model);
}

console.log("");
console.log("=== 场景 A：目标只有其它供应商精确价 → 回落套用（#96 残留主场景）===");
db.savePrice({ modelId: "glm-5.3", providerId: "zcode", inputPerM: 2, outputPerM: 8, effectiveFrom: 0 }, "自测");
db.insertRecords([
  rec("a1", "sn-glm-5-3-flash", "claude", 1000),
  rec("a2", "sn-glm-5-3-flash", "trae", 2000),
]);
ok("归并前列入未配置列表", unpricedHas("sn-glm-5-3-flash"));
const rA = db.addAlias("sn-glm-5-3-flash", "glm-5.3");
ok("addAlias 返回摘要", rA && rA.affected === 2 && typeof rA.unresolved === "number", JSON.stringify(rA));
ok("归并后仍有记录数=0（供应商限制已放开）", rA.unresolved === 0, JSON.stringify(rA));
ok("归并后移出未配置列表", !unpricedHas("sn-glm-5-3-flash"));
const rowA = priceRowOf("sn-glm-5-3-flash");
ok("错配记录套用到目标价格（估算而非无价）", !!rowA && rowA.inPrice === 2, JSON.stringify(rowA));

console.log("");
console.log("=== 场景 B：目标完全无价格 → unresolved>0 供前端明示补价 ====");
db.insertRecords([rec("b1", "variant-x", "claude", 500)]);
const rB = db.addAlias("variant-x", "target-y");
ok("归并成功", !!rB);
ok("unresolved>0（无价可套要提示）", rB.affected === 1 && rB.unresolved === 1, JSON.stringify(rB));
ok("无价模型仍在未配置列表", unpricedHas("variant-x"));

console.log("");
console.log("=== 场景 C：拉取价格生效日晚于老记录 → 别名放开生效下限（5→6 既有契约）===");
db.savePrice({ modelId: "kimi-k3", providerId: null, inputPerM: 4, outputPerM: 16, effectiveFrom: Date.now() }, "自测");
db.insertRecords([rec("c1", "sk-kimi-k3", "claude", 800)]);
ok("归并前未配置（价格生效日晚于记录）", unpricedHas("sk-kimi-k3"));
const rC = db.addAlias("sk-kimi-k3", "kimi-k3");
ok("归并后仍有记录数=0", rC.unresolved === 0, JSON.stringify(rC));
ok("归并后移出未配置列表", !unpricedHas("sk-kimi-k3"));

console.log("");
console.log("=== 场景 D：replacePrices 旧 payload 不清空本机别名 ====");
ok("前置：本机有归并映射", db.listAliases().length >= 3);
db.replacePrices(db.listAllPrices(), Date.now(), undefined);
ok("远端无 aliases 字段（旧版格式）→ 本机别名保留", db.listAliases().length >= 3, JSON.stringify(db.listAliases().map((a) => a.alias)));
db.replacePrices(db.listAllPrices(), Date.now(), []);
ok("远端显式空数组 → 本机别名清空（LWW 语义不变）", db.listAliases().length === 0);

console.log("");
console.log("=== 场景 E：无别名时供应商精确价仍优先（不改变既有计费）===");
// 通配价生效更晚也必须让位精确价（审查整改后的三级排序：精确 > 通配 > 错配兜底）
db.savePrice({ modelId: "qwen3.7-flash", providerId: "trae", inputPerM: 1, outputPerM: 2, effectiveFrom: 0 }, "自测");
db.savePrice({ modelId: "qwen3.7-flash", providerId: null, inputPerM: 9, outputPerM: 9, effectiveFrom: Date.now() }, "自测");
db.insertRecords([rec("e1", "qwen3.7-flash", "trae", 1000)]);
const rowE = priceRowOf("qwen3.7-flash");
ok("精确价优先于通配价（通配生效更晚也一样）", !!rowE && rowE.providerId === "trae" && rowE.inPrice === 1, JSON.stringify(rowE));

db.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log("");
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) { console.log("失败项：\n  - " + bad.join("\n  - ")); process.exit(1); }
