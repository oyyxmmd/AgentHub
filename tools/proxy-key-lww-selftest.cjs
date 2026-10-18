// issue #92 回归守卫：API Key 的修改与删除要跨设备传播（旧版只增不改不删）
//
// 旧语义：importKey 同 id/hash 即跳过 → A 机改名/改配额/停用/删除，B 机永远不跟随。
// 新语义（本守卫锁住）：
//   L1. keys.updated_at：createKey/updateKey 推进；迁移给存量行起算时间
//   L2. importKey LWW：同 id 且远端 updatedAt 更新 → 应用改名/路由/配额/启停；
//       更旧或不带 updatedAt（老版本对端）→ 保持本机（与旧版「只补缺」一致）
//   L3. 墓碑：noteKeyRemoved 后，applyShared 对「修改时间 ≤ 删除时间」的对端 Key 不导入；
//       对端在删除之后又改过（updatedAt 更新）→ 视为重建，允许导入
//   L4. exportShared 携带 updatedAt（老对端拿到 0 → 永远本机为准，向后兼容）
//
// 沙箱：AGENTHUB_DATA_DIR 隔离 + 路径闸门，绝不触碰真实 stats.db 与 config.json。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-issue92-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}

const config = require("../electron/backend/config.cjs");
const cfgPath = config.configPath();
const inSandbox = path.resolve(cfgPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase());
console.log("=== 安全闸门 ===");
console.log("  沙箱 = " + SANDBOX);
ok("配置路径在沙箱内", inSandbox);
if (!inSandbox) { console.error("拒绝运行：配置路径不在沙箱内"); process.exit(2); }

const store = require("../electron/backend/proxy/store.cjs");
const poolsync = require("../electron/backend/proxy/poolsync.cjs");

console.log("");
console.log("=== L1：updated_at 存在与推进 ====");
const created = store.createKey({ name: "原始 Key", route: "auto" });
let row = store.listKeys().find((k) => k.id === created.id);
ok("createKey 带 updatedAt", !!row && row.updatedAt > 0, JSON.stringify(row && { updatedAt: row.updatedAt }));
const t1 = row.updatedAt;
store.updateKey(created.id, { name: "改过名", enabled: false });
row = store.listKeys().find((k) => k.id === created.id);
ok("updateKey 推进 updatedAt", row.updatedAt > t1, JSON.stringify({ t1, t2: row.updatedAt }));
ok("updateKey 内容生效", row.name === "改过名" && row.enabled === false);
const t2 = row.updatedAt;

console.log("");
console.log("=== L2：importKey LWW ====");
// 远端更新（改名+恢复启用）→ 应用
let r = store.importKey({ id: created.id, name: "远端新名", secret: created.secret, route: "auto", dailyQuota: 500, enabled: true, createdAt: t1, updatedAt: t2 + 1000 });
row = store.listKeys().find((k) => k.id === created.id);
ok("远端更新胜出（updated:true）", r.ok === true && r.updated === true, JSON.stringify(r));
ok("远端字段已应用", row.name === "远端新名" && row.enabled === true && row.dailyQuota === 500, JSON.stringify(row && { name: row.name, enabled: row.enabled, quota: row.dailyQuota }));
ok("本地 updatedAt 被推进到远端值", row.updatedAt === t2 + 1000, String(row.updatedAt));
// 远端更旧 → 本机为准
r = store.importKey({ id: created.id, name: "过时名", secret: created.secret, route: "auto", enabled: false, createdAt: t1, updatedAt: t2 });
row = store.listKeys().find((k) => k.id === created.id);
ok("远端更旧保持本机", r.ok === false && r.reason === "exists" && row.name === "远端新名", JSON.stringify(r));
// 老版本对端（不带 updatedAt）→ 本机为准（向后兼容）
r = store.importKey({ id: created.id, name: "老版本名", secret: created.secret, route: "auto", createdAt: t1 });
row = store.listKeys().find((k) => k.id === created.id);
ok("老对端无 updatedAt 不覆盖", r.ok === false && row.name === "远端新名", JSON.stringify(r));
// 全新 id → 补入
r = store.importKey({ id: "11111111-1111-4111-8111-111111111111", name: "B 机新建", secret: "sk-" + "b".repeat(48), route: "auto", createdAt: Date.now(), updatedAt: Date.now() });
ok("新 Key 补入", r.ok === true && !r.updated, JSON.stringify(r));
// 远端没带 quota 字段（null）→ 保留本机现值
r = store.importKey({ id: created.id, name: "远端再改名", secret: created.secret, route: "auto", dailyQuota: null, enabled: true, updatedAt: t2 + 2000 });
row = store.listKeys().find((k) => k.id === created.id);
ok("缺省字段保留本机现值", r.ok === true && r.updated === true && row.dailyQuota === 500 && row.name === "远端再改名", JSON.stringify(row && { name: row.name, quota: row.dailyQuota }));

console.log("");
console.log("=== L3：墓碑优先 ====");
// 模拟对端包里还有这把 Key（老设备没感知删除）：updatedAt 低于删除时间 → 不导入
store.deleteKey(created.id);
poolsync.noteKeyRemoved(created.id);
const tombAt = Date.now();
const snap = { format: "agenthub-proxy-shared@1", exportedAt: Date.now(), deviceId: "other", deviceName: "B 机", config: {}, keys: [{ id: created.id, name: "应被墓碑挡住", secret: created.secret, route: "auto", enabled: true, createdAt: t1, updatedAt: tombAt - 5000 }], catalog: {} };
const ap = poolsync.applyShared(snap);
row = store.listKeys().find((k) => k.id === created.id);
ok("墓碑时间 ≥ 对端修改时间 → 不导入", !row && ap.keyAdded === 0, JSON.stringify({ keyAdded: ap.keyAdded, exists: !!row }));
// 对端在删除之后又改过 → 视为重建
const snap2 = { ...snap, keys: [{ id: created.id, name: "删除后又被改", secret: created.secret, route: "auto", enabled: true, createdAt: t1, updatedAt: tombAt + 5000 }] };
const ap2 = poolsync.applyShared(snap2);
row = store.listKeys().find((k) => k.id === created.id);
ok("对端删除后又有修改 → 重建", !!row && row.name === "删除后又被改" && ap2.keyUpdated + ap2.keyAdded >= 1, JSON.stringify({ exists: !!row, name: row && row.name }));

console.log("");
console.log("=== L4：exportShared 携带 updatedAt ====");
const shared = poolsync.exportShared();
const mine = shared.keys.find((k) => k.id === created.id);
ok("导出含 updatedAt", !!mine && mine.updatedAt > 0, JSON.stringify(mine && { updatedAt: mine.updatedAt }));

console.log("");
console.log("=== L5：加密口令接线（审查整改 P0 的回归锁）===");
// moduleWebdav 必须把 passphrase 注入给 poolsync——缺了它封套会用 undefined 空口令加密
config.saveSharedWebdav({ type: "webdav", endpoint: "https://dav.example.com/dav", username: "u", password: "pw-abc", encryptionPassphrase: "pp-123", roots: {} });
const w1 = config.moduleWebdav("proxy");
ok("显式加密口令注入 passphrase", w1.passphrase === "pp-123", JSON.stringify({ passphrase: typeof w1.passphrase === "string" ? w1.passphrase : w1.passphrase }));
config.saveSharedWebdav({ type: "webdav", endpoint: "https://dav.example.com/dav", username: "u", password: "pw-abc", encryptionPassphrase: "", roots: {} });
const w2 = config.moduleWebdav("proxy");
ok("空口令回退沿用 password", w2.passphrase === "pw-abc", String(w2.passphrase));
// 空口令守卫：encodeEnvelope 拒绝空口令打包
let guarded = false;
try { poolsync.encodeEnvelope({ a: 1 }, ""); } catch { guarded = true; }
ok("encodeEnvelope 拒绝空口令", guarded === true);

store.close(); // WAL 句柄不释放沙箱删不掉
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log("");
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) { console.log("失败项：\n  - " + bad.join("\n  - ")); process.exit(1); }
