// issue #90 回归守卫：设置页「整份保存」不得冲掉 out-of-band 的 proxy 字段
//
// 现象（GitHub issue #90 评论 / javalover123 2026-10-10）：
//   「似乎有个 上游启闭，关掉 有道，点击 完成，就可以了。
//     但是，如果再次点击 保存并重启服务，再次点击 上游启闭，有道 又打开了」
// 由独立 IPC 直接写盘、不经设置页表单的字段（共 4 个）：
//   · channelEnabled   ← proxy_channel_toggle（上游启闭）
//   · checkinAutoRules ← proxy_checkin_auto_set（按渠道自动签到）
//   · enableAnthropic / enableResponses ← 新增协议面的紧急止血开关（界面无入口，手工改 config.json）
// restoreOnLaunch 刻意不在名单里：设置页「记住网关开关」开关本身就经整份保存写盘，
// 磁盘优先会把它架空；渲染层快照由总览页每次启停同步（ProxyHomeView），不会过期。
//
// 本守卫锁住两条**相反**的契约（缺一不可）：
//   A. 设置页整份提交（saveConfigFromUI）→ 上述两个字段**必须**以磁盘为准（旧快照不得冲掉）
//   B. 那两个字段各自的写入方（saveConfig）→ **必须**能正常写盘
//      （若把「磁盘优先」错写进 saveConfig，写入方的改动会被自己刚读到的旧值覆盖，功能当场失效）
//
// 全部在沙箱数据目录内运行，带安全闸门，绝不触碰真实配置。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-issue90-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}

const config = require("../electron/backend/config.cjs");

// —— 安全闸门 ——
const cfgPath = config.configPath();
const inSandbox = path.resolve(cfgPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase());
console.log("=== 安全闸门 ===");
console.log("  沙箱 = " + SANDBOX);
console.log("  配置路径 = " + cfgPath);
ok("配置路径在沙箱内（绝不写真实配置）", inSandbox);
if (!inSandbox) { console.error("拒绝运行：配置路径不在沙箱内"); process.exit(2); }

const FIELDS = config.OUT_OF_BAND_PROXY_FIELDS;
console.log("");
console.log("=== 前置：名单与接口存在 ===");
ok("导出了 OUT_OF_BAND_PROXY_FIELDS", Array.isArray(FIELDS) && FIELDS.length === 4, JSON.stringify(FIELDS));
ok("名单含 channelEnabled / checkinAutoRules / enableAnthropic / enableResponses",
  ["channelEnabled", "checkinAutoRules", "enableAnthropic", "enableResponses"].every((f) => FIELDS.includes(f)) && !FIELDS.includes("restoreOnLaunch"),
  JSON.stringify(FIELDS));
ok("导出了 saveConfigFromUI", typeof config.saveConfigFromUI === "function");

// 磁盘上写入「用户通过各自 IPC 设置好的」状态
function writeDiskState() {
  const cfg = config.loadConfig();
  cfg.proxy.channelEnabled = { lobster: false };            // 有道 已关闭
  cfg.proxy.checkinAutoRules = { lobster: { enabled: true, time: "09:00", jitterMin: 30 } };
  cfg.proxy.restoreOnLaunch = true;
  cfg.proxy.enableAnthropic = false;                        // 手工改 config.json 关掉的新协议面
  cfg.proxy.enableResponses = false;
  config.saveConfig(cfg);                                   // = 那几个 IPC 所用的路径
}
writeDiskState();
const disk0 = config.loadConfig().proxy;
console.log("");
console.log("=== 磁盘初始状态（模拟用户已用各弹窗设好）===");
console.log("  channelEnabled   = " + JSON.stringify(disk0.channelEnabled));
console.log("  checkinAutoRules = " + JSON.stringify(disk0.checkinAutoRules));
console.log("  restoreOnLaunch  = " + JSON.stringify(disk0.restoreOnLaunch));
console.log("  enableAnthropic  = " + JSON.stringify(disk0.enableAnthropic));
console.log("  enableResponses  = " + JSON.stringify(disk0.enableResponses));
ok("磁盘已记录 channelEnabled.lobster=false", disk0.channelEnabled && disk0.channelEnabled.lobster === false);
ok("磁盘已记录 checkinAutoRules.lobster", !!(disk0.checkinAutoRules && disk0.checkinAutoRules.lobster));
ok("磁盘已记录 restoreOnLaunch=true", disk0.restoreOnLaunch === true);
ok("磁盘已记录 enableAnthropic=false / enableResponses=false", disk0.enableAnthropic === false && disk0.enableResponses === false);

// —— 契约 A：设置页整份提交（旧快照）不得冲掉 ——
console.log("");
console.log("=== 契约 A：设置页整份保存（模拟渲染层旧快照）===");
const stale = config.defaultConfig();                       // 旧快照：这三个字段是默认空值
stale.proxy.port = 9600;                                    // 但用户确实改了端口（必须生效）
console.log("  旧快照提交时 channelEnabled = " + JSON.stringify(stale.proxy.channelEnabled));
config.saveConfigFromUI(stale);
const after = config.loadConfig().proxy;
console.log("  保存后磁盘 channelEnabled   = " + JSON.stringify(after.channelEnabled));
console.log("  保存后磁盘 checkinAutoRules = " + JSON.stringify(after.checkinAutoRules));
console.log("  保存后磁盘 restoreOnLaunch  = " + JSON.stringify(after.restoreOnLaunch));
ok("A1 channelEnabled 未被冲掉（有道 仍是关闭）", after.channelEnabled && after.channelEnabled.lobster === false, JSON.stringify(after.channelEnabled));
ok("A2 checkinAutoRules 未被冲掉", !!(after.checkinAutoRules && after.checkinAutoRules.lobster), JSON.stringify(after.checkinAutoRules));
// restoreOnLaunch 是设置页自有字段（「记住网关开关」开关经整份保存写盘）：提交值必须原样生效。
// 若磁盘优先把它顶回 true，设置页开关就被架空了——用户拨开关点保存，落盘还是旧值
ok("A3 restoreOnLaunch 按提交值落盘（设置页开关不被架空）", after.restoreOnLaunch === false, JSON.stringify(after.restoreOnLaunch));
ok("A4 设置页真正拥有的字段照常生效（port 改成了 9600）", Number(after.port) === 9600, String(after.port));
// A5：反向同样成立——磁盘 false、提交 true，落盘必须是 true（开关两个方向都能改）
{
  const c = config.defaultConfig();
  c.proxy.restoreOnLaunch = true;
  config.saveConfigFromUI(c);
  ok("A5 restoreOnLaunch 反向提交（true）同样生效", config.loadConfig().proxy.restoreOnLaunch === true);
}
// A6/A7：两个协议面止血开关。界面没有入口（用户手工改 config.json），应用在跑的时候改盘后
// 内存快照与渲染层快照都还是旧的——此时任何一次无关的整份保存都会把这个 false 抹掉，
// 等于止血开关自己弹回来。故与上面两个字段同列，以磁盘为准。
ok("A6 enableAnthropic 未被冲掉（仍是关闭）", after.enableAnthropic === false, JSON.stringify(after.enableAnthropic));
ok("A7 enableResponses 未被冲掉（仍是关闭）", after.enableResponses === false, JSON.stringify(after.enableResponses));

// —— 契约 B：三个写入方自己的写入必须仍然生效 ——
console.log("");
console.log("=== 契约 B：各写入方（走 saveConfig）仍能正常写盘 ===");
{
  const cfg = config.loadConfig();
  cfg.proxy.channelEnabled = { ...(cfg.proxy.channelEnabled || {}), qoder: false };
  config.saveConfig(cfg);
}
ok("B1 channelEnabled 可新增键（qoder=false）",
  config.loadConfig().proxy.channelEnabled.qoder === false,
  JSON.stringify(config.loadConfig().proxy.channelEnabled));
{
  const cfg = config.loadConfig();
  cfg.proxy.channelEnabled = {};                             // 重新启用全部
  config.saveConfig(cfg);
}
ok("B2 channelEnabled 可清空（重新启用）",
  JSON.stringify(config.loadConfig().proxy.channelEnabled) === "{}",
  JSON.stringify(config.loadConfig().proxy.channelEnabled));
{
  const cfg = config.loadConfig();
  cfg.proxy.restoreOnLaunch = false;
  config.saveConfig(cfg);
}
ok("B3 restoreOnLaunch 可改回 false", config.loadConfig().proxy.restoreOnLaunch === false);
{
  const cfg = config.loadConfig();
  cfg.proxy.checkinAutoRules = {};
  config.saveConfig(cfg);
}
ok("B4 checkinAutoRules 可清空", JSON.stringify(config.loadConfig().proxy.checkinAutoRules) === "{}");

// —— 契约 C：读盘失败时不得让设置页整体保存失败 ——
console.log("");
console.log("=== 契约 C：兜底不得让保存本身失败 ===");
{
  const r = config.saveConfigFromUI(config.defaultConfig());
  ok("C1 saveConfigFromUI 返回 ok:true", !!(r && r.ok === true), JSON.stringify(r));
  // C2：saveConfigFromUI 里只有「读盘」那段被 try 包住；保存/校验的异常必须照常抛出，
  //     否则设置页会把非法配置当成功（静默丢配置）。用一个缺 webdav 的残缺配置触发。
  let threw = false;
  try { config.saveConfigFromUI({ proxy: {} }); } catch { threw = true; }
  ok("C2 保存/校验失败仍会抛错（不被读盘兜底吞掉）", threw);
  // C3：兜底只影响名单内那两个字段，其余字段不会被顺带改动
  {
    const c = config.defaultConfig();
    c.proxy.port = 9601;
    config.saveConfigFromUI(c);
    const p = config.loadConfig().proxy;
    ok("C3 其余设置页字段照常生效（port 9601）", Number(p.port) === 9601, String(p.port));
  }
}

console.log("");
console.log("RESULT: " + pass + " passed / " + fail + " failed");
if (bad.length) { console.log("failures:"); bad.forEach((x) => console.log("  - " + x)); }
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
