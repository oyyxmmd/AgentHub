// 候选队列耗尽文案回归自测（issue #106）
// 运行：node scripts/test-concurrency-message.cjs
// 只 require 纯函数，不启服务、不碰网络/磁盘
//
// 背景：队列耗尽时的 msg 取 lastErr，而 lastErr 是「首错保留」写法的产物——
// 谁先撞上并发墙谁就成了最终文案。用户看到「渠道 A 在途并发已满（8/8）」，
// 但请求其实把 B、C 也试了、也满了，观感上像「B 明明刚开始用却也报这个」，
// 第一反应是怀疑错误串号。concurrencyBlockedMessage() 就是为这条观感兜底的：
// 全部候选都在途满时，改说「所有候选渠道均在途并发已满（逐渠道用量）」。
"use strict";
const { concurrencyBlockedMessage } = require("../electron/backend/proxy/server.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}`);
  }
}

const t = (chan, note) => ({ chan, accounts: [], note });
const CONC = (n, m) => `在途并发已满（${n}/${m}）`;

function main() {
  console.log("\n[1] 全部候选都在途满、且一次上游都没发出去 → 聚合口径");
  {
    const r = concurrencyBlockedMessage([t("qoder", CONC(8, 8)), t("zcode", CONC(8, 8))], 0);
    ok(/^所有候选渠道均在途并发已满/.test(r), "以聚合口径开头（不再甩单个渠道的 429）");
    ok(r.includes("qoder") && r.includes("zcode"), "逐渠道列出，用户能看到都试过谁");
    ok(r.includes("8/8"), "带实际用量，能区分「满」和「差一点」");
    ok(!r.includes("已尝试"), "不套「已尝试 N 个渠道」通用包装（避免语义重复）");
  }

  console.log("\n[2] 有渠道真发过上游请求 → 交回通用包装（空串）");
  {
    ok(concurrencyBlockedMessage([t("qoder", CONC(8, 8))], 1) === "", "upstreamTries>0 → 空串");
    ok(concurrencyBlockedMessage([t("qoder", CONC(8, 8)), t("zcode", CONC(8, 8))], 2) === "", "多候选亦然");
  }

  console.log("\n[3] 失败原因不一致 → 不套聚合口径");
  {
    ok(concurrencyBlockedMessage([t("qoder", CONC(8, 8)), t("zcode", "渠道降级中")], 0) === "", "并发满 + 降级中 → 空串");
    ok(concurrencyBlockedMessage([t("qoder", CONC(8, 8)), t("zcode", "未配置反向映射")], 0) === "", "并发满 + 未配映射 → 空串");
    // 降级中与并发满都不带账号名，但原因完全不同——混在一起报会误导（代码注释已警告过这个歧义）
    ok(concurrencyBlockedMessage([t("qoder", "渠道降级中"), t("zcode", "渠道降级中")], 0) === "", "全降级中也不套并发口径");
  }

  console.log("\n[4] 空轨迹 / 非法输入 → 空串（不抛）");
  {
    ok(concurrencyBlockedMessage([], 0) === "", "空数组 → 空串");
    ok(concurrencyBlockedMessage(null, 0) === "", "null → 空串");
    ok(concurrencyBlockedMessage(undefined, 0) === "", "undefined → 空串");
  }

  console.log("\n[5] 轨迹含 null 项 → 不误判为「全部满」");
  {
    ok(concurrencyBlockedMessage([t("qoder", CONC(8, 8)), null], 0) === "", "含 null → 空串（不能当成都满）");
  }

  console.log("\n[6] 单个候选也满 → 同样走聚合口径");
  {
    const one = concurrencyBlockedMessage([t("qoder", CONC(3, 8))], 0);
    ok(/^所有候选渠道均在途并发已满/.test(one), "单候选也是「全部候选」");
    ok(one.includes("3/8"), "带用量 3/8");
  }

  console.log("\n[7] 同一渠道多轮重复 → 明细去重");
  {
    const dup = concurrencyBlockedMessage([t("qoder", CONC(8, 8)), t("qoder", CONC(8, 8))], 0);
    ok(dup.split("qoder").length - 1 === 1, "同渠道同用量只出现一次");
    // 用量不同则保留两条：它反映的是队列里两轮撞到不同并发水位，不该合并
    const two = concurrencyBlockedMessage([t("qoder", CONC(8, 8)), t("qoder", CONC(7, 8))], 0);
    ok(two.split("qoder").length - 1 === 2, "同渠道不同用量保留两条");
  }

  console.log(`\n${failed ? "\u2717" : "OK"} 并发耗尽文案自测：${pass} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
}

main();
