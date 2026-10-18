/**
 * A 项（记忆热度）功能验证：临时库 + 真实 upsert/search 路径，跑完自删。
 * 用法：node tools/verify/m-heat.cjs
 */
"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const { MemoryIndex } = require("../../electron/backend/memory/indexer.cjs");
const { MemorySearch } = require("../../electron/backend/memory/search.cjs");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mheat-"));
try {
  const index = new MemoryIndex(path.join(dir, "index.sqlite"));
  index.open();
  const search = new MemorySearch(index, dir);
  const now = Date.now();

  const mk = (id, title, body) => ({
    id, path: `${id}.md`, type: "lesson", layer: "l2", title, summary: title,
    tags: ["测试"], project: "p1", agent: "verify", created: now, updated: now,
    body, hash: id,
  });

  // 两条内容等价、同关键词的记忆：hot 会被检索 10 次，cold 0 次
  index.upsertOne(mk("hot", "redis 缓存击穿防护", "redis 缓存击穿 防护 mutex 互斥"), {});
  index.upsertOne(mk("cold", "redis 缓存击穿 防护", "redis 缓存击穿 mutex 互斥 防护"), {});

  console.log("\n[A1] upsert 重写后热度保留");
  index.recordHits(["hot", "hot", "hot"]); // 3 次
  index.upsertOne(mk("hot", "redis 缓存击穿防护（修订）", "redis 缓存击穿 防护 mutex 互斥"), {});
  check("重写后 access_count 仍为 3", () => {
    assert.strictEqual(index.getById("hot").access_count, 3);
  });
  check("重写后 last_hit_at 非空", () => {
    assert.ok(index.getById("hot").last_hit_at > 0);
  });

  console.log("\n[A2] recordHits 计数");
  for (let i = 0; i < 7; i++) index.recordHits(["hot"]); // 再 7 次 → 共 10
  check("access_count = 10", () => {
    assert.strictEqual(index.getById("hot").access_count, 10);
  });
  check("只读模式 recordHits 返回 0 不抛", () => {
    index.readOnly = true;
    assert.strictEqual(index.recordHits(["hot"]), 0);
    index.readOnly = false;
  });

  console.log("\n[A3] 热度分影响检索排序");
  const r = search.search("redis 缓存击穿", { project: "p1" }, {});
  check("两条都命中", () => { assert.strictEqual(r.results.length, 2); });
  check("高热度 hot 排第一", () => {
    assert.strictEqual(r.results[0].id, "hot");
  });
  check("scoreParts.heat > 0", () => {
    assert.ok(r.results[0].scoreParts.heat > 0);
  });
  check("cold 的 heat 为 0", () => {
    const cold = r.results.find((x) => x.id === "cold");
    assert.strictEqual(cold.scoreParts.heat, 0);
  });
  check("检索后 cold 也获得 1 次命中（本次检索自身计数）", () => {
    assert.strictEqual(index.getById("cold").access_count, 1);
  });

  console.log("\n[A4] 权重为 0 时热度不生效（可回退）");
  const r0 = search.search("redis 缓存击穿", { project: "p1" }, { "search.weightHeat": 0 });
  check("权重 0 时 hot 的 heat 分为 0", () => {
    assert.strictEqual(r0.results.find((x) => x.id === "hot").scoreParts.heat, 0);
  });

  console.log("\n[A5] 命中计数本身不影响结果正确性（幂等重查）");
  const before = index.getById("hot").access_count;
  const r2 = search.search("redis 缓存击穿", { project: "p1" }, {});
  check("二次检索 hot 仍第一", () => { assert.strictEqual(r2.results[0].id, "hot"); });
  check("每次检索自身命中 +1（与权重无关）", () => {
    assert.strictEqual(index.getById("hot").access_count, before + 1);
  });

  index.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=================================================`);
console.log(` A 项热度验证: 通过 ${pass} 项, 失败 ${fail} 项`);
console.log(`=================================================`);
process.exit(fail > 0 ? 1 : 0);
