/**
 * C 项（记忆体检）功能验证：临时目录 + 真实 MemoryService，跑完自删。
 * 用法：node tools/verify/m-health.cjs
 */
"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const { MemoryService } = require("../../electron/backend/memory/service.cjs");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mhealth-"));
try {
  const service = new MemoryService(rootDir, {}, {});
  service.init(); // 真实启动路径：建目录树 + open 索引库
  const now = Date.now();
  const DAY = 86400000;

  const mk = (id, title, opts = {}) => ({
    id, path: `${id}.md`, type: opts.type || "lesson", layer: "l2", title, summary: title,
    tags: ["测试"], project: opts.project || "p1", agent: "verify",
    created: opts.created || now, updated: now, body: `${title} 正文`, hash: id,
    supersededBy: opts.supersededBy || null,
    accessCount: opts.accessCount || 0,
  });

  // ① 僵尸场景：2 条 90 天前、从未命中（accessCount=0，标题避开后续检索词）；
  //    1 条 90 天前但会被检索命中；1 条新记忆从未命中
  service.index.upsertOne(mk("old1", "旧笔记甲", { created: now - 100 * DAY }), {});
  service.index.upsertOne(mk("old2", "旧笔记乙", { created: now - 95 * DAY }), {});
  service.index.upsertOne(mk("old3", "旧笔记丙", { created: now - 100 * DAY }), {});
  service.index.upsertOne(mk("new1", "新笔记丁"), {});

  // ② 演化链：A → B → C（A、B 被取代）
  service.index.upsertOne(mk("chainA", "最初方案", { supersededBy: "chainB" }), {});
  service.index.upsertOne(mk("chainB", "改进方案", { supersededBy: "chainC" }), {});
  service.index.upsertOne(mk("chainC", "最终方案"), {});

  // ③ 检索产生趋势数据（命中 old3 三次 + 一次零命中；old1/old2/丙 之外的标题不会被检索命中）
  for (let i = 0; i < 3; i++) service.search.search("旧笔记丙", { project: "p1" }, {});
  service.search.search("不存在的关键词zzz", { project: "p1" }, {});

  // ④ 回收站放一个假文件
  fs.mkdirSync(path.join(rootDir, ".trash"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, ".trash", "old.md"), "x".repeat(100));

  console.log("\n[C1] healthReport 五项结构");
  const h = service.healthReport();
  check("结构完整", () => {
    assert.ok(h.generatedAt > 0);
    assert.ok(h.zombies && typeof h.zombies.count === "number");
    assert.ok(Array.isArray(h.trend));
    assert.ok(Array.isArray(h.byType));
    assert.ok(Array.isArray(h.byProject));
    assert.ok(Array.isArray(h.chains));
    assert.ok(h.trash && typeof h.trash.count === "number");
  });

  console.log("\n[C2] 僵尸记忆识别");
  check("僵尸 = 2（old1/old2；old3 有命中不算，new1 不满 90 天不算）", () => {
    assert.strictEqual(h.zombies.count, 2);
  });
  check("样本含 old1", () => {
    assert.ok(h.zombies.samples.some((z) => z.id === "old1"));
  });

  console.log("\n[C3] 检索趋势");
  check("近 4 周有 4 次检索", () => {
    const q = h.trend.reduce((s, t) => s + t.queries, 0);
    assert.strictEqual(q, 4);
  });
  check("零命中检索 = 1", () => {
    const e = h.trend.reduce((s, t) => s + t.emptyQueries, 0);
    assert.strictEqual(e, 1);
  });

  console.log("\n[C4] 演化链");
  check("最长链 = 3（A→B→C）", () => {
    assert.ok(h.chains.length >= 1);
    assert.strictEqual(h.chains[0].length, 3);
  });
  check("链首是「最初方案」", () => {
    assert.strictEqual(h.chains[0].head, "最初方案");
  });

  console.log("\n[C5] 回收站统计");
  check("回收站 1 个文件", () => {
    assert.strictEqual(h.trash.count, 1);
  });
  check("字节数 ≥ 100", () => {
    assert.ok(h.trash.bytes >= 100);
  });

  console.log("\n[C6] statusForAgent 体检摘要");
  const st = service.statusForAgent();
  check("health 摘要存在且数字正确", () => {
    assert.ok(st.health);
    assert.strictEqual(st.health.zombies, 2);
    assert.strictEqual(st.health.trash, 1);
    assert.strictEqual(st.health.maxChain, 3);
    assert.strictEqual(st.health.recentQueries, 4);
  });
  check("原有字段不受影响", () => {
    assert.strictEqual(st.ok, true);
    assert.ok(st.memories >= 7);
  });

  console.log("\n[C7] 报告落 mem_meta（调度任务路径）");
  check("setMeta 读写往返", () => {
    service.index.setMeta("mem_health_report", JSON.stringify(h));
    const back = JSON.parse(service.index.getMeta("mem_health_report"));
    assert.strictEqual(back.zombies.count, 2);
  });

  service.index.close();
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true });
}

console.log(`\n=================================================`);
console.log(` C 项体检验证: 通过 ${pass} 项, 失败 ${fail} 项`);
console.log(`=================================================`);
process.exit(fail > 0 ? 1 : 0);
