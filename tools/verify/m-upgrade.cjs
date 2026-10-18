/**
 * 紧急修复回归（1.73.2）：老库升级路径全通。
 * 模拟 1.72.1 老库（33 列、无 access_count/last_hit_at、带存量数据）→ 新代码 open
 * → upsert / recordHits / search / logRecall 全链路。
 * 用法：node tools/verify/m-upgrade.cjs
 */
"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { DatabaseSync } = require("node:sqlite");

const { MemoryIndex } = require("../../electron/backend/memory/indexer.cjs");
const { MemorySearch } = require("../../electron/backend/memory/search.cjs");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mupgrade-"));
try {
  // 1.72.1 老库：33 列 schema（无今天加的两列）+ 一条存量数据
  const dbFile = path.join(dir, "index", "memory.sqlite");
  fs.mkdirSync(path.join(dir, "index"), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE mem (
    id TEXT NOT NULL, path TEXT NOT NULL, anchor TEXT, type TEXT, layer TEXT,
    title TEXT, summary TEXT, tags TEXT, project TEXT, agent TEXT, device TEXT,
    session TEXT, created INTEGER, updated INTEGER, importance INTEGER DEFAULT 3,
    hash TEXT, size INTEGER, mtime INTEGER, valid_from INTEGER, valid_to INTEGER,
    superseded_by TEXT, refs_text TEXT, dup_index INTEGER DEFAULT 0,
    dedup_status TEXT DEFAULT 'pending', ai_processed INTEGER DEFAULT 0,
    pinned INTEGER DEFAULT 0, starred INTEGER DEFAULT 0, t_title TEXT, t_summary TEXT,
    t_body TEXT, t_tags TEXT, w_title TEXT, PRIMARY KEY (id, path))`);
  db.exec("CREATE TABLE IF NOT EXISTS mem_link (src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (src, dst, kind))");
  db.exec("INSERT INTO mem (id, path, title, summary, tags, created, updated, hash) VALUES ('old1', 'old1.md', '旧记忆标题', '旧摘要', '测试', 1, 1, 'h1')");
  db.exec("PRAGMA user_version = 1");
  db.close();

  console.log("\n[U1] 老库 open 不抛错（列自愈生效）");
  const index = new MemoryIndex(dbFile);
  index.open();
  check("open 成功", () => { assert.ok(index.db); });
  check("新列已补齐", () => {
    const cols = new Set(index.db.prepare("PRAGMA table_info(mem)").all().map((c) => c.name));
    assert.ok(cols.has("access_count") && cols.has("last_hit_at"));
  });

  console.log("\n[U2] 写入与存量数据共存");
  index.upsertOne({ id: "new1", path: "new1.md", title: "新记忆", summary: "新摘要", tags: ["t"], project: "p1", agent: "v", created: Date.now(), updated: Date.now(), body: "正文 redis 缓存" }, {});
  check("新记忆 upsert 成功", () => { assert.ok(index.getById("new1")); });
  check("存量记忆仍在", () => { assert.ok(index.getById("old1")); });

  console.log("\n[U3] 存量行热度计数（COALESCE 兜 NULL）");
  index.recordHits(["old1"]);
  check("存量行 access_count 从 NULL 正常 +1", () => {
    assert.strictEqual(index.getById("old1").access_count, 1);
  });
  index.recordHits(["old1"]);
  check("再次 +1", () => {
    assert.strictEqual(index.getById("old1").access_count, 2);
  });
  index.upsertOne({ id: "old1", path: "old1.md", title: "旧记忆标题改", summary: "s", tags: ["测试"], created: 1, updated: 1, body: "b", hash: "h1" }, {});
  check("存量行重写后热度保留（NULL 兜 0）", () => {
    assert.strictEqual(index.getById("old1").access_count, 2);
  });

  console.log("\n[U4] 检索全链路");
  const search = new MemorySearch(index, dir);
  const r = search.search("redis 缓存", { project: "p1" }, {});
  check("search 命中新记忆", () => { assert.ok(r.results.some((x) => x.id === "new1")); });
  check("scoreParts.heat 存在", () => {
    assert.ok(typeof r.results[0].scoreParts.heat === "number");
  });

  console.log("\n[U5] 审计与体检数据源");
  check("logRecall 成功（recall_log 表由 DDL 新建）", () => {
    assert.strictEqual(index.logRecall({ query: "q", hits: 1, hitIds: ["new1"], latencyMs: 1 }), true);
  });
  check("recall_log 有行", () => {
    assert.ok(index.db.prepare("SELECT COUNT(*) c FROM recall_log").get().c >= 1);
  });

  console.log("\n[U6] 幂等：再次 open 同一老库不重复加列");
  index.close();
  const index2 = new MemoryIndex(dbFile);
  index2.open();
  check("二次 open 成功", () => { assert.ok(index2.db); });
  index2.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=================================================`);
console.log(` 老库升级路径验证: 通过 ${pass} 项, 失败 ${fail} 项`);
console.log(`=================================================`);
process.exit(fail > 0 ? 1 : 0);
