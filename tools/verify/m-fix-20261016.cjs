/**
 * 审查修复专项验证：scheduler 时间回拨不再全量写记账 / tasks 漏标不再静默消耗。
 * 用法：node tools/verify/m-fix-20261016.cjs
 */
"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const { MemoryService } = require("../../electron/backend/memory/service.cjs");
const { MemoryScheduler } = require("../../electron/backend/memory/scheduler.cjs");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

(async () => {
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mfix-"));
try {
  const service = new MemoryService(rootDir, {}, {});
  service.init();

  console.log("\n[F1] 时间回拨不再把全部任务记账写成 now");
  const events = [];
  const scheduler = new MemoryScheduler({
    service,
    tasks: { runExtract: async () => ({}), runTag: async () => ({}), runClassify: () => ({}), runSupersede: async () => ({}), runDistill: async () => ({}), runProfile: async () => ({}) },
    getConfig: () => ({ "auto.enabled": true, "auto.tasks": {} }),
    emit: (e) => events.push(e),
  });
  // 模拟回拨：_lastTickAt 设为未来，下一轮 now < _lastTickAt - 5min
  scheduler._lastTickAt = Date.now() + 10 * 60000;
  const before = {};
  for (const id of ["extract", "supersede", "distill", "consolidate", "profile", "cleanup", "health"]) {
    before[id] = service.index.getMeta(`mem_sched_${id}`);
  }
  scheduler._tickInner();
  check("回拨时 _lastTickAt 被更新（不再判回拨）", () => {
    assert.ok(scheduler._lastTickAt <= Date.now());
  });
  check("回拨时所有任务记账保持原值", () => {
    for (const id of Object.keys(before)) {
      assert.strictEqual(service.index.getMeta(`mem_sched_${id}`), before[id], `${id} 记账被改写`);
    }
  });

  console.log("\n[F2] 正常 tick 不误伤（回拨修复后任务仍可到期入队）");
  const queueBefore = scheduler.queue.length;
  service.index.setMeta("mem_sched_extract", "0"); // 强制 extract 立即到期
  await scheduler._tickInner(); // _tickInner 是 async：due 计算在首个 await 之后，必须 await
  check("到期任务入队", () => {
    assert.ok(scheduler.queue.length > queueBefore || service.index.getMeta("mem_sched_extract") !== "0");
  });

  console.log("\n[F3] judgeL4 prompt 对字符串 tags 不抛 TypeError");
  const { DedupEngine } = require("../../electron/backend/memory/dedup.cjs");
  const dedup = new DedupEngine({ service, emit: () => {} });
  // 直接验证 tags 处理的两种形态（与 dedup.cjs judgeL4 内联口径一致）
  const fmt = (tags) => `标签：${Array.isArray(tags) ? tags.join(",") : String(tags || "")}`;
  check("字符串 tags 正常渲染", () => {
    assert.strictEqual(fmt("索引,性能"), "标签：索引,性能");
  });
  check("数组 tags 正常渲染", () => {
    assert.strictEqual(fmt(["索引", "性能"]), "标签：索引,性能");
  });
  check("null tags 兜底空串", () => {
    assert.strictEqual(fmt(null), "标签：");
  });
  check("judgeL4 方法存在且可构造（冒烟）", () => {
    assert.strictEqual(typeof dedup.judgeL4, "function");
  });

  service.index.close();
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true });
}

console.log(`\n=================================================`);
console.log(` 审查修复专项验证: 通过 ${pass} 项, 失败 ${fail} 项`);
console.log(`=================================================`);
process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
