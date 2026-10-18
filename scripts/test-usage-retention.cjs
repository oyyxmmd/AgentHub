// 请求流水保留期自测：注入值真驱动启动 GC、手动清理的边界与「宁可少删」的兜底、
// 以及后端→preload→前端四处接线的逐点钉。
// 跑法：node scripts/test-usage-retention.cjs
//   （store.cjs 优先用 node:sqlite；老版本 node 没有它时用 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/test-usage-retention.cjs）
// 纯临时沙箱（APPDATA / AGENT_SKILLS_HOME 指到 mkdtemp），不碰真实 stats.db、不联网、不起窗口。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-retention-"));
process.env.APPDATA = path.join(WORK, "appdata");
process.env.AGENT_SKILLS_HOME = path.join(WORK, "hub");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

const store = require(path.join(ROOT, "electron", "backend", "proxy", "store.cjs"));
// 断言抛出时结尾的清理跑不到：库句柄留在进程里，父进程等管道会等不到头
process.on("exit", () => { try { store.close(); } catch { /* 报错退出，关不掉不影响结论 */ } });

let pass = 0, failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}
const DAY = 86400000;
const NOW = Date.now();

/** 走公开读面拿总数（不直连 db，避免判据依赖内部实现） */
function total() { return store.statsDetail({ page: 1, pageSize: 1 }).total; }
function put(ageDays, tag) {
  store.insertUsage({ ts: NOW - ageDays * DAY, reqId: tag, model: "m", channel: "trae", status: 200 });
}
/** 重开库：open() 里才会跑启动 GC，这是观察「注入值有没有真驱动 GC」的唯一途径 */
function reopen() { store.close(); store.listAgents(); }

// 前置：两个新导出没落地（改动没合上）时报一条干净的红并跳过 ①②，③ 的接线钉照常跑——
// 基线上跑这份自测能看到「每一条都在管真事」，而不是一句异常中断
const API_OK = typeof store.setUsageRetention === "function" && typeof store.cleanupUsage === "function";
if (!API_OK) {
  ok(false, "①② 前置：store 的导出面上没有 setUsageRetention / cleanupUsage（改动没落地，这两段跳过）");
}

// ===== ① 注入值真驱动启动 GC（两档必须给出不同结果，否则 setter 是装饰品）=====
if (API_OK) {
  put(0, "fresh"); put(2, "d2"); put(400, "d400");
  store.setUsageRetention(90);
  reopen();
  ok(total() === 2, `① 保留期 90 天时，400 天前的流水被启动 GC 删掉、2 天前的留着（实测剩 ${total()} 条，应为 fresh + d2）`);

  store.setUsageRetention(1);
  reopen();
  ok(total() === 1, `① 改成 1 天后重开库，2 天前的那条也没了（实测剩 ${total()} 条）——两档结果不同才说明 GC 吃的是注入值而不是写死的 90`);

  // 非法值必须「忽略并保留现值」：这里现值是 1，若非法值被当成 0，cutoff=now，fresh 也会被删
  put(0, "fresh2");
  store.setUsageRetention("abc");
  reopen();
  ok(total() === 2, `① 非法值（"abc"）不改现值：GC 仍按 1 天跑，刚写入的那条还在（实测 ${total()} 条）——若这里少了一条，说明垃圾值被当成 0=删光`);
  for (const bad of [undefined, null, "", NaN, 0, -5, 3651, 99999, "0"]) {
    store.setUsageRetention(bad);
  }
  reopen();
  ok(total() === 2, `① 一整串非法值（undefined/null/""/NaN/0/负数/超上界/数字串 0）跑完仍不改现值（实测 ${total()} 条）`);
  store.setUsageRetention(90);
  reopen();
}

// ===== ② 手动清理：按天删 / 清空 / 边界钳位 =====
if (API_OK) {
  store.cleanupUsage(undefined, true); // 从空表开始，别接着 ① 的数据算数
  put(0, "k0"); put(30, "k30"); put(400, "k400");
  const r1 = store.cleanupUsage(90, false);
  ok(r1.deleted === 1 && total() === 2,
    `② days=90 只删 400 天前那条（deleted=${r1.deleted}，剩 ${total()} 条）`);
  ok(r1.cutoff > 0 && Math.abs((Date.now() - r1.cutoff) / DAY - 90) < 1,
    `② 返回的 cutoff 就是「now − 90 天」（实测偏移 ${((Date.now() - r1.cutoff) / DAY).toFixed(2)} 天）`);

  const r2 = store.cleanupUsage("7", false);
  ok(r2.deleted === 1 && total() === 1,
    `② 数字串 "7" 同样生效（deleted=${r2.deleted}，剩 ${total()} 条）——设置页 v-model.number 之外的入口也得认`);

  const r3 = store.cleanupUsage(90, true);
  ok(r3.deleted === 1 && r3.cutoff === 0 && total() === 0,
    `② all=true 清空整表且 cutoff 归 0（deleted=${r3.deleted}，剩 ${total()} 条）`);

  // 垃圾 days 必须退回 90 天而不是 1 天：这条路径删的是不可恢复的历史，宁可少删
  put(0, "g0"); put(30, "g30");
  const r4 = store.cleanupUsage(undefined, false);
  const r5 = store.cleanupUsage("abc", false);
  const r6 = store.cleanupUsage(0, false);
  ok(total() === 2 && r4.deleted === 0 && r5.deleted === 0 && r6.deleted === 0,
    `② 垃圾 days（undefined/"abc"/0）一律按 90 天兜底，30 天前那条不能被删（deleted=${r4.deleted}/${r5.deleted}/${r6.deleted}，剩 ${total()} 条）`);

  put(3000, "k3000"); put(4000, "k4000");
  const r7 = store.cleanupUsage(99999, false);
  ok(total() === 3 && r7.deleted === 1,
    `② days 超上界按 3650 钳位：4000 天前的删、3000 天前的留（deleted=${r7.deleted}，剩 ${total()} 条）`);
  store.cleanupUsage(undefined, true);
  ok(total() === 0, `② 收尾清空（剩 ${total()} 条），下一段从空表开始`);
}

// ===== ③ 接线逐点钉：每条都要求「恰好命中一次」，命中 0 或多次都判红 =====
{
  const pins = [
    ["electron/backend/config.cjs", /usageRetentionDays:\s*90,/g, "设置默认值 90（= 改动前 gc() 里写死的那个数）"],
    ["electron/backend/proxy/store.cjs", /let usageRetentionDays = 90;/g, "store 的模块级默认 90"],
    ["electron/backend/proxy/store.cjs", /function setUsageRetention\(/g, "setter 定义"],
    ["electron/backend/proxy/store.cjs", /Math\.max\(1, usageRetentionDays\)/g, "gc() 的 cutoff 吃注入值"],
    ["electron/backend/proxy/store.cjs", /function cleanupUsage\(/g, "手动清理定义"],
    ["electron/backend/proxy/store.cjs", /cleanupUsage,\s*setUsageRetention,/g, "两个函数都在导出面上"],
    ["electron/backend/proxy/index.cjs", /store\.setUsageRetention\(settings\(\)\.usageRetentionDays\)/g, "register() 从设置灌入"],
    ["electron/backend/proxy/index.cjs", /ipcMain\.handle\("proxy_stats_cleanup"/g, "IPC 处理器注册"],
    ["electron/preload.cjs", /"proxy_stats_cleanup",/g, "preload 白名单登记（漏了渲染层会收到「未授权的 IPC 命令」）"],
    ["src/types/index.ts", /usageRetentionDays: number;/g, "前端类型字段"],
    ["src/stores/app.ts", /usageRetentionDays: 90,/g, "前端默认值"],
    ["src/api/mock.ts", /usageRetentionDays: 90,/g, "浏览器预览的默认值"],
    ["src/api/mock.ts", /case "proxy_stats_cleanup"/g, "浏览器预览的 mock 分支"],
    ["src/api/ipc.ts", /export const proxyStatsCleanup = /g, "渲染层 api 出口"],
    ["src/components/config/ConfigProxySection.vue", /v-model\.number="app\.config\.proxy\.usageRetentionDays"/g, "设置页输入框"],
    ["src/components/config/ConfigProxySection.vue", /app\.config\.proxy\.usageRetentionDays = Number\.isFinite\(urd\) && Math\.round\(urd\) >= 1 \? Math\.min\(3650, Math\.round\(urd\)\) : 90;/g, "保存时钳位（非正值兜底 90，不钳成 1 天）"],
    ["src/views/proxy/ProxyStatsView.vue", /api\.proxyStatsCleanup\(/g, "统计页真的调这个命令"],
  ];
  for (const [rel, re, label] of pins) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const n = (src.match(new RegExp(re.source, "g")) || []).length;
    ok(n === 1, `③ ${rel}：${label} 恰好一处（实测 ${n} 处）`);
  }
  // 全仓 IPC 面自证：注册的命令都在白名单里（这条不只管本次新增的那一条）
  const pre = fs.readFileSync(path.join(ROOT, "electron", "preload.cjs"), "utf8");
  const allowed = new Set([...pre.matchAll(/^\s+"([a-z0-9_]+)",/gm)].map((m) => m[1]));
  const registered = new Set();
  for (const rel of ["electron/backend/ipc.cjs", "electron/backend/sync-ipc.cjs", "electron/backend/proxy/index.cjs"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/ipcMain\.handle\(\s*"([a-z0-9_]+)"/g)) registered.add(m[1]);
  }
  const missing = [...registered].filter((c) => !allowed.has(c));
  ok(registered.size > 60 && missing.length === 0,
    `③ 全仓 ${registered.size} 条 ipcMain.handle 都在 preload 白名单里（缺：${missing.join(" ") || "无"}）`);

  // 散文口径：改了行为就得改掉那句「写死 90 天」
  const stats = fs.readFileSync(path.join(ROOT, "src/views/proxy/ProxyStatsView.vue"), "utf8");
  ok(!/流水保留 90 天/.test(stats), "③ 统计页头注释不再写着「流水保留 90 天」（保留期已可配）");
  const cfgSec = fs.readFileSync(path.join(ROOT, "src/components/config/ConfigProxySection.vue"), "utf8");
  ok(!/>90 天（启动时自动清理）</.test(cfgSec), "③ 设置页那行不再是写死的只读文本");
  const storeSrc = fs.readFileSync(path.join(ROOT, "electron/backend/proxy/store.cjs"), "utf8");
  ok(!/Date\.now\(\) - 90 \* 86400000/.test(storeSrc), "③ gc() 里没有残留的 90 天硬编码");
}

// ===== ④ 设置页钳位：把 .vue 里那两行原样抠出来真跑，而不是正则看过就算 =====
// 真机 CDP 探针（vite preview + headless Chrome）量出「清空输入框直接保存」会把流水删到只剩一天，
// 而 1 天正是这条设置最破坏性的取值——所以非正值一律兜底 90，而不是钳到下限 1：
// 钳到 1 等于替用户把保留期静默改成一天，下次启动 GC 就把一天前的流水整批删了。
{
  const src = fs.readFileSync(path.join(ROOT, "src/components/config/ConfigProxySection.vue"), "utf8");
  const m = src.match(/const urd = ([^\n]+);\r?\n\s*app\.config\.proxy\.usageRetentionDays = ([^\n]+);/);
  ok(!!m, `④ 从设置页源码抠到钳位那两行（抠不到即判红，不能让判据静默空转）`);
  if (!m) {
    // 后续断言全依赖这两行，抠不到就别再跑，避免把「没有判据」读成「判据通过」
  } else {
    const body = `const urd = ${m[1]}; return ${m[2]};`;
    const clamp = (v) => new Function("app", body)({ config: { proxy: { usageRetentionDays: v } } });
    const T = [
      [30, 30, "正常值原样落盘"],
      [0, 90, "填 0 → 兜底 90（不钳成 1：钳成 1 就是替用户把保留期改成一天，下次 GC 删掉一天前全部流水）"],
      [-5, 90, "负数同样兜底 90"],
      [9999, 3650, "超上界钳到 3650"],
      [7.6, 8, "小数取整"],
      [" 45 ", 45, "带空格能解析"],
      ["", 90, "清空输入框 → 兜底 90 而不是 1"],
      ["abc", 90, "垃圾值 → 兜底 90"],
      [null, 90, "null → 兜底 90"],
      [undefined, 90, "undefined → 兜底 90"],
      [NaN, 90, "NaN → 兜底 90"],
    ];
    for (const [input, want, why] of T) ok(clamp(input) === want, `④ ${why}：${String(input)} → ${want}（实测 ${clamp(input)}）`);
    // 差分正对照：同一套判据跑在「钳到下限」的朴素写法上，必须真的把 "" 与 0 判成 1——
    // 否则上面那两条 →90 是恒真的空判据
    const naive = (v) => {
      const urd = Number(v);
      return Math.min(3650, Math.max(1, Math.round(Number.isFinite(urd) ? urd : 90)));
    };
    ok(naive("") === 1 && naive(null) === 1 && naive(0) === 1,
      `④ 正对照：朴素写法会把 "" / null / 0 都钳成 1 天（实测 ${naive("")}/${naive(null)}/${naive(0)}），证明上面那几条兜底判据抓得到缺陷`);
    ok(clamp("") !== naive("") && clamp(0) !== naive(0),
      "④ shipped 写法与朴素写法在空值和 0 上都分岔（判据不是两边都过的摆设）");
  }
}

try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 占用不影响结论 */ }
console.log(`\n${failed ? "FAIL" : "OK"} 流水保留期自测：${pass} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
