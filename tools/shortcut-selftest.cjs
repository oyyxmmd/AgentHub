// 快捷键 + 渠道监测 自测。
//
// 覆盖两个纯逻辑模块（都不 require electron，故裸 node 可跑）：
//   electron/backend/shortcut.cjs                 —— 归一化与「功能键+字符键」校验
//
// 这两处的价值恰在于「规则容易写错、错了不容易发现」：
//   · 快捷键校验松了 → 用户能设出单键，抢占系统按键；
//   · 判定松了 → 每轮重复刷屏；紧了 → 真故障被漏报。
// 所以下面把真值表逐格钉死。
//
// 用法：node tools/channel-watch-selftest.cjs
"use strict";
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const shortcut = require(path.join(ROOT, "electron", "backend", "shortcut.cjs"));

let pass = 0, fail = 0;
function T(name, fn) {
  try { fn(); pass++; console.log("  ok    " + name); }
  catch (e) { fail++; console.log("  FAIL  " + name + "\n        " + (e && e.message)); }
}
function eq(a, b, label) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((label || "值") + " 期望 " + y + "，实际 " + x);
}

console.log("\n  快捷键 + 渠道监测 自测");

// ══════════════ 一、快捷键校验 ══════════════
console.log("\n  [1] 快捷键归一化与校验");

T("S1 默认值是 Alt+`（两键，不是 Alt+`）", () => {
  // 为什么必须是 `：~ 在标准键盘要 Shift+` 才能打出，Electron 会把它当成**三键组合**
  // （实测：Ctrl+Alt+` 只有按 Ctrl+Alt+Shift+` 才触发）。用户按两键没反应会误判成"失效"。
  eq(shortcut.DEFAULT_ACCELERATOR, "Alt+`");
  const r = shortcut.validate("Alt+`");
  eq([r.ok, r.accelerator], [true, "Alt+`"]);
});

T("S1b ~ 被归一成 `（老配置平滑迁移，保证按两键即可用）", () => {
  eq(shortcut.validate("Alt+~").accelerator, "Alt+`", "Alt+~ 应归一为 Alt+`");
  eq(shortcut.validate("alt+~").accelerator, "Alt+`");
  eq(shortcut.validate("ALT + ~").accelerator, "Alt+`");
  eq(shortcut.validate("Ctrl+Shift+~").accelerator, "Ctrl+Shift+`");
});

T("S2 大小写/空格/顺序都归一（用户输入随意）", () => {
  eq(shortcut.validate("alt+`").accelerator, "Alt+`");
  eq(shortcut.validate("ALT + `").accelerator, "Alt+`");
  eq(shortcut.validate("shift+ctrl+k").accelerator, "Ctrl+Shift+K", "修饰键按固定顺序输出");
  eq(shortcut.validate("ctrl+shift+k").accelerator, "Ctrl+Shift+K");
  eq(shortcut.validate("k+ctrl").accelerator, "Ctrl+K", "主键写在前面也能识别");
});

T("S3 单字母统一大写、功能键识别", () => {
  eq(shortcut.validate("Ctrl+a").accelerator, "Ctrl+A");
  eq(shortcut.validate("Alt+f5").accelerator, "Alt+F5");
  eq(shortcut.validate("Ctrl+F12").accelerator, "Ctrl+F12");
});

T("S4 必须含功能键：单字符/单功能键都被拒", () => {
  for (const bad of ["A", "~", "F5", "1"]) {
    const r = shortcut.validate(bad);
    if (r.ok) throw new Error(`「${bad}」应被拒（缺功能键），却通过了`);
    if (!/功能键/.test(r.message)) throw new Error(`「${bad}」的拒绝理由应提到功能键，实际：${r.message}`);
  }
});

T("S5 必须含字符键：纯修饰键组合被拒", () => {
  for (const bad of ["Ctrl", "Ctrl+Shift", "Alt+Ctrl", "Super"]) {
    const r = shortcut.validate(bad);
    if (r.ok) throw new Error(`「${bad}」应被拒（缺字符键），却通过了`);
    if (!/字符键/.test(r.message)) throw new Error(`「${bad}」的拒绝理由应提到字符键，实际：${r.message}`);
  }
});

T("S6 只能有一个字符键：三键组合被拒", () => {
  const r = shortcut.validate("Ctrl+A+B");
  if (r.ok) throw new Error("Ctrl+A+B 应被拒（两个字符键）");
  if (!/一个字符键/.test(r.message)) throw new Error("理由应说明只能有一个字符键，实际：" + r.message);
});

T("S7 空值/纯空白被拒", () => {
  for (const bad of ["", "   ", null, undefined]) {
    const r = shortcut.validate(bad);
    if (r.ok) throw new Error(`「${String(bad)}」应被拒`);
  }
});

T("S8 修饰键别名都认（option/cmd/meta/win → Alt/Super）", () => {
  eq(shortcut.validate("option+k").accelerator, "Alt+K");
  eq(shortcut.validate("cmd+k").accelerator, "Super+K");
  eq(shortcut.validate("meta+k").accelerator, "Super+K");
  eq(shortcut.validate("win+k").accelerator, "Super+K");
});

T("S9 常用符号键都可用", () => {
  for (const k of ["~", "`", "-", "=", "[", "]", ";", "'", ",", ".", "/"]) {
    const r = shortcut.validate("Alt+" + k);
    if (!r.ok) throw new Error(`Alt+${k} 应合法，却失败：${r.message}`);
  }
});

T("S10 注册：无 globalShortcut（NAS 容器）时优雅拒绝而非抛错", () => {
  const r = shortcut.register({ globalShortcut: null, accelerator: "Alt+`", onTrigger: () => {} });
  eq(r.ok, false);
  if (!/不支持/.test(r.message)) throw new Error("应说明当前环境不支持，实际：" + r.message);
});

T("S11 注册：被占用时返回明确提示（不静默换键）", () => {
  const fake = { register: () => false, unregister: () => {}, unregisterAll: () => {} };
  const r = shortcut.register({ globalShortcut: fake, accelerator: "Alt+`", onTrigger: () => {} });
  eq(r.ok, false);
  if (!/占用/.test(r.message)) throw new Error("应提示已被占用，实际：" + r.message);
});

T("S12 注册：成功路径会回调 onTrigger，且先注销同键（防重复注册失败）", () => {
  let unregistered = null, triggered = 0;
  const fake = {
    register: (acc, cb) => { cb(); return true; },
    unregister: (acc) => { unregistered = acc; },
    unregisterAll: () => {},
  };
  const r = shortcut.register({ globalShortcut: fake, accelerator: "alt+~", onTrigger: () => { triggered++; } });
  eq([r.ok, r.accelerator, triggered], [true, "Alt+`", 1]);
  eq(unregistered, "Alt+`", "注册前应注销同键");
});

T("S13 注册：非法组合直接拒绝，不会去碰 globalShortcut", () => {
  let called = false;
  const fake = { register: () => { called = true; return true; }, unregister: () => {}, unregisterAll: () => {} };
  const r = shortcut.register({ globalShortcut: fake, accelerator: "F5", onTrigger: () => {} });
  eq(r.ok, false);
  eq(called, false, "非法组合不应调用 register");
});

// ── 冲突监督器（要求：冲突时弹气泡提示，并忽略快捷键直到冲突解除）──

function makeHarness(opts) {
  const o = opts || {};
  let taken = !!o.taken;              // 该键是否被别的程序占用
  const registered = new Set();
  const fake = {
    register: (acc) => { if (taken) return false; registered.add(acc); return true; },
    unregister: (acc) => { registered.delete(acc); },
    unregisterAll: () => registered.clear(),
  };
  const timers = [];
  const notes = [];
  const logs = [];
  const reg = shortcut.createRegistrar({
    globalShortcut: fake,
    onTrigger: o.onTrigger,
    notify: (title, body) => notes.push({ title, body }),
    log: (kind, detail) => logs.push({ kind, detail }),
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cancelled = true; },
    retryMs: 1000,
  });
  return {
    reg, fake, notes, logs, timers, registered,
    setTaken: (v) => { taken = v; },
    fireTimers: () => { const live = timers.filter((t) => !t.cancelled); timers.forEach((t) => { t.cancelled = true; }); live.forEach((t) => t.fn()); return live.length; },
  };
}

T("S14 冲突时：弹一次气泡提示，且不注册、进入重试", () => {
  const h = makeHarness({ taken: true });
  const st = h.reg.set("Alt+`");
  eq(st.active, false, "冲突时不应处于激活态");
  eq(st.retrying, true, "应排上重试");
  eq(h.notes.length, 1, "应弹一次提示");
  if (!/冲突/.test(h.notes[0].title)) throw new Error("提示标题应含「冲突」，实际：" + h.notes[0].title);
  if (!/Alt\+`/.test(h.notes[0].body)) throw new Error("提示正文应指明是哪个键，实际：" + h.notes[0].body);
});

T("S15 冲突持续期间：不重复弹提示（避免每 30 秒骚扰）", () => {
  const h = makeHarness({ taken: true });
  h.reg.set("Alt+`");
  for (let i = 0; i < 5; i++) h.fireTimers();
  eq(h.notes.length, 1, "始终只应有一条冲突提示");
});

T("S16 冲突解除后：自动注册成功并提示恢复", () => {
  const h = makeHarness({ taken: true });
  h.reg.set("Alt+`");
  eq(h.reg.status().active, false);
  h.setTaken(false);
  h.fireTimers();
  const st = h.reg.status();
  eq(st.active, true, "应已注册成功");
  eq(st.retrying, false, "不应再重试");
  eq(h.notes.length, 2, "应追加一条「已恢复」提示");
  if (!/恢复/.test(h.notes[1].title)) throw new Error("第二条提示应为恢复通知，实际：" + h.notes[1].title);
  eq(h.registered.has("Alt+`"), true, "该键应真的注册上了");
});

T("S17 冲突期间按下键不会触发回调（功能被忽略）", () => {
  let n = 0;
  const h = makeHarness({ taken: true, onTrigger: () => { n++; } });
  h.reg.set("Alt+`");
  eq(h.registered.size, 0, "冲突期间不应注册任何键");
  eq(n, 0);
});

T("S18 环境不支持（NAS 容器）时不提示、不重试", () => {
  const notes = [];
  const reg = shortcut.createRegistrar({
    globalShortcut: null,
    notify: (t) => notes.push(t),
    log: () => {},
    setTimer: () => { throw new Error("不应排重试"); },
    clearTimer: () => {},
  });
  const st = reg.set("Alt+`");
  eq(st.active, false);
  eq(st.retrying, false, "不支持的环境不应进入重试循环");
  eq(notes.length, 0, "环境不支持属预期降级，不该弹冲突提示");
});

T("S19 非法快捷键不进重试循环（否则每 30 秒白试一次）", () => {
  const h = makeHarness({ taken: false });
  const st = h.reg.set("F5");
  eq(st.active, false);
  eq(st.retrying, false, "非法值不该排重试");
  if (!st.error) throw new Error("应回传校验错误信息给界面");
  eq(h.timers.filter((t) => !t.cancelled).length, 0);
});

T("S20 改键：旧键被注销、新键生效（不会两个键同时可用）", () => {
  const h = makeHarness({ taken: false });
  h.reg.set("Alt+`");
  eq(h.registered.has("Alt+`"), true);
  h.reg.set("Ctrl+Shift+K");
  eq(h.registered.has("Alt+`"), false, "旧键应已注销");
  eq(h.registered.has("Ctrl+Shift+K"), true, "新键应已注册");
  eq(h.reg.status().accelerator, "Ctrl+Shift+K");
});

T("S21 置空 = 关闭快捷键功能（注销且不重试）", () => {
  const h = makeHarness({ taken: false });
  h.reg.set("Alt+`");
  eq(h.registered.size, 1);
  const st = h.reg.set("");
  eq(st.accelerator, "", "应为空");
  eq(st.active, false);
  eq(h.registered.size, 0, "应已注销");
  eq(st.retrying, false);
});

T("S22 stop() 注销一切（退出应用时调用）", () => {
  const h = makeHarness({ taken: false });
  h.reg.set("Alt+`");
  h.reg.stop();
  eq(h.registered.size, 0);
  eq(h.reg.status().active, false);
  eq(h.reg.status().accelerator, "");
});

// ─────────────── 三、main.cjs 接线守卫（源码级）───────────────
// 快捷键「收起」必须按「轻量模式」开关分派：
//   · 恒为 hide    → 用户开了轻量模式却省不到内存；
//   · 恒为 destroy → 用户没开轻量模式却每次唤回都重建整页 → 闪黑 ✗。
// 这里只做源码级接线断言（纯逻辑层无法覆盖 main.cjs 的分派）。
console.log("\n  [3] main.cjs 接线守卫");
const fs = require("node:fs");
const mainSrc = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");

T("S23 快捷键收起按「轻量模式」开关分派（不得恒 hide / 恒 destroy）", () => {
  if (!/function collapseMainWindow\(/.test(mainSrc)) throw new Error("缺少 collapseMainWindow（收起动作的统一入口）✗");
  const body = mainSrc.slice(mainSrc.indexOf("function collapseMainWindow("));
  const fn = body.slice(0, body.indexOf("\n}") > 0 ? body.indexOf("\n}") : 900);
  if (!/lightweightMode/.test(fn)) throw new Error("收起动作没有读 lightweightMode 开关 ✗");
  if (!/releaseWindowNow\(/.test(fn)) throw new Error("缺少「轻量模式开启 → 释放渲染进程」分支 ✗");
  if (!/mainWindow\.hide\(\)/.test(fn)) throw new Error("缺少「轻量模式关闭 → 仅隐藏」分支 ✗");
});

T("S24 onShortcutToggle 走 collapseMainWindow（不得直接 hide，否则与轻量模式脱钩）", () => {
  const i = mainSrc.indexOf("function onShortcutToggle(");
  if (i < 0) throw new Error("找不到 onShortcutToggle");
  const fn = mainSrc.slice(i, i + 700);
  if (!/collapseMainWindow\(/.test(fn)) throw new Error("快捷键收起没有走 collapseMainWindow ✗");
});

T("S25 轻量分支直调 releaseWindowNow（#101 已合并，typeof 探测已移除）", () => {
  // 合并前用 typeof 探测保跨 PR 兼容；合并后 releaseWindowNow 恒存在（函数声明提升），
  // 探测失去意义——按 KISS 直调，且不得残留过时的 typeof 写法。
  const body = mainSrc.slice(mainSrc.indexOf("function collapseMainWindow("));
  const fn = body.slice(0, body.indexOf("\n}") > 0 ? body.indexOf("\n}") : 900);
  if (/typeof releaseWindowNow/.test(fn)) {
    throw new Error("typeof 探测已无意义（#101 已合并），应直调 ✗");
  }
  if (!/releaseWindowNow\(reason\)/.test(fn)) {
    throw new Error("轻量分支应直调 releaseWindowNow(reason) ✗");
  }
});

console.log("\n  快捷键自测: 通过 " + pass + "  失败 " + fail);
process.exit(fail ? 1 : 0);
