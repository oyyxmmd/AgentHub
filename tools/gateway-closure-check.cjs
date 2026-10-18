// 反代网关依赖闭包断言：从网关入口与核心模块出发，递归收集全部相对 require 目标，
// 断言每个文件都存在。用途是卡住 Dockerfile 的 COPY 范围与真实闭包漂移——
// 历史上白名单漏过 28 个文件（24 个用量适配器 + sqlcipher/sync-adapter/temp-util/crashlog），
// 靠分支巧合与 try/catch 才没在启动时炸。
//
// 用法：node tools/gateway-closure-check.cjs [--root <dir>] [--min <n>]
//   --root  以该目录为仓库根（默认脚本的上一级）
//   --min   闭包文件数下限（默认 100，防 COPY 缩水后无人察觉）
//
// 入口是显式清单：gateway/src/index.cjs 的核心模块全部用 path.join 动态拼路径，
// 纯静态扫描抓不到，故把它的目标与共享核心一并列为入口。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
function argOf(flag, dft) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dft;
}

const ROOT = path.resolve(argOf("--root", path.join(__dirname, "..")));
const MIN = Number(argOf("--min", "100"));

const ENTRIES = [
  "gateway/src/index.cjs",
  "electron/backend/proxy/server.cjs",
  "electron/backend/proxy/index.cjs",
  "electron/backend/proxy/store.cjs",
  "electron/backend/proxy/adapters.cjs",
  "electron/backend/proxy/pool.cjs",
  "electron/backend/proxy/credits.cjs",
  "electron/backend/proxy/poolsched.cjs",
  "electron/backend/proxy/rules.cjs",
  "electron/backend/proxy/discovery.cjs",
  "electron/backend/config.cjs",
];

function resolveRel(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, base + ".cjs", base + ".js", path.join(base, "index.cjs")];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* 权限等异常按缺失处理 */ }
  }
  return null;
}

const seen = new Set();
const missing = [];

function walk(file) {
  if (seen.has(file)) return;
  if (!fs.existsSync(file)) {
    missing.push(file.slice(ROOT.length + 1));
    return;
  }
  seen.add(file);
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  // 逐行扫描并跳过整行注释：注释里的示例性/历史性 require 不该算入闭包（防误报缺失）。
  // 行尾注释与块注释中段未剥离——当前代码库无此形态，出现时按缺失报出人工确认即可
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    const re = /require\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(line))) {
      const next = resolveRel(file, m[1]);
      if (next) walk(next);
      else if (m[1].startsWith(".")) missing.push(`${file.slice(ROOT.length + 1)} -> ${m[1]}`);
    }
  }
}

for (const rel of ENTRIES) walk(path.resolve(ROOT, rel));

const count = seen.size;
console.log(`gateway 依赖闭包：${count} 个文件（下限 ${MIN}）`);
if (missing.length) {
  console.log(`解析失败 ${missing.length} 项：`);
  for (const m of missing) console.log("  " + m);
}
if (count < MIN || missing.length) {
  console.error(missing.length ? "闭包存在缺失文件" : `闭包文件数低于下限 ${MIN}`);
  process.exit(1);
}
console.log("闭包完整");
