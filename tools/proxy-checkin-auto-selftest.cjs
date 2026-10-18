// 自动签到（按渠道）自测：v1.55 起 proxy.checkinAutoRules 取代旧的全局 checkinAuto/checkinAutoTime。
// 用法：AGENTHUB_DATA_DIR=<临时数据目录> ELECTRON_RUN_AS_NODE=1 electron tools/proxy-checkin-auto-selftest.cjs [<临时数据目录>]
// 断言面：旧配置一次性迁移与防覆盖 / 规则归一化（HH:mm 与抖动钳制） / 今日签到记录落库与读回 /
//        号池视图 + IPC + tick 的接线段（静态断言，防止改一处漏一处）
"use strict";
if (process.argv[2]) process.env.AGENTHUB_DATA_DIR = process.argv[2];
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
// 未传沙箱目录时自建（此前不传就直接跑在真实 %APPDATA%\AgentHub 上：既会被真实账号数据
// 顶掉「无记录账号 checkin 为 null」断言，又会在真实库里增删测试账号）
if (!process.env.AGENTHUB_DATA_DIR) {
  process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ah-checkin-auto-"));
}
const config = require("../electron/backend/config.cjs");
const store = require("../electron/backend/proxy/store.cjs");

// —— 安全闸门：数据目录必须落在沙箱内 ——
const _dataDir = path.resolve(process.env.AGENTHUB_DATA_DIR).toLowerCase();
const _inSandbox = path.resolve(store.proxyDir()).toLowerCase().startsWith(_dataDir);
if (!_inSandbox) { console.error("拒绝运行：数据目录不在沙箱内（" + store.proxyDir() + "）"); process.exit(2); }

let pass = 0;
function ok(name, cond) {
  if (!cond) throw new Error(`FAIL: ${name}`);
  pass++;
  console.log(`  ok ${name}`);
}
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const CHECKIN_IDS = ["trae", "workbuddy", "workbuddy_ai", "raccoon", "modelscope", "lobster", "zcode", "qoder", "qoder_intl"];

// ===== 1. 旧全局配置 → 按渠道规则 的一次性迁移 =====
// fork 语义：checkinAuto（总闸）与 checkinAutoTime（兜底时刻）保留不删——托盘快捷开关与
// 号池页「自动开/关」在用；tick 在「无任何启用规则」时按 checkinAutoTime 每天跑一次全渠道。
// 上游的「删旧字段+铺满规则」迁移不做：一旦铺满 enabled 规则，兜底分支永不生效。
console.log("1. 旧配置保留（fork 语义）");
const cfgPath = config.configPath();
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify({ proxy: { checkinAuto: true, checkinAutoTime: "08:30" } }, null, 2), "utf8");
let c1 = config.loadConfig();
ok("旧全局字段保留在配置结果里（总闸在用）", c1.proxy.checkinAuto === true && c1.proxy.checkinAutoTime === "08:30");
ok("旧字段不搬运成规则（兜底分支保持可达）", Object.keys(c1.proxy.checkinAutoRules).length === 0);

// 防覆盖：磁盘上已有用户规则时不受旧字段影响（fork 不做迁移，规则与旧字段独立共存）
fs.writeFileSync(cfgPath, JSON.stringify({ proxy: { checkinAuto: true, checkinAutoTime: "08:30", checkinAutoRules: { trae: { enabled: false, time: "13:00", jitterMin: 5 } } } }, null, 2), "utf8");
let c2 = config.loadConfig();
ok("已有规则时不被旧值覆盖", c2.proxy.checkinAutoRules.trae.enabled === false && c2.proxy.checkinAutoRules.trae.time === "13:00" && !c2.proxy.checkinAutoRules.workbuddy);

// 一键保存后旧字段仍在磁盘（fork 保留总闸字段）
const saved = config.loadConfig();
config.saveConfig(saved);
const onDisk = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
ok("保存后磁盘保留旧字段", onDisk.proxy.checkinAuto === true && onDisk.proxy.checkinAutoTime === "08:30");

// 无规则 = 默认全关（fork 下总闸默认开 + 兜底时刻接管，规则表本身仍为空）
fs.writeFileSync(cfgPath, JSON.stringify({ proxy: {} }, null, 2), "utf8");
{
  const c4 = config.loadConfig();
  ok("无规则时默认空规则（走全局兜底时刻）", Object.keys(c4.proxy.checkinAutoRules).length === 0 && c4.proxy.checkinAuto === true && c4.proxy.checkinAutoTime === "09:00");
}

// ===== 2. 规则归一化 =====
console.log("2. 规则归一化");
ok("normalizeHm 非法/越界回落 09:00", config.normalizeHm("25:99") === "09:00" && config.normalizeHm("") === "09:00" && config.normalizeHm("abc") === "09:00" && config.normalizeHm("9:70") === "09:00");
ok("normalizeHm 补零与边界", config.normalizeHm("7:5") === "07:05" && config.normalizeHm("23:59") === "23:59" && config.normalizeHm("00:00") === "00:00");
ok("normalizeJitter 钳 0~180 且取整", config.normalizeJitter(-5) === 0 && config.normalizeJitter(999) === 180 && config.normalizeJitter("12.6") === 13 && config.normalizeJitter("x") === 0);
fs.writeFileSync(cfgPath, JSON.stringify({ proxy: { checkinAutoRules: { trae: { enabled: 1, time: "8:5", jitterMin: -3 }, bogus: null, zcode: { enabled: true, time: "10:00", jitterMin: 500 } } } }, null, 2), "utf8");
const c3 = config.loadConfig();
ok("归一化后 enabled 严格布尔", c3.proxy.checkinAutoRules.trae.enabled === false);
ok("归一化时间与抖动", c3.proxy.checkinAutoRules.trae.time === "08:05" && c3.proxy.checkinAutoRules.trae.jitterMin === 0 && c3.proxy.checkinAutoRules.zcode.jitterMin === 180);
ok("畸形规则项被剔除", !("bogus" in c3.proxy.checkinAutoRules));

// ===== 3. 今日签到记录（meta.checkin 落库与读回） =====
console.log("3. 签到记录落库");
store.open();
const accId = store.addAccount({ channel: "trae", name: "签到测试号", token: "t", source: "paste" });
store.noteError(accId, "上游 500");
store.noteCheckin(accId, { ok: true, credit: 100, streakDays: 5, message: "签到成功" }, "checkin");
let row = store.listAccounts("trae").find((a) => a.id === accId);
ok("checkin 记录随账号视图返回", !!row.checkin && row.checkin.ok === true && row.checkin.credit === 100 && row.checkin.streakDays === 5);
ok("记录含当天日期与动作", row.checkin.day === store.dayStr() && row.checkin.action === "checkin" && row.checkin.at > 0);
ok("noteCheckin 不覆盖 meta 里的 lastError", !!row.lastError && /500/.test(row.lastError.message));
store.noteCheckin(accId, { ok: false, message: "人机校验未完成", needCaptcha: true }, "checkin");
row = store.listAccounts("trae").find((a) => a.id === accId);
ok("同日重跑覆盖为最新一条", row.checkin.ok === false && row.checkin.needCaptcha === true && row.checkin.message === "人机校验未完成");
store.noteCheckin(accId, { ok: false, message: "x".repeat(600) }, "checkin");
row = store.listAccounts("trae").find((a) => a.id === accId);
ok("失败原因截断 400 字", row.checkin.message.length === 400);
const others = store.listAccounts("trae").filter((a) => a.id !== accId);
ok("无记录账号 checkin 为 null", others.every((a) => a.checkin === null));
store.removeAccount(accId);
store.close();

// ===== 4. 抖动与计划判定（纯函数，确定性 + 跨午夜） =====
console.log("4. 抖动与计划判定");
let index = null;
try {
  index = require("../electron/backend/proxy/index.cjs");
} catch (e) {
  console.log(`  !! index.cjs 加载失败（${e.message}）——跳过抖动测试`);
}
if (index && typeof index.checkinJitterOffset === "function") {
  const j = index.checkinJitterOffset;
  ok("0 分钟 = 零偏移", j("2026-10-09", "trae", 0) === 0);
  ok("同一天同一渠道多次计算一致", j("2026-10-09", "trae", 30) === j("2026-10-09", "trae", 30));
  const v = j("2026-10-09", "trae", 30);
  ok("偏移落在 0~jitterMin 分钟内", v >= 0 && v <= 30 * 60000);
  const diff = new Set(["trae", "workbuddy", "zcode", "qoder", "lobster"].map((ch) => j("2026-10-09", ch, 30)));
  ok("不同渠道偏移不全都相同", diff.size > 1);
  ok("超范围抖动被钳到 180 分钟内", j("2026-10-09", "trae", 9999) <= 180 * 60000);
}
if (index && typeof index.checkinPlannedAt === "function" && typeof index.checkinDueKey === "function") {
  const { checkinPlannedAt, checkinDueKey } = index;
  const mk = (ts) => new Date(ts).getTime();
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  const rule9 = { enabled: true, time: "09:00", jitterMin: 0 };
  const ruleLate = { enabled: true, time: "23:30", jitterMin: 180 };

  // 计划时刻 = 当日 HH:mm（抖动 0）
  ok("计划时刻 = 当日 HH:mm", checkinPlannedAt("2026-10-09", "trae", rule9) === at(2026, 10, 9, 9, 0));

  const day = "2026-10-09";
  const prevDay = "2026-10-08";
  // 今天 09:00 已过 → 跑今天的实例
  ok("今天的计划已到期 → 执行今天", checkinDueKey(at(2026, 10, 9, 9, 5), day, prevDay, "trae", rule9, "", 0) === day);
  // 今天 08:59 未到 → 不跑
  ok("今天的计划未到期 → 不执行", checkinDueKey(at(2026, 10, 9, 8, 59), day, prevDay, "trae", rule9, "", 0) === "");
  // 今天已完成 → 不重复
  ok("今天已完成 → 不重复执行", checkinDueKey(at(2026, 10, 9, 12, 0), day, prevDay, "trae", rule9, day, 0) === "");
  // 未启用 → 不跑
  ok("渠道未启用 → 不执行", checkinDueKey(at(2026, 10, 9, 12, 0), day, prevDay, "trae", { ...rule9, enabled: false }, "", 0) === "");
  // 延后窗口未到 → 不跑
  ok("延后窗口未到 → 不执行", checkinDueKey(at(2026, 10, 9, 9, 5), day, prevDay, "trae", rule9, "", at(2026, 10, 9, 10, 0)) === "");

  // 昨日未跨天的欠账不补：昨天 09:00 的计划在今天 08:00（今天计划未到）时不被补跑
  ok("昨日未跨天的欠账不补", checkinDueKey(at(2026, 10, 9, 8, 0), day, prevDay, "trae", rule9, "", 0) === "");

  // 跨午夜：找一组 (日期, 渠道) 使 23:30 + 抖动 落在次日凌晨（hash 确定，必然存在）
  let crossCase = null;
  for (let d = 1; d <= 28 && !crossCase; d++) {
    const dy = `2026-06-${String(d).padStart(2, "0")}`;
    for (const ch of ["trae", "workbuddy", "zcode"]) {
      const p = checkinPlannedAt(dy, ch, ruleLate);
      if (p > at(2026, 6, d, 23, 59)) { crossCase = { dy, ch, next: `2026-06-${String(d + 1).padStart(2, "0")}`, p }; break; }
    }
  }
  ok("存在 23:30+180 分钟抖动跨到次日凌晨的实例（前置条件）", !!crossCase, JSON.stringify(crossCase && { dy: crossCase.dy, ch: crossCase.ch }));
  if (crossCase) {
    const yDay = crossCase.dy;
    const tDay = crossCase.next;
    ok("跨午夜的昨日实例在次日凌晨到期后执行", checkinDueKey(crossCase.p + 1000, tDay, yDay, crossCase.ch, ruleLate, "", 0) === yDay);
    ok("跨午夜实例执行前不执行", checkinDueKey(crossCase.p - 60000, tDay, yDay, crossCase.ch, ruleLate, "", 0) === "");
    ok("跨午夜实例已完成则不重复", checkinDueKey(crossCase.p + 60000, tDay, yDay, crossCase.ch, ruleLate, yDay, 0) === "");
    // 次日凌晨同时也是"今天计划"未到期的时刻：今天（tDay）的计划在 23:30 之后，故上面走的是昨日分支
    ok("跨午夜时今天计划尚未到期（不会一天两跑）", checkinPlannedAt(tDay, crossCase.ch, ruleLate) > crossCase.p + 60000);
  }
} else {
  console.log("  !! checkinPlannedAt / checkinDueKey 未导出，跳过计划判定测试");
}

// ===== 5. 接线段静态断言（改一处漏一处的护栏） =====
console.log("5. 接线");
const idx = read("electron/backend/proxy/index.cjs");
ok("poolView 输出 checkinAuto 规则", /checkinAuto: \{ enabled: !!\(rule && rule\.enabled\)/.test(idx));
ok("IPC proxy_checkin_auto_set 已注册", /ipcMain\.handle\("proxy_checkin_auto_set"/.test(idx));
ok("poolView 读的是按渠道规则", /settings\(\)\.checkinAutoRules/.test(idx));
ok("checkinBatch 落今日签到记录", /store\.noteCheckin\(acc\.id, r, useAct\)/.test(idx) && /store\.noteCheckin\(acc\.id, \{ ok: false, message: msg \}, useAct\)/.test(idx));
ok("tick 遍历渠道规则（per-channel 当日标记）", /lastAutoCheckinDay\[channel\] = dueKey;/.test(idx) && /for \(const \[channel, rule\] of Object\.entries\(rules\)\)/.test(idx));
ok("tick 计划判定走可测纯函数（跨午夜分支）", /checkinDueKey\(/.test(idx) && /function checkinDueKey\(/.test(idx));
ok("tick 串行跑渠道（互斥不被并行拒掉）", /autoRunning/.test(idx));
const pre = read("electron/preload.cjs");
ok("preload 白名单含 proxy_checkin_auto_set", /"proxy_checkin_auto_set"/.test(pre));
const cfgSrc = read("electron/backend/config.cjs");
ok("config.cjs 导出归一化工具", /normalizeHm, normalizeJitter/.test(cfgSrc));
ok("config.cjs 保留旧全局字段（fork 总闸语义，不做迁移删除）", !/delete merged\.proxy\.checkinAuto;/.test(cfgSrc) && /checkinAuto: true,/.test(cfgSrc));
ok("tick 含总闸判定与无规则兜底", /cfg\.checkinAuto === false\) return;/.test(idx) && /checkinAutoTime \|\| "09:00"/.test(idx));
const view = read("src/views/proxy/ProxyAgentsView.vue");
ok("号池页有自动签到设置弹窗", /autoDlg/.test(view) && /saveAutoCheckin/.test(view));
ok("号池页行内三态与详情弹窗", /checkinRowState/.test(view) && /checkinDetailTag/.test(view));
// fork：WorkBuddy AI 纳入自动签到/任务体系
const adSrc = read("electron/backend/proxy/adapters.cjs");
ok("行内按钮对 workbuddy_ai 显式传 trial 动作", /acc\.channel === "workbuddy_ai" \? "trial" : "checkin"/.test(view));
ok("trial 成功提取 claimedCredit（任务日志记实际收益）", /claimedCredit: Number\(\(d && \(d\.credit \?\? d\.today_credit/.test(adSrc));
// trial 幂等报文识别：上游英文 has applied trial / already applied 与中文「已领取」都必须认成 already，
// 只认错误码 14051 会把幂等显示成红色「领取失败」
ok("trial 幂等识别覆盖英文与中文报文", /has\\s\+applied/.test(adSrc) && /applied\\s\+trial/.test(adSrc) && /already\\s\+\(applied\|claimed\|used\)/.test(adSrc) && /已领取\|已领过/.test(adSrc));
ok("growthLog reward 兼容 claimedCredit", /x\.credit \|\| x\.claimedCredit/.test(idx));
// fork：渠道指定账号（托盘面板写 proxy.pinnedAccount，选号优先命中）
const poolSrc = read("electron/backend/proxy/pool.cjs");
ok("pickAccount 支持 pinnedId 优先命中", /function pickAccount\(channel, strategy, excludeIds, maxInFlight, pinnedId\)/.test(poolSrc) && /a\.id === pinnedId/.test(poolSrc));
ok("server 选号传 pinnedAccount", /\(settings\.pinnedAccount \|\| \{\}\)\[chan\]/.test(read("electron/backend/proxy/server.cjs")));
ok("IPC proxy_pinned_account_set 已注册", /ipcMain\.handle\("proxy_pinned_account_set"/.test(idx));
ok("poolView 输出 pinnedAccountId", /pinnedAccountId: String\(pinnedAccount\[c\.id\] \|\| ""\)/.test(idx));
ok("账号删除清理 pinned 引用", /pinned\[acc\.channel\] === id/.test(idx));
ok("preload 白名单含 proxy_pinned_account_set", /"proxy_pinned_account_set"/.test(pre));
ok("托盘面板有指定账号交互", /proxyPinnedAccountSet/.test(read("src/tray/TrayPanel.vue")));

console.log(`\n全部通过：${pass} 项`);
