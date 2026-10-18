// start_sync 拒绝理由回传自测：本地统计进行中点「立即同步」必须有可见反馈
// 运行：node scripts/test-start-sync-feedback.cjs
// 不联网、不碰真实配置（sync-config.loadConfig 与 sync.run/progress/isBusy 全部打桩），
// 只验证「主进程那条拒绝分支把理由交到渲染层手里」这一件事。
//
// 缺陷：本地统计 runLocal 刻意不进 progress() 状态机（其头注释即「静默执行」），于是
// start_sync 前置的两条 progress 检查放行；sync.run() 自己的同名守卫抛错落进 fire-and-forget
// 的 console.error，渲染层既没反应也没提示。另外 api.startSync 原先类型写成 void，
// 就算主进程回了 {ok:false,message}，渲染层也没读。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-start-sync-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

// ---- 打桩：sync-ipc 拿的是模块对象引用，运行时取属性，所以这样替换生效 ----
const sync = require("../electron/backend/sync.cjs");
const syncConfig = require("../electron/backend/sync-config.cjs");
const fake = { progress: {}, busy: false, runCalls: 0 };
sync.progress = () => fake.progress;
sync.isBusy = () => fake.busy;
sync.run = () => { fake.runCalls++; return Promise.resolve(); };
syncConfig.loadConfig = () => ({ webdav: {}, sources: [] });

const { registerSync } = require("../electron/backend/sync-ipc.cjs");
const handlers = new Map();
registerSync({
  ipcMain: { handle: (cmd, fn) => handlers.set(cmd, fn) },
  app: { getPath: () => TMP, getName: () => "AgentHub" },
  shell: { openPath: () => Promise.resolve("") },
});

// handler 是 async（ipcMain.handle 的常态），必须 await 才拿得到返回值本身
const startSync = async (args) => handlers.get("start_sync")(null, args || {});

// .cjs 没有顶层 await：把断言与收尾挂在同一条 promise 链上
(async () => {
  // ===== ① 四条前置分支各归各 =====
  {
    fake.progress = {}; fake.busy = false; fake.runCalls = 0;
    const r = await startSync();
    ok(r === null && fake.runCalls === 1, "① 空闲：放行、后台起一轮，返回 null（原有语义不变）");

    fake.progress = { running: true }; fake.busy = true; fake.runCalls = 0;
    const r2 = await startSync();
    ok(r2 && r2.ok === false && /同步正在进行中/.test(r2.message) && fake.runCalls === 0,
      "② 同步中：拒绝且不再起第二轮");

    fake.progress = { restoring: true }; fake.busy = true; fake.runCalls = 0;
    const r3 = await startSync();
    ok(r3 && r3.ok === false && /恢复/.test(r3.message) && fake.runCalls === 0,
      "③ 恢复中：拒绝");

    // 承重新增的那一条：progress() 看不见本地统计（running/restoring 都 false），只有 isBusy 为真
    fake.progress = { running: false, restoring: false }; fake.busy = true; fake.runCalls = 0;
    const r4 = await startSync();
    ok(r4 && r4.ok === false && fake.runCalls === 0,
      "④ 本地统计进行中：必须拒绝且不调 sync.run（改动前这条放行，run() 的守卫异常落进 console.error）");
    ok(r4 && typeof r4.message === "string" && r4.message.length > 0,
      "④ 且带上能显示的 message（返回 null 等于让渲染层无从显示）");

    fake.progress = {}; fake.busy = false; fake.runCalls = 0;
    const r5 = await startSync({ mode: "backup" });
    ok(r5 === null && fake.runCalls === 1, "⑤ 备份模式同样放行（新增判据没把「立即备份」一起挡掉）");
  }

  // ===== ⑥ 渲染层确实读了这个返回值（钉在 startSync 方法体内，切不到即判红） =====
  {
    const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

    const apiSrc = read("src/api/sync.ts");
    const apiLine = (apiSrc.match(/^export const startSync = .*$/m) || ["(找不到 startSync 导出行)"])[0];
    ok(!/call<\s*void\s*>/.test(apiLine),
      `⑥ api.startSync 的返回类型不能再写 void（否则主进程的回执在类型层就被判为不存在）：${apiLine.trim().slice(0, 72)}…`);

    const storeSrc = read("src/stores/sync.ts");
    const i0 = storeSrc.indexOf("async startSync(");
    const body = i0 < 0 ? "" : storeSrc.slice(i0, storeSrc.indexOf("\n    },", i0) + 5);
    ok(body.length > 200, "⑥ 拿到 store 的 startSync 方法体（切不到说明写法变了，宁可判红）");
    ok(/const r = await api\.startSync\(/.test(body), "⑥ 渲染层接住 start_sync 的返回值");
    ok(/if \(r && r\.ok === false\)/.test(body), "⑥ 按 ok===false 判拒绝");
    ok(body.indexOf("r.ok === false") > body.indexOf("await api.startSync("),
      "⑥ 判据在调用之后（顺序反了就是拿旧值判断）");
    // 拒绝分支必须写进 SyncDialog 真正渲染的两处：sync.message 与 stage/失败态
    const reject = body.slice(body.indexOf("r.ok === false"));
    ok(/message:\s*r\.message/.test(reject.slice(0, 400)),
      "⑥ 拒绝理由落到 app.sync.message（SyncDialog 那句 {{ app.sync.message }} 才显示得出来）");
    ok(/stage:\s*"error"/.test(reject.slice(0, 400)), "⑥ 同时置 error 态（弹窗靠它换配色与「失败」标签）");
    ok(/this\.syncing = false/.test(reject.slice(0, 400)),
      "⑥ 拒绝后立刻收掉「同步中」态（不收的话顶栏按钮停在禁用态转圈）");
  }

  // ===== ⑦ 理由必须撑过进度轮询的整份覆盖（这才是「看得见」的真正条件） =====
  {
    const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
    const storeSrc = read("src/stores/sync.ts");
    const dlg = read("src/components/sync/SyncDialog.vue");

    // 先自证「覆盖」确实存在：refreshProgress 是整份赋值，不是合并——所以只写 sync.message 不够
    const rp = storeSrc.slice(storeSrc.indexOf("async refreshProgress()"));
    ok(/this\.sync = \{ \.\.\.progress/.test(rp),
      "⑦ refreshProgress 仍把 app.sync 整份换成后端 progress（这条红了说明覆盖没了，⑦ 后面几条要重读）");

    const pTag = (dlg.match(/<p>\{\{[^}]*\}\}<\/p>/) || ["(找不到弹窗正文那句)"])[0];
    ok(pTag.includes("app.syncStartError") && pTag.indexOf("app.syncStartError") < pTag.indexOf("app.sync.message"),
      `⑦ 正文那句必须以 syncStartError 打头，否则理由活不过一个轮询周期：${pTag}`);
    ok(/error: !!app\.syncStartError \|\| app\.sync\.stage === 'error'/.test(dlg),
      "⑦ 失败配色同样要认 syncStartError（stage 会被轮询重置回空）");
    ok(/app\.syncStartError \? "失败"/.test(dlg), "⑦ 状态标题在被拒时显示「失败」而不是 stageLabel");

    const close = storeSrc.slice(storeSrc.indexOf("closeSyncDialog()"));
    ok(/this\.syncStartError = ""/.test(close.slice(0, 300)),
      "⑦ 关闭弹窗要清掉启动失败——它是这一次点击的结论，留着会顶在下一次打开上");
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用不影响结论 */ }
  console.log(`\n${failed ? "FAIL" : "OK"} start_sync 反馈自测：${pass} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(`\nFAIL 自测异常中断：${(e && e.stack) || e}`);
  process.exit(1);
});
