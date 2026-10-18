// 命令表自测：收集器集合 == 源码注册集合 == preload 白名单集合，且 read/deny 分类无未知命令。
// 三处任一漂移的后果：新命令在 Web/远程端静默不可达（收集漏）、桌面调用被白名单拦（preload 漏）、
// 分类写错名字导致门控失效——都在这里拦下。用法：node tools/proxy-command-table-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cmdtable-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;
process.env.AGENT_SKILLS_HOME = path.join(SANDBOX, "skills");

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}

const ROOT = path.join(__dirname, "..");
const { collectCommands, modeOf, READ, DENY } = require(path.join(ROOT, "gateway", "src", "commands.cjs"));

const collected = collectCommands();
const registered = new Set(
  [...fs.readFileSync(path.join(ROOT, "electron/backend/proxy/index.cjs"), "utf8").matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1])
);
const preloadSrc = fs.readFileSync(path.join(ROOT, "electron/preload.cjs"), "utf8");
const allowBlock = preloadSrc.slice(preloadSrc.indexOf("const ALLOWED_COMMANDS"), preloadSrc.indexOf("contextBridge.exposeInMainWorld"));
const allowed = new Set([...allowBlock.matchAll(/"(proxy_[a-z_]+)"/g)].map((m) => m[1]));

function diff(a, b) {
  const bs = b instanceof Set ? b : new Set(b); // 兼容 Map.keys() 等迭代器入参
  return [...a].filter((x) => !bs.has(x));
}

ok("收集表非空且规模合理（≥60）", collected.size >= 60, String(collected.size));
ok(`收集集合 == 源码注册集合（${registered.size}）`, diff(collected.keys(), registered).length === 0 && diff(registered, collected.keys()).length === 0,
  `仅收集有: ${diff(collected.keys(), registered).join(",") || "-"} | 仅源码有: ${diff(registered, collected.keys()).join(",") || "-"}`);
ok(`收集集合 == preload 白名单集合（${allowed.size}）`, diff(collected.keys(), allowed).length === 0 && diff(allowed, collected.keys()).length === 0,
  `仅收集有: ${diff(collected.keys(), allowed).join(",") || "-"} | 仅白名单有: ${diff(allowed, collected.keys()).join(",") || "-"}`);

const all = [...collected.keys()];
ok("分类闭合：每条命令都有 read/write/deny 之一", all.every((c) => ["read", "write", "deny"].includes(modeOf(c))));
ok("DENY 无未注册命令（防手滑写错名）", Object.keys(DENY).every((c) => collected.has(c)), diff(new Set(Object.keys(DENY)), collected).join(","));
ok("READ 无未注册命令", [...READ].every((c) => collected.has(c)), diff(new Set(READ), collected).join(","));
ok("deny 与 read 无交集", [...READ].every((c) => !DENY[c]));
ok("每条 deny 都有面向用户的说明", Object.values(DENY).every((v) => typeof v === "string" && v.length >= 8));

const stats = { read: 0, write: 0, deny: 0 };
for (const c of all) stats[modeOf(c)]++;
console.log(`分类：read ${stats.read} / write ${stats.write} / deny ${stats.deny}（合计 ${all.length}）`);

console.log("");
console.log(`RESULT: ${pass} passed / ${fail} failed`);
if (bad.length) { console.log("失败项："); for (const b of bad) console.log("  - " + b); }
process.exit(fail ? 1 : 0);
