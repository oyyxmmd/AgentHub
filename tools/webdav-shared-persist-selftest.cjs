// issue #95 回归守卫：WebDAV 服务器配置不得被界面操作冲掉，也不得被空密码覆盖
//
// 现象（GitHub issue #95）：测试通过、同步成功过，有时候配置还会丢失。
// 根因链（已逐行核实）：
//   1. webdavShared 从不经设置页整份保存编辑（专用通道 webdav_shared_save），渲染层快照里
//      这一段是启动时带进来的旧行李字段——任意整份保存（切主题/拖模块排序/改反代设置）都会
//      用它把已保存的服务器配置整段冲掉，首配会话内密码快照为空串时连密码一起清空
//   2. loadConfig 解不开 enc:v1: 密文（换机 / DPAPI 变化）时内存密码是 ""，网关启停等
//      后台读改写保存会把密文永久覆盖成空（只剩地址账号没密码）
//   3. 迁移自愈会把旧位置凭据「复活」，复活即清副本 → 时丢时回、有时彻底丢
//
// 本守卫锁四条契约：
//   A. saveConfigFromUI（设置页整份提交）→ webdavShared 整段以磁盘为准（旧快照不得冲掉）
//   B. saveConfig 遇「服务器未变 + 密码为空」→ 保留磁盘密文（解密失败保护）；换服务器正常写
//   C. webdav_shared_save 仍正常生效（自己的专用通道不受磁盘优先影响）
//   D. clearSharedWebdav 显式清除 → 全字段清空（唯一清密码后门）
//
// 全部在沙箱数据目录内运行，带安全闸门，绝不触碰真实配置。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-issue95-"));
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

// 自测环境无 electron/safeStorage：encryptSecret 透传明文，decryptSecret 对 enc:v1: 返回 ""，
// 正好用来模拟「换机后解不开密文」的真实场景
function diskShared() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return raw.webdavShared || {};
  } catch { return {}; }
}

console.log("");
console.log("=== C：专用保存通道正常生效 ===");
const saved = config.saveSharedWebdav({ endpoint: "https://dav.example.com/dav", username: "alice", password: "pw-123", roots: {} });
ok("保存成功", saved && saved.ok);
let d = diskShared();
ok("endpoint/username 落盘", d.endpoint === "https://dav.example.com/dav" && d.username === "alice", JSON.stringify(d));
ok("密码落盘（无 safeStorage 时明文透传）", d.password === "pw-123", JSON.stringify(d));
const loaded = config.loadConfig();
ok("loadConfig 解出明文密码", loaded.webdavShared.password === "pw-123", loaded.webdavShared.password);

console.log("");
console.log("=== A：整份提交（设置页路径）不得冲掉 webdavShared ====");
// 渲染层旧快照：启动时带的旧行李字段（全空）+ 用户改了无关设置（主题）。
// 真实渲染层永远提交全量配置（loadConfig 的完整合并结果），这里照原样构造
const staleSnapshot = {
  theme: "light",
  proxy: { restoreOnLaunch: false },
  webdav: { endpoint: "", username: "", password: "", root: "/agent-skills", deviceId: "d0", deviceName: "测试机" },
  webdavShared: { endpoint: "", username: "", password: "", roots: {} },
};
const r1 = config.saveConfigFromUI(JSON.parse(JSON.stringify(staleSnapshot)));
ok("保存成功", r1 && r1.ok);
d = diskShared();
ok("整份提交后 endpoint 保留", d.endpoint === "https://dav.example.com/dav", JSON.stringify(d));
ok("整份提交后 username 保留", d.username === "alice", JSON.stringify(d));
ok("整份提交后密码保留", d.password === "pw-123", JSON.stringify(d));
// 主题等设置页自有字段仍按提交值落盘（磁盘优先不得架空设置页）
ok("设置页自有字段按提交值落盘", config.loadConfig().theme === "light");
// 快照缺 webdavShared 键时同样兜底
const r2 = config.saveConfigFromUI({ theme: "dark", proxy: {}, webdav: { endpoint: "", username: "", password: "", root: "", deviceId: "d0", deviceName: "测试机" } });
d = diskShared();
ok("快照缺段时整段回填", r2.ok && d.endpoint === "https://dav.example.com/dav" && d.password === "pw-123", JSON.stringify(d));

console.log("");
console.log("=== B：解密失败保护——空密码不覆盖密文，换服务器正常写 ====");
// 直接往磁盘塞一段解不开的密文（模拟换机 / DPAPI 变化），loadConfig 会得到 ""
const FAKE_ENC = "enc:v1:ZmFrZUNpcGhlcnRleHQ=";
{
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  raw.webdavShared.password = FAKE_ENC;
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), "utf8");
}
ok("前置：解密失败内存密码为空串", config.loadConfig().webdavShared.password === "");
// 模拟后台读改写保存（网关启停 rememberRunning 同款路径：loadConfig → 改无关字段 → saveConfig）
{
  const cfg = config.loadConfig();
  cfg.proxy.restoreOnLaunch = true;
  config.saveConfig(cfg);
}
d = diskShared();
ok("后台保存后密文保留（不被空密码覆盖）", d.password === FAKE_ENC, JSON.stringify(d));
ok("endpoint 未受影响", d.endpoint === "https://dav.example.com/dav", JSON.stringify(d));
// 换服务器（endpoint 变了）+ 空密码 → 允许写空（用户在新服务器上重新配置）
{
  const cfg = config.loadConfig();
  cfg.webdavShared.endpoint = "https://new.example.com/dav";
  cfg.webdavShared.username = "bob";
  config.saveConfig(cfg);
}
d = diskShared();
ok("换服务器时空密码正常落盘", d.endpoint === "https://new.example.com/dav" && d.password === "", JSON.stringify(d));

console.log("");
console.log("=== D：显式清除通道 ====");
// 先造出加密口令与 legacy 旧凭据，清除必须连它们一起清掉（审查整改：清不掉=永远无法回到「沿用密码」；
// legacy 不清则清除后迁移会把旧服务器凭据复活成 #95 现象）
{
  config.saveSharedWebdav({ type: "webdav", endpoint: "https://clear-me.example.com/dav", username: "carol", password: "pw-clear", encryptionPassphrase: "pp-clear", roots: {} });
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  raw.webdav = { endpoint: "https://legacy.example.com/dav", username: "old", password: "old-pw", root: "/agent-skills", deviceId: "d1", deviceName: "旧机" };
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), "utf8");
}
const cleared = config.clearSharedWebdav();
ok("清除成功", cleared && cleared.ok);
d = diskShared();
ok("全字段清空（含加密口令）", !d.endpoint && !d.username && !d.password && !d.encryptionPassphrase, JSON.stringify(d));
{
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const legacy = raw.webdav || {};
  ok("legacy webdav 段凭据同步清空（防迁移复活）", !legacy.endpoint && !legacy.username && !legacy.password, JSON.stringify(legacy));
}
// 清除后立即再读不复活
const afterClear = config.loadSharedWebdav();
ok("清除后 loadSharedWebdav 不复活旧凭据", !afterClear.endpoint, afterClear.endpoint);

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log("");
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) { console.log("失败项：\n  - " + bad.join("\n  - ")); process.exit(1); }
