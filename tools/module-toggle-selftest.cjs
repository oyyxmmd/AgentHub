// issue #91 回归守卫：四大板块启用开关（轻量模式）
//
// 锁三件事：
//   M1. 归一化：modules 非法/缺失回 true（默认全启用），不因脏值炸掉读点
//   M2. 迁移：旧版「记忆中枢已关闭」（memory.enabled=false）一次性迁移进
//       modules.memory.enabled——老用户升级后板块开关与旧状态一致
//   M3. 磁盘优先：module_toggle 是 modules 唯一写入口，设置页整份保存
//       （saveConfigFromUI）不得用渲染层旧快照把开关状态写回去
//
// 沙箱：AGENTHUB_DATA_DIR 隔离 + 路径闸门，绝不触碰真实配置。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-issue91-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}

const config = require("../electron/backend/config.cjs");
const cfgPath = config.configPath();
const inSandbox = path.resolve(cfgPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase());
console.log("=== 安全闸门 ===");
console.log("  沙箱 = " + SANDBOX);
ok("配置路径在沙箱内", inSandbox);
if (!inSandbox) { console.error("拒绝运行：配置路径不在沙箱内"); process.exit(2); }

console.log("");
console.log("=== M1：归一化（默认全启用 / 脏值回 true）===");
let cfg = config.loadConfig();
ok("默认四板块全启用", ["skills", "sync", "proxy", "memory"].every((k) => cfg.modules[k].enabled === true), JSON.stringify(cfg.modules));
// 直接往磁盘写脏值再读
{
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  raw.modules = { skills: "no", sync: null, proxy: { enabled: false }, memory: {} };
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), "utf8");
}
cfg = config.loadConfig();
ok("脏值归一：非法回 true", cfg.modules.skills.enabled === true && cfg.modules.sync.enabled === true && cfg.modules.memory.enabled === true);
ok("脏值归一：合法 false 保留", cfg.modules.proxy.enabled === false, JSON.stringify(cfg.modules));

console.log("");
console.log("=== M2：旧版 memory.enabled=false 迁移 ====");
{
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  delete raw.modules;
  raw.memory = { enabled: false, rootDir: "" };
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), "utf8");
}
cfg = config.loadConfig();
ok("旧字段迁移进 modules", cfg.modules.memory.enabled === false, JSON.stringify(cfg.modules));
ok("modules 被删后其余板块回默认启用", cfg.modules.skills.enabled === true && cfg.modules.proxy.enabled === true, JSON.stringify(cfg.modules));

console.log("");
console.log("=== M3：整份保存不得冲掉开关状态 ====");
// 模拟主进程 module_toggle：重新启用 proxy + 停用用量（sync）（直写盘，同款路径）
cfg = config.loadConfig();
cfg.modules.proxy.enabled = true;
cfg.modules.sync.enabled = false;
config.saveConfig(cfg);
// 渲染层旧快照（启动时拉的全量，开关还是旧值）做整份保存
const stale = config.loadConfig();
stale.modules.sync.enabled = true;  // 旧快照里的过期状态
stale.modules.memory.enabled = true;
stale.theme = "light";
const r = config.saveConfigFromUI(JSON.parse(JSON.stringify(stale)));
ok("保存成功", r && r.ok);
cfg = config.loadConfig();
ok("toggle 后的用量（sync）=false 不被旧快照写回 true", cfg.modules.sync.enabled === false, JSON.stringify(cfg.modules));
ok("toggle 后的 proxy=true 保持", cfg.modules.proxy.enabled === true, JSON.stringify(cfg.modules));
ok("设置页自有字段按提交值落盘", cfg.theme === "light");

console.log("");
console.log("=== M4：memory 开关启用后不被旧字段迁移打回（审查整改 P1）===");
// 磁盘残留旧字段 memory.enabled=false（老用户从记忆页关过），经新入口重新启用后
// 任何一次 loadConfig 都不得把 modules.memory.enabled 打回 false
{
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  raw.memory = { enabled: false, rootDir: "" };
  raw.modules.memory.enabled = true;
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), "utf8");
}
// 模拟 module_toggle 的 memory 双写（main.cjs 同款：modules 与旧字段一起写）
cfg = config.loadConfig();
cfg.modules.memory.enabled = true;
cfg.memory = { ...(cfg.memory || {}), enabled: true };
config.saveConfig(cfg);
cfg = config.loadConfig();
ok("启用后多次 loadConfig 保持启用", cfg.modules.memory.enabled === true, JSON.stringify(cfg.modules));
ok("旧字段同步为 true（迁移不再打回）", cfg.memory.enabled === true, JSON.stringify(cfg.memory));

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log("");
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) { console.log("失败项：\n  - " + bad.join("\n  - ")); process.exit(1); }
