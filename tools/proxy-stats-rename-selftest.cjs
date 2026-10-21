// 用量统计「改名后仍显示当前名」回归守卫（PR #149 的行为锁）
//
// 背景：usage_requests 存的是请求落库那一刻的名字快照（key_name / account_name）。
// 号池改名只更新实体表，于是出现两种走样：
//   L1. TOP 排行按 key_name / account_name 分组 → 改名前后的流水分裂成两行，用量被拆散
//   L2. 明细 / 最近请求 / 各 Key 用量直接透出快照 → 改名后仍显示旧名
// 新口径（本守卫锁住）：
//   L1. TOP 的 key / account 维度改按 key_id / account_id 分组，名字透出时映射当前名
//   L2. 四处统一「当前名优先、快照兜底」——实体还在就显示当前名；已删则回退最后一次请求的快照名
//       （裸列随唯一聚合 MAX(ts) 所在行取值，是 SQLite 的文档化行为）
//   L3. 明细是逐行快照：实体已删时，每行显示各自「请求发生时」的名字，事后可追溯
//   L4. 流水表零写入：以上全部是查询侧映射，历史记录不回填
//
// 沙箱：AGENTHUB_DATA_DIR 隔离 + 路径闸门，绝不触碰真实 stats.db 与 config.json。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-stats-rename-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name); console.log("  FAIL " + name + (extra !== undefined ? "   <- " + JSON.stringify(extra) : "")); }
}

const config = require("../electron/backend/config.cjs");
const inSandbox = path.resolve(config.configPath()).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase());
console.log("=== 安全闸门 ===");
console.log("  沙箱 = " + SANDBOX);
ok("配置路径在沙箱内", inSandbox);
if (!inSandbox) { console.error("拒绝运行：配置路径不在沙箱内"); process.exit(2); }

const store = require("../electron/backend/proxy/store.cjs");

const now = Date.now();
const from = now - 3600000;
const to = now + 1000;
const key = store.createKey({ name: "老名字", route: "auto" });
const acc = store.addAccount({ channel: "trae", uid: "u1", name: "老账号", token: "t" });

/** 一条流水：名字是「请求发生时」的快照，与实体当前名刻意分开 */
function put(keyName, accountName, ts) {
  store.insertUsage({
    ts, reqId: "r" + ts, keyId: key.id, keyName, channel: "trae",
    accountId: acc, accountName, model: "m1",
    promptTokens: 10, completionTokens: 5, status: 200, latencyMs: 100,
  });
}
put("老名字", "老账号", now - 3000);
put("老名字", "老账号", now - 2000);

console.log("");
console.log("=== L1：TOP 排行按 id 分组，改名不分裂 ===");
let ov = store.statsOverview({ from, to });
ok("改名前 TOP.key 一行，id = key_id", ov.tops.key.length === 1 && ov.tops.key[0].id === key.id, ov.tops.key.map((r) => ({ id: r.id, name: r.name })));
ok("改名前 TOP.key 显示老名", ov.tops.key[0].name === "老名字", ov.tops.key[0].name);
ok("改名前 TOP.account 的 id = account_id", ov.tops.account[0].id === acc, ov.tops.account[0].id);

store.updateKey(key.id, { name: "新名字" });
store.updateAccount(acc, { name: "新账号" });
ov = store.statsOverview({ from, to });
ok("改名后 TOP.key 仍是 1 行（未按名分裂）", ov.tops.key.length === 1, ov.tops.key.map((r) => ({ id: r.id, name: r.name, req: r.req })));
ok("改名后 TOP.key 跟随当前名", ov.tops.key[0].name === "新名字", ov.tops.key[0].name);
ok("改名后 TOP.key 用量未被打散（req=2）", ov.tops.key[0].req === 2, ov.tops.key[0].req);
ok("改名后 TOP.account 仍是 1 行且跟随当前名", ov.tops.account.length === 1 && ov.tops.account[0].name === "新账号", ov.tops.account.map((r) => r.name));

// 改名后再落一条：老快照与新快照必须合并成一行，而不是并排两行
put("新名字", "新账号", now - 1000);
ov = store.statsOverview({ from, to });
ok("改名前后混合快照仍合并为 1 行", ov.tops.key.length === 1, ov.tops.key.map((r) => ({ id: r.id, name: r.name, req: r.req })));
ok("混合后 req = 3", ov.tops.key[0].req === 3, ov.tops.key[0].req);

console.log("");
console.log("=== L2：各 Key 用量 / 明细 / 最近请求 当前名优先 ===");
const keys = store.statsKeys(from, to);
ok("各 Key 用量：一行，name 跟随当前名", keys.length === 1 && keys[0].name === "新名字", keys.map((k) => ({ id: k.id, name: k.name })));
ok("各 Key 用量：id = keyId", keys[0].id === key.id, keys[0].id);
ok("各 Key 用量：lastTs = 最后一次请求（裸列随 MAX(ts) 取值）", keys[0].lastTs === now - 1000, keys[0].lastTs);
const d = store.statsDetail({ from, to, pageSize: 20 });
ok("明细：keyName / accountName 全部跟随当前名", d.rows.length === 3 && d.rows.every((r) => r.keyName === "新名字" && r.accountName === "新账号"), d.rows.map((r) => r.keyName));
ok("最近请求：keyName 跟随当前名", store.recentRequests(5).every((r) => r.keyName === "新名字"), store.recentRequests(5).map((r) => r.keyName));

console.log("");
console.log("=== L3：明细筛选改精确 keyId ===");
ok("keyId 精确命中 3 条", store.statsDetail({ from, to, keyId: key.id }).total === 3);
ok("不存在的 keyId 命中 0 条", store.statsDetail({ from, to, keyId: "不存在" }).total === 0);
ok("旧 key 模糊参数仍在（按流水快照匹配，既有口径）", store.statsDetail({ from, to, key: "新名" }).total === 1);

console.log("");
console.log("=== L3b：实体删除后回退快照 ===");
store.deleteKey(key.id);
ov = store.statsOverview({ from, to });
ok("删 Key 后 TOP.key 仍 1 行", ov.tops.key.length === 1, ov.tops.key.length);
ok("删 Key 后 TOP.key 回退最后一次请求的快照名", ov.tops.key[0].name === "新名字", ov.tops.key[0].name);
ok("删 Key 后各 Key 用量回退快照名", store.statsKeys(from, to)[0].name === "新名字", store.statsKeys(from, to)[0].name);
ok("删 Key 后明细逐行保留各自快照（可追溯）",
  JSON.stringify(store.statsDetail({ from, to }).rows.map((r) => r.keyName)) === JSON.stringify(["新名字", "老名字", "老名字"]),
  store.statsDetail({ from, to }).rows.map((r) => r.keyName));

console.log("");
console.log("=== L4：空身份不进排行 / 其他维度不受影响 ===");
store.insertUsage({ ts: now - 500, reqId: "r0", keyId: "", keyName: "", channel: "trae", accountId: "", accountName: "", model: "m1", promptTokens: 1, completionTokens: 1, status: 200 });
ov = store.statsOverview({ from, to });
ok("空 key_id 不进 TOP.key", ov.tops.key.length === 1, ov.tops.key.map((r) => r.name));
ok("空 account_id 不进 TOP.account", ov.tops.account.length === 1, ov.tops.account.map((r) => r.name));
ok("空 key_id 不进各 Key 用量", store.statsKeys(from, to).length === 1, store.statsKeys(from, to).length);
ok("channel / model 维度 name 与 id 都等于分组值本身",
  ov.tops.channel.every((r) => r.name === "trae" && r.id === "trae") && ov.tops.model.every((r) => r.name === "m1" && r.id === "m1"),
  { channel: ov.tops.channel, model: ov.tops.model });

store.close();
console.log("");
console.log("=== 结果 ===");
console.log("  pass=" + pass + "  fail=" + fail);
if (bad.length) { console.log("  失败项：\n   - " + bad.join("\n   - ")); process.exit(1); }
