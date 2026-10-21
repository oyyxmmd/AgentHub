// 同步全局取消信号归属自测（issue #146 猜想 2）
// 运行：node scripts/test-sync-signal-ownership.cjs
// 背景：usage 本地同步不拿全局远端锁，却曾无条件 setActiveSignal —— 与远端同步并发时
// 会覆盖对方的取消信号，本地结束再写 null，远端在途请求因此失去取消能力。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-sync-signal-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

let pass = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", msg);
  } else {
    failed++;
    console.log("  \u2717", msg, got !== undefined ? `→ got ${JSON.stringify(got)}` : "");
  }
}

(async () => {
  const webdav = require("../electron/backend/webdav.cjs");
  console.log("\n[1] 全局同步锁的基本语义");
  {
    ok(webdav.tryBeginSync("a") === true, "空闲时可占锁");
    ok(webdav.syncBusyTag() === "a", "标签正确");
    ok(webdav.syncHeldMs() >= 0, "持锁时长可读");
    ok(webdav.tryBeginSync("b") === false, "已占用时拒绝第二个");
    webdav.endSync();
    ok(webdav.syncBusyTag() === null && webdav.syncHeldMs() === 0, "释放后归零");
  }

  console.log("\n[2] 本地同步不得触碰全局取消信号");
  {
    const calls = [];
    const origSet = webdav.setActiveSignal;
    webdav.setActiveSignal = (signal) => { calls.push(signal === null ? "null" : "signal"); };
    const sync = require("../electron/backend/sync.cjs");
    try {
      const cfg = { webdav: {}, sources: [], deviceName: "selftest" };
      const r = await sync.run(cfg, { mode: "backup" });
      ok(r && r.ok === true, "本地备份模式跑完", r);
      ok(calls.length === 0, "未调用 setActiveSignal（不覆盖远端信号）", calls);
      ok(webdav.syncBusyTag() === null, "未占用全局远端锁");
    } finally {
      webdav.setActiveSignal = origSet;
    }
  }

  console.log(`\n${failed ? "\u2717" : "OK"} 同步信号归属自测：${pass} 项通过，${failed} 项失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
