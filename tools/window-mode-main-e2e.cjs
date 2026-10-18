// 真实 main.cjs 的轻量模式验证：
//   起静态服务器喂 dist → 用 VITE_DEV_SERVER_URL 指向它启动真实主进程
//   → 从外部观察进程表（渲染进程是否消失/回来）→ 读 window-state.json 验证几何恢复。
//
// 与 window-mode-e2e.cjs 的区别：那个用复刻的接线（证明逻辑对），
// 这个跑**真实 main.cjs**（证明真的接对了）。
//
// 用法：node tools/window-mode-main-e2e.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const PORT = 1421;
const SBX = path.join(os.tmpdir(), "ah-main-e2e");
const DATA = path.join(SBX, "data");

let pass = 0, fail = 0;
const T = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n        " + detail : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 该实例的进程清单（按 userData 隔离目录识别，绝不误伤用户正在跑的实例） */
function procs() {
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*ah-main-e2e*' } | ForEach-Object { $t='MAIN'; if($_.CommandLine -match '--type=([a-z\\-]+)'){$t=$Matches[1]}; "$($_.ProcessId)|$t" }`,
  ], { encoding: "utf8" });
  return String(r.stdout || "").trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, type] = l.split("|");
    return { pid: Number(pid), type };
  });
}
const renderers = (list) => list.filter((p) => p.type === "renderer").length;

(async () => {
  fs.rmSync(SBX, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  // 预置：轻量模式开 + 托盘常驻开 + 一个明显非默认的窗口几何
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify({
    theme: "dark",
    schedule: { minimizeToTray: true, lightweightMode: true, autoStart: false, hourly: false, daily: false, dailyTime: "09:00", notifyOnSuccess: false },
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(DATA, "window-state.json"), JSON.stringify({
    bounds: { x: 140, y: 110, width: 1180, height: 760 }, maximized: false,
  }, null, 2), "utf8");

  const srv = spawn(process.execPath, [path.join(__dirname, "tmp-static-dist-server.cjs"), String(PORT)], { cwd: ROOT, stdio: "ignore" });
  await sleep(1500);

  // 隔离要点：**不能**用 AGENTHUB_ALLOW_MULTI —— 那条路径会把 userData 硬编码成
  // %APPDATA%\AgentHub-dev，于是 --user-data-dir 被忽略、测试会去碰开发目录，
  // 而且子进程命令行里不再出现沙箱路径（按路径过滤进程就会漏掉渲染进程）。
  // 正确做法：只用 --user-data-dir=<沙箱>，单实例锁是按 userData 作用域隔离的，
  // 因此既不与用户正在跑的实例抢锁，子进程命令行也全都带得上沙箱路径。
  const env = { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${PORT}` };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AGENTHUB_ALLOW_MULTI;
  const el = spawn(ELECTRON, [".", "--user-data-dir=" + DATA], { cwd: ROOT, env, stdio: "ignore" });

  try {
    // 等窗口起来（真实 main.cjs 会加载 dist）
    let list = [];
    for (let i = 0; i < 40; i++) { await sleep(1000); list = procs(); if (renderers(list) >= 1) break; }
    T("M1 真实 main.cjs 起了窗口（渲染进程存在）", renderers(list) >= 1, JSON.stringify(list));

    // 触发关窗：用 PowerShell 给主窗口发 WM_CLOSE（等价于用户点关闭按钮）
    const main = list.find((p) => p.type === "MAIN");
    spawnSync("powershell", ["-NoProfile", "-Command", `
      Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb,IntPtr l); public delegate bool EnumProc(IntPtr h,IntPtr l);';
      $found=@(); $cb=[W.U+EnumProc]{ param($h,$l) $p=0; [void][W.U]::GetWindowThreadProcessId($h,[ref]$p); if($p -eq ${main.pid}){ $script:found += $h }; return $true };
      [void][W.U]::EnumWindows($cb,[IntPtr]::Zero);
      foreach($h in $found){ [void][W.U]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) }
    `], { encoding: "utf8" });

    await sleep(6000);
    const after = procs();
    T("M2 关窗后渲染进程消失（轻量模式真的释放了内存）",
      renderers(after) === 0, JSON.stringify(after));
    T("M3 主进程仍存活（托盘常驻、后台服务不受影响）",
      after.some((p) => p.type === "MAIN"), JSON.stringify(after));

    // 关键断言：关窗时会把**实时窗口几何**写回盘。它等于预置值 ⇒ 证明真实 main.cjs
    // 确实按恢复出的位置建了窗（而不是回落到默认 1280×820）。
    let st = {};
    try { st = JSON.parse(fs.readFileSync(path.join(DATA, "window-state.json"), "utf8")); } catch { /* 无 */ }
    const b = st.bounds || {};
    T("M4 关窗时写回的是恢复出的用户几何（非默认值）—— 证明恢复链路真的生效",
      b.width === 1180 && b.height === 760 && b.x === 140 && b.y === 110,
      "实际 " + JSON.stringify(b));

    // 日志取证：应记录 lightweight-enter
    let log = "";
    try { log = fs.readFileSync(path.join(DATA, "logs", "crash.log"), "utf8"); } catch { /* 无 */ }
    T("M5 crash.log 留有 lightweight-enter 取证（可事后排查）",
      /lightweight-enter/.test(log), log.split(/\r?\n/).slice(-6).join("\n"));

    // 唤回：再启动一个实例 → second-instance → showWindow → 重建窗口
    const el2 = spawn(ELECTRON, [".", "--user-data-dir=" + DATA], { cwd: ROOT, env, stdio: "ignore" });
    let revived = [];
    for (let i = 0; i < 30; i++) { await sleep(1000); revived = procs(); if (renderers(revived) >= 1) break; }
    T("M6 第二次启动唤回界面（渲染进程回来）", renderers(revived) >= 1, JSON.stringify(revived));
    try { el2.kill(); } catch { /* 已退出 */ }

    await sleep(2000);
    let st2 = {};
    try { st2 = JSON.parse(fs.readFileSync(path.join(DATA, "window-state.json"), "utf8")); } catch { /* 无 */ }
    const b2 = st2.bounds || {};
    T("M7 唤回后几何仍是用户原位置（未被重置为默认）",
      b2.width === 1180 && b2.height === 760,
      "实际 " + JSON.stringify(b2));
  } finally {
    try { el.kill(); } catch { /* ignore */ }
    spawnSync("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*ah-main-e2e*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
    try { srv.kill(); } catch { /* ignore */ }
  }

  console.log("\n  真实 main.cjs 端到端: 通过 " + pass + "  失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
