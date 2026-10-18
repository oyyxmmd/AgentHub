/**
 * B 项（检索审计 recall_log）功能验证：临时库 + 真实 search 路径，跑完自删。
 * 用法：node tools/verify/m-recall.cjs
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrecall-"));
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
  index.upsertOne(mk("m1", "rust 编译优化", "rust 编译优化 lto codegen"), {});
  index.upsertOne(mk("m2", "rust 发布流程", "rust 发布流程 cargo release"), {});

  console.log("\n[B1] 检索落审计行");
  search.search("rust 编译优化", { project: "p1" }, {});
  search.search("rust 发布流程", { project: "p1" }, {});
  const rows = index.db.prepare("SELECT * FROM recall_log ORDER BY id").all();
  check("两次检索 → 两行审计", () => { assert.strictEqual(rows.length, 2); });
  check("审计含 query/hits/hit_ids/latency", () => {
    assert.strictEqual(rows[0].query, "rust 编译优化");
    assert.ok(rows[0].hits >= 1);
    const ids = JSON.parse(rows[0].hit_ids);
    assert.deepStrictEqual(ids, ["m1"]);
    assert.ok(rows[0].latency_ms >= 0);
    assert.ok(rows[0].ts > 0);
  });

  console.log("\n[B2] 零命中检索也落行（供「搜了什么没搜到」分析）");
  search.search("完全不存在的词xyzzy", { project: "p1" }, {});
  const rows2 = index.db.prepare("SELECT * FROM recall_log WHERE query LIKE '%xyzzy%'").all();
  check("零命中也有审计行", () => { assert.strictEqual(rows2.length, 1); });
  check("hits = 0", () => { assert.strictEqual(rows2[0].hits, 0); });

  console.log("\n[B3] 只读模式静默跳过");
  index.readOnly = true;
  check("readOnly 时 logRecall 返回 false 不抛", () => {
    assert.strictEqual(index.logRecall({ query: "x", hits: 0 }), false);
  });
  const before = index.db.prepare("SELECT COUNT(*) c FROM recall_log").get().c;
  search.search("rust 编译优化", { project: "p1" }, {});
  check("readOnly 时检索不落新审计行", () => {
    assert.strictEqual(index.db.prepare("SELECT COUNT(*) c FROM recall_log").get().c, before);
  });
  index.readOnly = false;

  console.log("\n[B4] 90 天留存清理");
  index.db.prepare("INSERT INTO recall_log (ts, query, hits, total, latency_ms) VALUES (?, 'old', 0, 0, 0)")
    .run(Date.now() - 91 * 86400000);
  index.db.prepare("INSERT INTO recall_log (ts, query, hits, total, latency_ms) VALUES (?, 'old2', 0, 0, 0)")
    .run(Date.now() - 89 * 86400000);
  search.search("rust 编译优化", { project: "p1" }, {});
  check("91 天前旧行被清，89 天前保留", () => {
    const old = index.db.prepare("SELECT COUNT(*) c FROM recall_log WHERE query = 'old'").get().c;
    const old2 = index.db.prepare("SELECT COUNT(*) c FROM recall_log WHERE query = 'old2'").get().c;
    assert.strictEqual(old, 0);
    assert.strictEqual(old2, 1);
  });

  console.log("\n[B5] 审计行不影响热度/检索正确性");
  search.search("rust 编译优化", { project: "p1" }, {});
  check("检索仍正常返回 m1", () => {
    const r = search.search("rust 编译优化", { project: "p1" }, {});
    assert.strictEqual(r.results[0].id, "m1");
  });

  index.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=================================================`);
console.log(` B 项审计验证: 通过 ${pass} 项, 失败 ${fail} 项`);
console.log(`=================================================`);
process.exit(fail > 0 ? 1 : 0);
