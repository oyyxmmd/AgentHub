/**
 * 待确认队列「引用失效」专项验证（2026-10-16 修复）：
 *   现象：收件箱里偶现"处理必失败 + 查看此记忆提示不存在"的死项（AI 复述长 id 时日期漂移，
 *         如 mem_20260822_476a5e816593 写成 mem_20260817_476a5e816593；以及记忆删除后的残留）。
 *   修复：① 生产端校验模型返回的 id 必须逐字命中素材 ② 消费端引用缺失 → 自动作废收口
 *         ③ 列表拉取时惰性清扫历史残留 ④ 顺手修 classify/merge 的"假成功"
 * 用法：node tools/verify/m-review-stale.cjs
 *   需 Node ≥ 22（indexer 依赖 node:sqlite）；本机 nvm 的 C:\nvm4w\nodejs 可能被切到 v16，
 *   报 ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite 时改用绝对路径 E:\nvm\v22.22.0\node.exe。
 */
"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const { MemoryService } = require("../../electron/backend/memory/service.cjs");
const { DedupEngine } = require("../../electron/backend/memory/dedup.cjs");
const { resolveReview } = require("../../electron/backend/memory/index.cjs");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

(async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mstale-"));
  try {
    const svc = new MemoryService(rootDir, {}, {});
    svc.init();
    const idx = svc.index;

    // 两条"活着"的记忆（只进索引；markSuperseded 对缺失文件有保护，走 DB 侧收口）
    idx.upsertOne({ id: "mem_alive_1", path: "notes/alive1.md", title: "活着的旧事实", layer: "l1", type: "knowledge", hash: "h1", summary: "s1", created: Date.now() });
    idx.upsertOne({ id: "mem_alive_2", path: "notes/alive2.md", title: "活着的新事实", layer: "l1", type: "knowledge", hash: "h2", summary: "s2", created: Date.now() });

    console.log("\n[S1] sweepStaleReview：三类孤儿 + 损坏 payload 清扫，完好项保留");
    idx.reviewAdd("supersede", { oldId: "mem_ghost_1", newId: "mem_alive_2", confidence: 0.6, reason: "模型漂移 id" });
    idx.reviewAdd("supersede", { oldId: "mem_alive_1", newId: "mem_alive_2", confidence: 0.9, reason: "真实建议" });
    idx.reviewAdd("classify", { memoryId: "mem_ghost_2", slug: "x--y", name: "Y" });
    idx.reviewAdd("classify", { memoryId: "mem_alive_1", slug: "x--y", name: "Y" });
    idx.reviewAdd("dedup", { kind: "UPDATE", newId: "mem_alive_2", targetId: "mem_ghost_3", confidence: 0.7, reason: "r" });
    idx.reviewAdd("dedup", { kind: "UPDATE", newId: "mem_alive_2", targetId: "mem_alive_1", confidence: 0.7, reason: "r2" });
    idx.db.prepare("INSERT INTO review_queue (id, kind, payload, status, created) VALUES ('rq_broken', 'supersede', '{not json', 'pending', ?)").run(Date.now());

    check("sweep 清掉 4 条（3 孤儿 + 1 损坏），返回清理数", () => assert.strictEqual(idx.sweepStaleReview(), 4));
    check("三个 kind 的完好项仍在 pending（各 1 条）", () => {
      assert.strictEqual(idx.reviewList("pending", "supersede").length, 1);
      assert.strictEqual(idx.reviewList("pending", "classify").length, 1);
      assert.strictEqual(idx.reviewList("pending", "dedup").length, 1);
    });
    check("作废项 resolution 记为 stale", () => {
      const r = idx.db.prepare("SELECT COUNT(*) AS c FROM review_queue WHERE status='resolved' AND resolution='stale'").get();
      assert.strictEqual(r.c, 4);
    });
    check("再扫一遍幂等（0 条）", () => assert.strictEqual(idx.sweepStaleReview(), 0));

    console.log("\n[S2] resolveReview：引用已消失 → ok + stale 作废（不再报处理失败）");
    const ghostQ = idx.reviewAdd("supersede", { oldId: "mem_ghost_9", newId: null, confidence: 0.6, reason: "漂移" });
    const rGhost = await resolveReview(svc, ghostQ, "confirm");
    check("孤儿 supersede confirm 返回 ok+stale，原因带缺失 id", () => {
      assert.strictEqual(rGhost.ok, true);
      assert.strictEqual(rGhost.stale, true);
      assert.ok(String(rGhost.message).includes("mem_ghost_9"), "message 应指明缺失的记忆 id");
    });
    check("孤儿项已出队（resolution=stale）", () => {
      const row = idx.db.prepare("SELECT status, resolution FROM review_queue WHERE id = ?").get(ghostQ);
      assert.strictEqual(row.status, "resolved");
      assert.strictEqual(row.resolution, "stale");
    });

    const ghostClassifyQ = idx.reviewAdd("classify", { memoryId: "mem_ghost_11", slug: "a--b", name: "B" });
    const rGhostCls = await resolveReview(svc, ghostClassifyQ, "assign", { slug: "a--b" });
    check("孤儿 classify assign 同样 stale 收口", () => {
      assert.strictEqual(rGhostCls.ok, true);
      assert.strictEqual(rGhostCls.stale, true);
    });

    console.log("\n[S3] 正常路径不被误伤");
    const liveQ = idx.reviewList("pending", "supersede")[0].id;
    const rLive = await resolveReview(svc, liveQ, "confirm");
    check("活项 confirm 正常成功（无 stale 标记）", () => {
      assert.strictEqual(rLive.ok, true);
      assert.strictEqual(rLive.stale, undefined);
    });
    check("活项旧事实已被标失效（valid_to 已写）", () => {
      const row = idx.db.prepare("SELECT valid_to FROM mem WHERE id = 'mem_alive_1'").get();
      assert.ok(row.valid_to, "valid_to 应被设置");
    });

    console.log("\n[S4] dedup.resolveQueue：孤儿 stale 收口，正常动作照旧");
    const dd = new DedupEngine({ service: svc, client: null, emit: () => {} });
    const dqGhost = idx.reviewAdd("dedup", { kind: "DELETE", newId: "mem_ghost_10", targetId: "mem_alive_2", confidence: 0.5, reason: "r" });
    const rdGhost = await dd.resolveQueue(dqGhost, "adoptNew");
    check("dedup 孤儿 adoptNew → ok+stale", () => {
      assert.strictEqual(rdGhost.ok, true);
      assert.strictEqual(rdGhost.stale, true);
    });
    const dqLive = idx.reviewAdd("dedup", { kind: "UPDATE", newId: "mem_alive_1", targetId: "mem_alive_2", confidence: 0.6, reason: "r" });
    const rdLive = await dd.resolveQueue(dqLive, "keepBoth");
    check("dedup 活项 keepBoth 正常成功且学习表已记入", () => {
      assert.strictEqual(rdLive.ok, true);
      assert.strictEqual(rdLive.stale, undefined);
      assert.strictEqual(dd._learnedPairs().length, 1);
    });
    const dqDismiss = idx.reviewAdd("dedup", { kind: "DELETE", newId: "mem_ghost_12", targetId: "mem_ghost_13", confidence: 0.5, reason: "r" });
    const rdDismiss = await dd.resolveQueue(dqDismiss, "dismiss");
    check("dedup 孤儿 dismiss 仍可直接忽略（不需要引用）", () => {
      assert.strictEqual(rdDismiss.ok, true);
      assert.strictEqual(idx.db.prepare("SELECT resolution FROM review_queue WHERE id = ?").get(dqDismiss).resolution, "dismissed");
    });

    console.log("\n[S6] 只读库口径：写不进作废标记时如实失败，不报假成功");
    const ghostRo = idx.reviewAdd("supersede", { oldId: "mem_ghost_20", newId: null, confidence: 0.6, reason: "漂移" });
    idx.readOnly = true;
    const rRo = await resolveReview(svc, ghostRo, "confirm");
    check("只读时孤儿 confirm → 失败并提示只读（不谎报已作废）", () => {
      assert.strictEqual(rRo.ok, false);
      assert.ok(String(rRo.message).includes("只读"), "message 应提示只读模式");
    });
    check("只读时该项仍在 pending（未落库）", () => {
      assert.strictEqual(idx.db.prepare("SELECT status FROM review_queue WHERE id = ?").get(ghostRo).status, "pending");
    });
    check("只读时 sweep 不动队列（返回 0）", () => assert.strictEqual(idx.sweepStaleReview(), 0));
    idx.readOnly = false;

    console.log("\n[S5] 生产端校验（静态断言，防回退）");
    const tasksSrc = fs.readFileSync(path.join(__dirname, "../../electron/backend/memory/tasks.cjs"), "utf8");
    check("runSupersede 校验 pairs 的 oldId/newId 在素材内", () =>
      assert.ok(tasksSrc.includes("if (!knownIds.has(p.oldId) || !knownIds.has(p.newId)) { dropped++; continue; }")));
    check("runDistill 校验 supersedeSuggestions 的 oldId 在素材内", () =>
      assert.ok(tasksSrc.includes("if (!knownIds.has(s.oldId)) { dropped++; continue; }")));
    const idxSrc = fs.readFileSync(path.join(__dirname, "../../electron/backend/memory/index.cjs"), "utf8");
    check("review list IPC 挂上惰性清扫", () =>
      assert.ok(idxSrc.includes("need().index.sweepStaleReview();"), "两个 review list handler 应调用 sweepStaleReview"));
  } finally {
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log("\n=================================================");
  console.log(` 待确认队列引用失效专项验证: 通过 ${pass} 项, 失败 ${fail} 项`);
  console.log("=================================================");
  process.exit(fail ? 1 : 0);
})();
