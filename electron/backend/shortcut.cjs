// 全局快捷键：唤起/隐藏主窗口。
//
// 校验规则（用户要求）：必须是「功能键 + 字符键」组合。
//   · 功能键：Ctrl / Alt / Shift / Super(Meta/Cmd) —— 至少一个
//   · 字符键：字母 / 数字 / 符号 —— 恰好一个（作为主键）
//   · 反例：单按 F5（无功能键）、单按 A（无功能键）、Ctrl+Shift（无字符键）、
//           Ctrl+A+B（两个字符键，无法表达）→ 一律拒绝
// 为什么要有这条规则：全局快捷键会**抢占系统级按键**，纯功能键或单键极易与
// 其它软件/系统冲突，且用户难以察觉冲突来源；要求带功能键能大幅降低误占。
//
// 纯逻辑（normalize / validate）不 require electron，便于自测直接覆盖。
"use strict";

/** 修饰键别名 → Electron accelerator 规范名 */
const MOD_ALIAS = {
  ctrl: "Ctrl", control: "Ctrl",
  alt: "Alt", option: "Alt",
  shift: "Shift",
  super: "Super", meta: "Super", cmd: "Super", command: "Super", win: "Super", windows: "Super",
};

/** 规范修饰键顺序（Electron 不强制顺序，但统一输出便于比较与显示） */
const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Super"];

/** 主键别名 → Electron accelerator 名（只收常见且可跨平台表达的） */
const KEY_ALIAS = {
  // ~ → ` ：**这条是刻意的，且很重要**。
  // "~" 在标准键盘上要 Shift+` 才能打出，而 Electron 把它映射成需要 Shift 的
  // 三键组合（实测：Ctrl+Alt+~ 只有按 Ctrl+Alt+Shift+` 才触发）。
  // 用户看到 "Alt+~" 会以为按两键，实际要按三键 —— 极易误判成"快捷键失效"
  //（本项目就真实踩过）。这里统一归一成不带 Shift 的 ` 键，
  // 既让旧配置里的 "Alt+~" 平滑迁移，也保证「按两键」就能用。
  "~": "`", "`": "`", "-": "-", "=": "=", "[": "[", "]": "]", "\\": "\\",
  ";": ";", "'": "'", ",": ",", ".": ".", "/": "/",
  space: "Space", tab: "Tab", enter: "Enter", return: "Enter",
  backspace: "Backspace", delete: "Delete", insert: "Insert",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  up: "Up", down: "Down", left: "Left", right: "Right",
  plus: "Plus", numpadadd: "numadd", numpadsub: "numsub",
};

/** 单字符键是否可作主键：字母、数字、以及一组安全符号 */
function isCharKey(k) {
  if (/^[A-Za-z]$/.test(k)) return true;
  if (/^[0-9]$/.test(k)) return true;
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(k)) return true; // 功能键 F1-F24 也允许作主键
  return Object.prototype.hasOwnProperty.call(KEY_ALIAS, k.toLowerCase()) || Object.prototype.hasOwnProperty.call(KEY_ALIAS, k);
}

/**
 * 归一化用户输入为 Electron accelerator 串。
 * 接受形式："Alt+~" / "alt + ~" / "CTRL+Shift+K" / "Alt+`"
 * @returns {{ok: true, accelerator: string} | {ok: false, message: string}}
 */
function normalize(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return { ok: false, message: "快捷键不能为空" };

  const parts = raw.split("+").map((s) => s.trim()).filter((s) => s !== "");
  // "Alt++" 这类：分隔符本身是加号键时会被拆出空段，这里把空段还原为 "+" 主键
  if (raw.includes("++")) {
    // 例如 "Ctrl++" → ["Ctrl", "", ""]：补一个 "+" 主键
    const cleaned = raw.split("+").filter((s) => s.trim() !== "");
    parts.length = 0;
    parts.push(...cleaned.slice(0, -1), "+");
  }
  if (!parts.length) return { ok: false, message: "快捷键不能为空" };

  const mods = [];
  const keys = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (MOD_ALIAS[lower]) {
      const canonical = MOD_ALIAS[lower];
      if (!mods.includes(canonical)) mods.push(canonical);
    } else {
      keys.push(p);
    }
  }

  if (mods.length === 0) {
    return { ok: false, message: "必须包含至少一个功能键（Ctrl / Alt / Shift / Super）" };
  }
  if (keys.length === 0) {
    return { ok: false, message: "必须包含一个字符键（如 ~、A、1、F5）" };
  }
  if (keys.length > 1) {
    return { ok: false, message: `只能有一个字符键，当前给了 ${keys.length} 个：${keys.join(" / ")}` };
  }

  // 主键归一：单字母统一大写；符号原样；别名转规范名
  let key = keys[0];
  if (/^[A-Za-z]$/.test(key)) key = key.toUpperCase();
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) key = key.toUpperCase();
  else {
    const alias = KEY_ALIAS[key.toLowerCase()];
    if (alias) key = alias;
    else if (!isCharKey(key)) {
      return { ok: false, message: `不支持的字符键「${keys[0]}」（可用：字母、数字、F1-F24、以及 ~ \` - = [ ] \\ ; ' , . / 等符号）` };
    }
  }

  const ordered = MOD_ORDER.filter((m) => mods.includes(m));
  return { ok: true, accelerator: [...ordered, key].join("+") };
}

/** 校验（给 UI 用）：返回 {ok, accelerator?, message?} */
function validate(input) {
  return normalize(input);
}

/**
 * 注册全局快捷键。electron 相关能力由调用方注入（与 wakeGuard 同款），
 * 这样本模块在纯 Node（自测/NAS 容器）下也能被 require 而不炸。
 *
 * @param {{globalShortcut: object, accelerator: string, onTrigger: Function, log?: Function}} opts
 * @returns {{ok: boolean, accelerator?: string, message?: string}}
 */
function register(opts) {
  const { globalShortcut, accelerator, onTrigger, log } = opts || {};
  if (!globalShortcut || typeof globalShortcut.register !== "function") {
    return { ok: false, message: "当前环境不支持全局快捷键（无窗口环境，如 NAS 容器）" };
  }
  const v = normalize(accelerator);
  if (!v.ok) return v;

  // 先注销同键，避免重复注册报「已占用」
  try { globalShortcut.unregister(v.accelerator); } catch { /* 未注册过 */ }

  let ok = false;
  try {
    ok = globalShortcut.register(v.accelerator, () => { try { onTrigger && onTrigger(); } catch (e) { log && log("shortcut-trigger-failed", String((e && e.message) || e)); } });
  } catch (e) {
    return { ok: false, message: `注册失败：${String((e && e.message) || e)}` };
  }
  // register 返回 false = 该组合已被其它程序占用（Electron 不抛错，只回 false）
  if (!ok) {
    return { ok: false, accelerator: v.accelerator, message: `快捷键 ${v.accelerator} 已被其它程序占用，请换一个` };
  }
  log && log("shortcut-registered", v.accelerator);
  return { ok: true, accelerator: v.accelerator };
}

/** 注销（退出或改键时调用） */
function unregister(globalShortcut, accelerator) {
  if (!globalShortcut || typeof globalShortcut.unregister !== "function") return false;
  try { globalShortcut.unregister(accelerator); return true; } catch { return false; }
}

/** 全量注销（退出时兜底） */
function unregisterAll(globalShortcut) {
  if (!globalShortcut || typeof globalShortcut.unregisterAll !== "function") return false;
  try { globalShortcut.unregisterAll(); return true; } catch { return false; }
}

/** 默认快捷键：Alt+`（两键；不要用 ~ —— 那个需要 Shift，实际是三键，见 KEY_ALIAS 注释） */
const DEFAULT_ACCELERATOR = "Alt+`";

/** 冲突重试间隔：注册失败（被别的程序占用）后多久再试一次。
 *  为什么必须重试：占用是**暂时**的 —— 用户关掉那个程序后键就空出来了。
 *  若不重试，用户就得手动去设置页改一次键才能恢复，而他很可能根本没意识到是冲突。 */
const RETRY_MS = 30 * 1000;

/**
 * 快捷键注册监督器：负责「注册 → 冲突则提示并持续重试 → 解除后自动恢复」。
 *
 * 依赖全部注入（globalShortcut / 定时器 / 通知 / 日志），因此本模块
 * 在纯 Node 下也能自测 —— 真值表见 tools/channel-watch-selftest.cjs。
 *
 * @param {object} deps
 * @param {object} deps.globalShortcut   Electron globalShortcut（可为 null → 环境不支持）
 * @param {Function} [deps.onTrigger]    按下时的回调
 * @param {Function} [deps.notify]       弹系统气泡：(title, body) => void
 * @param {Function} [deps.log]          取证日志：(kind, detail) => void
 * @param {Function} [deps.setTimer]     注入定时器（默认 setTimeout），便于自测
 * @param {Function} [deps.clearTimer]   注入清除（默认 clearTimeout）
 * @param {number}   [deps.retryMs]      重试间隔
 */
function createRegistrar(deps) {
  const d = deps || {};
  const setTimer = d.setTimer || setTimeout;
  const clearTimer = d.clearTimer || clearTimeout;
  const retryMs = Number(d.retryMs) > 0 ? Number(d.retryMs) : RETRY_MS;

  let want = "";          // 期望注册的 accelerator（"" = 用户关掉了快捷键）
  let active = false;     // 当前是否真的注册成功
  let retryTimer = null;
  let notifiedConflict = false;  // 冲突只提示一次，避免每 30 秒弹一次骚扰用户

  const status = () => ({ accelerator: want, active, retrying: !!retryTimer, conflictNotified: notifiedConflict });

  function clearRetry() {
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
  }

  /** 排下一次重试（仅在"有期望值但没注册上"时排） */
  function scheduleRetry() {
    clearRetry();
    if (!want || active) return;
    retryTimer = setTimer(() => { retryTimer = null; attempt(); }, retryMs);
    // 定时器不应阻止进程退出
    if (retryTimer && typeof retryTimer.unref === "function") retryTimer.unref();
  }

  /** 尝试注册一次；失败则提示 + 排重试 */
  function attempt() {
    if (!want) return status();
    const r = register({
      globalShortcut: d.globalShortcut,
      accelerator: want,
      onTrigger: d.onTrigger,
      log: d.log,
    });
    if (r.ok) {
      const recovered = notifiedConflict;   // 之前冲突过 → 这次是恢复
      active = true;
      clearRetry();
      if (recovered) {
        notifiedConflict = false;
        d.log && d.log("shortcut-recovered", r.accelerator);
        // 恢复也提示一次：用户才知道快捷键又能用了
        try { d.notify && d.notify("AgentHub 快捷键已恢复", `${r.accelerator} 已可正常使用`); } catch { /* 通知失败忽略 */ }
      }
      return status();
    }
    active = false;
    // 环境不支持（NAS 容器无窗口）不重试、不提示 —— 那是预期内的降级
    if (/不支持/.test(r.message || "")) {
      d.log && d.log("shortcut-unsupported", r.message || "");
      return status();
    }
    // 冲突：只提示一次，然后静默重试直到解除
    if (!notifiedConflict) {
      notifiedConflict = true;
      d.log && d.log("shortcut-conflict", `${want} ${r.message || ""}`);
      try {
        d.notify && d.notify(
          "AgentHub 快捷键冲突",
          `${want} 已被其它程序占用，快捷键暂不可用；该程序释放后会自动恢复`
        );
      } catch { /* 通知失败不影响重试 */ }
    }
    scheduleRetry();
    return status();
  }

  return {
    /** 设置（或改）快捷键：立即尝试注册，冲突则自动重试 */
    set(accelerator) {
      const next = String(accelerator == null ? "" : accelerator).trim();
      // 换键时先撤掉旧的，避免两个键同时生效
      if (active && want && want !== next) unregister(d.globalShortcut, want);
      active = false;
      notifiedConflict = false;
      clearRetry();
      want = next;
      if (!want) { d.log && d.log("shortcut-disabled", "用户未设置快捷键"); return status(); }
      // 先校验，非法值不进入重试循环（否则会每 30 秒白试一次）
      const v = normalize(want);
      if (!v.ok) {
        d.log && d.log("shortcut-invalid", `${want} → ${v.message}`);
        want = "";
        return { ...status(), error: v.message };
      }
      want = v.accelerator;
      return attempt();
    },
    /** 停止并注销 */
    stop() {
      clearRetry();
      if (want) unregister(d.globalShortcut, want);
      want = "";
      active = false;
      notifiedConflict = false;
      return status();
    },
    /** 手动触发一次尝试（自测/排障用） */
    retryNow() { return attempt(); },
    status,
  };
}

module.exports = {
  DEFAULT_ACCELERATOR,
  RETRY_MS,
  MOD_ORDER,
  normalize,
  validate,
  register,
  unregister,
  unregisterAll,
  createRegistrar,
};
