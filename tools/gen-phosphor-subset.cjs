// 扫 src/ 与 electron/（含 main.cjs / preload.cjs）实际用到的 Phosphor 类名，生成只含这些字形的 CSS。
// 全量 style.full.css 有 1530 条规则 / 82 KB，本仓真正用到的只有几十条。
// 用法：
//   node tools/gen-phosphor-subset.cjs                  # 生成 src/assets/phosphor/phosphor-used.css
//   node tools/gen-phosphor-subset.cjs --root <dir>     # 换仓库根（自测脚本用临时夹具跑正反例）
// 图标集合变化后重跑即可；扫到字体表里不存在的类名会直接失败退出，不静默丢。
//
// 静态扫描的盲区：动态拼出来的类名（`"ph-" + name`）这里看不见，它会静默渲染成空白。
// 本仓当前没有这种写法（scripts/test-bundle-size.cjs 的 ③ 段专扫这个），
// 将来引入时要么在这里加显式白名单，要么把候选写全在拼名处。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else if (/\.(vue|ts|js|cjs)$/.test(e.name)) files.push(p);
  }
  return files;
}

/** 源码里出现过的全部 ph-* 类名（CSS 自定义属性 --ph- 被这个正则自然排除） */
function collectUsed(repoRoot) {
  const used = new Set();
  for (const f of [...walk(path.join(repoRoot, "src")), ...walk(path.join(repoRoot, "electron"))]) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/\bph-[a-z0-9]+(?:-[a-z0-9]+)*/g)) used.add(m[0]);
  }
  return used;
}

/** 从全量 CSS 里切出 @font-face + .ph 基础块，以及全部字形规则；子集与自测共用同一份切法 */
function readFullRepo(fullText) {
  const firstIcon = fullText.search(/\.ph\.ph-[a-z0-9-]+:before\s*\{/);
  // 原样搬运 @font-face + .ph 基础块（font-display 与 ligature/smoothing 都在里面，别重排）。
  // 唯一改动：src 只保留 woff2——目录里只有 Phosphor.woff2，.woff/.ttf/.svg 三个 url 指向的文件
  // 仓库里根本没有，Vite 构建时每个都报一次 "didn't resolve at build time"（全量 CSS 那三条
  // 警告就是这么来的）。浏览器会选中 woff2 所以运行时不会去取那三个，但死 url 留着只是噪声。
  const header = fullText.slice(0, firstIcon).replace(
    /src:\s*url\(["']\.\/Phosphor\.woff2["']\)\s*format\(["']woff2["']\)\s*,[\s\S]*?;/,
    'src: url("./Phosphor.woff2") format("woff2");'
  );
  const rules = new Map();
  for (const m of fullText.matchAll(/\.ph\.ph-([a-z0-9-]+):before\s*\{[^}]*\}/g)) rules.set("ph-" + m[1], m[0]);
  return { header, rules };
}

// 导出面在 require.main 守卫之前：自测脚本复用同一套扫描与切分实现，不另抄一份（抄的那份会漂）
module.exports = { collectUsed, readFullRepo, walk };

// 守卫：被 require 时零副作用（本仓有脚本因缺它而在被 require 时真把探针跑了一次）。
// 顶层 return 在 CJS 模块包装函数里合法：作为入口时 require.main === module 照常执行。
if (require.main !== module) return;

const rootIdx = process.argv.indexOf("--root");
const REPO = rootIdx > -1 ? path.resolve(process.argv[rootIdx + 1]) : path.join(__dirname, "..");
const FULL = path.join(REPO, "src", "assets", "phosphor", "style.full.css");
const OUT = path.join(REPO, "src", "assets", "phosphor", "phosphor-used.css");

const used = collectUsed(REPO);
const { header, rules } = readFullRepo(fs.readFileSync(FULL, "utf8"));

const missing = [...used].filter((c) => !rules.has(c)).sort();
if (missing.length) {
  console.error("字体表里不存在这些类名（图标现在就是空白，改名或补字形）:", missing.join(" "));
  process.exit(1);
}

const kept = [...used].filter((c) => rules.has(c)).sort();
fs.writeFileSync(OUT, header + kept.map((c) => rules.get(c)).join("\n") + "\n", "utf8");
console.log(`phosphor 子集: ${kept.length} / ${rules.size} 条规则 → ${path.relative(process.cwd(), OUT)}`);
