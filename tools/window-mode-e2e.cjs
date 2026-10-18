// 轻量模式**运行期**验证：真的起 Electron，走一遍「关窗 → 渲染进程消失 → 唤回 → 位置恢复」。
//
// 为什么不能只靠单元自测：决策表对了不等于接线对了 —— 真正要证明的是
//   ① close 事件里 destroy 后渲染进程**确实从进程表里消失**（内存真的还回去了）
//   ② 唤回时能重建窗口并回到原位置/原尺寸
//   ③ 主进程存活、托盘可用（后台服务不受影响）
//
// 用法：node tools/window-mode-e2e.cjs
//   结果写入 %TEMP%\ah-window-e2e\result.jsonl（GUI 进程 stdout 在 Windows 上不可靠）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const HARNESS = path.join(os.tmpdir(), "ah-window-e2e", "harness.cjs");
const OUTDIR = path.join(os.tmpdir(), "ah-window-e2e");

fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(HARNESS, harnessSource(ROOT, OUTDIR), "utf8");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 否则 electron.exe 会当纯 node 跑，require("electron") 直接失败

console.log("  起 Electron 跑轻量模式端到端验证…");
const r = spawnSync(ELECTRON, [HARNESS, "--user-data-dir=" + path.join(OUTDIR, "udd")], {
  cwd: ROOT,
  env,
  encoding: "utf8",
  timeout: 120000,
});

const resultFile = path.join(OUTDIR, "result.jsonl");
let rows = [];
try {
  rows = fs.readFileSync(resultFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
} catch { /* 没产出 */ }

if (!rows.length) {
  console.log("  FAIL 无结果产出（退出码 " + r.status + "）");
  console.log(String(r.stderr || "").split(/\r?\n/).slice(0, 20).join("\n"));
  process.exit(1);
}

let pass = 0, fail = 0;
const T = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n        " + detail : "")); }
};
const byLabel = (l) => rows.find((x) => x.label === l);

const closed = byLabel("after-close");
const revived = byLabel("after-revive");

T("E1 关窗后渲染进程（Tab）确实消失 —— 内存真的还回去了",
  closed && closed.rendererCount === 0,
  closed ? "仍剩渲染进程 " + closed.rendererCount + " 个" : "缺少 after-close 记录");

T("E2 关窗后主进程仍存活，托盘仍在（后台服务不受影响）",
  closed && closed.mainAlive === true && closed.trayAlive === true,
  JSON.stringify(closed));

T("E3 关窗后窗口对象已置空（不会残留已销毁引用）",
  closed && closed.windowIsNull === true);

T("E4 唤回后窗口重建成功且渲染进程回来了",
  revived && revived.windowCreated === true && revived.rendererCount >= 1,
  JSON.stringify(revived));

T("E5 唤回后恢复原尺寸（不是回到默认 1280×820）",
  revived && revived.bounds && revived.bounds.width === revived.expected.width && revived.bounds.height === revived.expected.height,
  revived ? "期望 " + JSON.stringify(revived.expected) + " 实际 " + JSON.stringify(revived.bounds) : "");

T("E6 唤回后恢复原位置（±2px 容差，避免窗口管理器取整差异）",
  revived && revived.bounds && Math.abs(revived.bounds.x - revived.expected.x) <= 2 && Math.abs(revived.bounds.y - revived.expected.y) <= 2,
  revived ? "期望 " + JSON.stringify(revived.expected) + " 实际 " + JSON.stringify(revived.bounds) : "");

T("E7 轻量模式关闭时走 hide（渲染进程保留）—— 老行为未被破坏",
  rows.some((x) => x.label === "hide-mode-keeps-renderer" && x.rendererCount >= 1),
  JSON.stringify(byLabel("hide-mode-keeps-renderer")));

T("E8 未开托盘常驻时关窗也释放（minimizeToTray=false 语义不变）",
  rows.some((x) => x.label === "no-tray-releases" && x.rendererCount === 0),
  JSON.stringify(byLabel("no-tray-releases")));

T("E9 越界坐标（模拟拔显示器）恢复时被拉回可见区域",
  rows.some((x) => x.label === "offscreen-clamped" && x.visible === true),
  JSON.stringify(byLabel("offscreen-clamped")));

console.log("\n  轻量模式端到端: 通过 " + pass + "  失败 " + fail);
if (r.status !== 0 && fail === 0) console.log("  （Electron 退出码 " + r.status + "，断言全通过）");
process.exit(fail ? 1 : 0);

/** 被 Electron 执行的探针本体 */
function harnessSource(root, outDir) {
  return `
"use strict";
const { app, BrowserWindow, Tray, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const OUT = ${JSON.stringify(path.join(outDir, "result.jsonl"))};
const emit = (o) => { try { fs.appendFileSync(OUT, JSON.stringify(o) + "\\n"); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = ${JSON.stringify(root)};
const windowMode = require(path.join(ROOT, "electron", "backend", "window-mode.cjs"));
const windowState = require(path.join(ROOT, "electron", "backend", "window-state.cjs"));

app.setName("AgentHubWindowE2E");
app.on("window-all-closed", () => {}); // 与 main.cjs 一致：无窗口不退出（托盘常驻语义）

let win = null;
let tray = null;
const rendererCount = () => app.getAppMetrics().filter((p) => p.type === "Tab" || p.type === "renderer").length;

function makeWin(bounds) {
  win = new BrowserWindow({
    width: bounds.width, height: bounds.height,
    x: bounds.x, y: bounds.y,
    minWidth: 920, minHeight: 640,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  return new Promise((res) => {
    win.webContents.once("did-finish-load", res);
    win.loadURL("data:text/html,<h1>e2e</h1>");
  });
}

/** 复刻 main.cjs 的 close 分支语义 */
function wireClose(cfg) {
  win.on("close", (e) => {
    const action = windowMode.decideCloseAction({
      quitting: false,
      minimizeToTray: cfg.minimizeToTray,
      lightweightMode: cfg.lightweightMode,
    });
    if (action === "quit") return;
    e.preventDefault();
    if (windowMode.releasesRenderer(action)) {
      const w = win; win = null;
      setImmediate(() => { try { w.destroy(); } catch {} });
    } else {
      win.hide();
    }
  });
}

(async () => {
  await app.whenReady();
  tray = new Tray(nativeImage.createEmpty());

  // ── 场景 A：轻量模式开 → 关窗应销毁渲染进程 ──
  const dataDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ah-e2e-state-"));
  await makeWin({ x: 120, y: 90, width: 1100, height: 700 });
  wireClose({ minimizeToTray: true, lightweightMode: true });
  await sleep(1200);
  const before = rendererCount();
  win.close();
  await sleep(2500);
  emit({
    label: "after-close",
    rendererCount: rendererCount(),
    rendererBefore: before,
    mainAlive: true,
    trayAlive: !tray.isDestroyed(),
    windowIsNull: win === null,
  });

  // ── 场景 B：唤回 → 位置/尺寸恢复 ──
  const saved = windowState.pickState({ bounds: { x: 120, y: 90, width: 1100, height: 700 }, maximized: false });
  const clamped = windowState.clampBounds(saved.bounds, require("electron").screen.getAllDisplays(), { width: 1280, height: 820 });
  await makeWin({ x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height });
  await sleep(1200);
  const b = win.getBounds();
  emit({
    label: "after-revive",
    windowCreated: true,
    rendererCount: rendererCount(),
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
    expected: { x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height },
  });
  win.destroy(); win = null;
  await sleep(1500);

  // ── 场景 C：轻量关 + 托盘常驻 → hide，渲染进程保留（老行为） ──
  await makeWin({ x: 200, y: 150, width: 1000, height: 660 });
  wireClose({ minimizeToTray: true, lightweightMode: false });
  await sleep(1000);
  win.close();
  await sleep(1800);
  emit({ label: "hide-mode-keeps-renderer", rendererCount: rendererCount(), visible: win ? win.isVisible() : null });
  if (win) { win.destroy(); win = null; }
  await sleep(1500);

  // ── 场景 D：未开托盘常驻 → 关窗即释放（语义不变） ──
  await makeWin({ x: 200, y: 150, width: 1000, height: 660 });
  wireClose({ minimizeToTray: false, lightweightMode: false });
  await sleep(1000);
  win.close();
  await sleep(2200);
  emit({ label: "no-tray-releases", rendererCount: rendererCount() });

  // ── 场景 E：越界坐标（显示器被拔）→ 收敛回可见区域 ──
  const displays = require("electron").screen.getAllDisplays();
  const far = windowState.clampBounds({ x: 99999, y: 99999, width: 1100, height: 700 }, displays, { width: 1280, height: 820 });
  await makeWin({ x: far.x, y: far.y, width: far.width, height: far.height });
  await sleep(1000);
  const fb = win.getBounds();
  const wa = displays[0].workArea;
  const visible = fb.x >= wa.x - 1 && fb.y >= wa.y - 1 && fb.x < wa.x + wa.width && fb.y < wa.y + wa.height;
  emit({ label: "offscreen-clamped", visible, bounds: fb, workArea: wa, adjusted: far.adjusted, reason: far.reason });
  win.destroy(); win = null;
  await sleep(800);

  emit({ label: "DONE" });
  app.exit(0);
})().catch((e) => { emit({ label: "HARNESS_FAILED", detail: String(e && e.stack) }); app.exit(1); });
`;
}
