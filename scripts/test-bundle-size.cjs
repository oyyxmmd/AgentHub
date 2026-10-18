// 体积包自测：三条按需/子集改动各自的判据 + 每条的反例（装置不空转）。
// 运行：node scripts/test-bundle-size.cjs          # 静态 + 真执行（echarts 用 SSR 出图）
//       node scripts/test-bundle-size.cjs --dist   # 额外核对 npm run build 的产物（缺 dist 该段判红）
// 不碰用户数据、不起浏览器、不写仓库里除 dist 以外的东西。
//
// 为什么要反例：这三类改动失败时都不报错——漏注册的 echarts 组件是空白图，漏引的 EP 样式是
// 裸样式弹窗，子集少一条是空白图标。只判「跑通了」的闸抓不到，所以每条判据都配一个
// 「必须分叉」的对照，不分叉就判红。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const WITH_DIST = process.argv.indexOf("--dist") > -1;
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const read = String.raw;

let pass = 0, failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else out.push(p);
  }
  return out;
}
const SRC_FILES = walk(path.join(ROOT, "src")).filter((f) => /\.(vue|ts)$/.test(f));
const relOf = (f) => path.relative(ROOT, f).replace(/\\/g, "/");

// =====================================================================
// ① echarts 按需：注册集够不够，用真实 setOption + SSR 出图来判
// =====================================================================
(async () => {
  const U = "src/utils/echarts.ts";
  const U_OK = fs.existsSync(path.join(ROOT, U));
  if (!U_OK) ok(false, `① 按需入口 ${U} 不存在——这条改动没落地，后面 ① 的判据都无从谈起`);
  const mod = U_OK ? rd(U) : "";

  // 1) 唯一入口：除 utils/echarts.ts 之外，任何前端源码都不许直接 import echarts
  const direct = [];
  for (const f of SRC_FILES) {
    if (relOf(f) === U) continue;
    if (/from\s*["']echarts(\/[^"']*)?["']/.test(fs.readFileSync(f, "utf8"))) direct.push(relOf(f));
  }
  ok(direct.length === 0,
    `① 直接 import echarts 的文件只剩按需入口一个（实测 ${direct.length} 处违规${direct.length ? "：" + direct.join(" ") : ""}）`);

  // 2) 从产物源码里读出「注册了哪些」与「各自来自哪个子路径」——不另抄一份清单（抄的会漂）
  const importMap = new Map();
  for (const m of mod.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](echarts(?:\/[^"']*)?)["']/g)) {
    for (const n of m[1].split(",")) if (n.trim()) importMap.set(n.trim(), m[2]);
  }
  const useList = (/echarts\.use\(\[([^\]]*)\]/.exec(mod) || [, ""])[1]
    .split(",").map((s) => s.trim()).filter(Boolean);
  ok(useList.length >= 5 && [...importMap.keys()].length >= 5,
    `① 注册表读得出内容（use([...]) ${useList.length} 项、import 映射 ${importMap.size} 项；读出 0 项＝解析失效）`);
  ok(useList.every((n) => importMap.has(n)),
    `① use([...]) 里每一项都在本文件 import 过（缺的项 ${useList.filter((n) => !importMap.has(n)).join(" ") || "无"}）`);
  ok(/from\s*["']echarts\/core["']/.test(mod), `① 入口从 echarts/core 取（不是 "echarts" 全量包）`);

  // 3) 三个图表实际用到的 option 形态 → 需要的注册集合
  const CHARTS = SRC_FILES.filter((f) => /echarts|utils\/echarts/.test(fs.readFileSync(f, "utf8")) && /\.vue$/.test(f));
  const SERIES_TYPES = ["line", "bar", "pie", "scatter", "effectScatter", "custom", "heatmap", "candlestick", "radar", "tree", "treemap", "sunburst", "graph", "sankey", "boxplot", "funnel", "gauge", "polar", "themeRiver"];
  const COMPONENT_KEYS = { grid: "GridComponent", tooltip: "TooltipComponent", legend: "LegendComponent", dataZoom: "DataZoomComponent", title: "TitleComponent", visualMap: "VisualMapComponent", toolbox: "ToolboxComponent", brush: "BrushComponent", timeline: "TimelineComponent", polar: "PolarComponent", radar: "RadarComponent", geo: "GeoComponent", singleAxis: "SingleAxisComponent", parallel: "ParallelComponent" };
  const needCharts = new Set(), needComponents = new Set(), needMark = new Set();
  for (const f of CHARTS) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/type:\s*["']([a-zA-Z]+)["']/g)) {
      if (SERIES_TYPES.includes(m[1])) needCharts.add(m[1]);
    }
    for (const [key, comp] of Object.entries(COMPONENT_KEYS)) {
      if (new RegExp(read`\b${key}:\s*\{`).test(src) || new RegExp(read`\b${key}:\s*\[`).test(src)) needComponents.add(comp);
    }
    for (const mk of ["markLine", "markArea", "markPoint"]) {
      if (new RegExp(read`\b${mk}:\s*\[`).test(src)) needMark.add(mk);
    }
  }
  ok(CHARTS.length >= 3 && needCharts.size > 0 && needComponents.size > 0,
    `① 扫到 ${CHARTS.length} 个图表文件、需要 series ${[...needCharts].join("/")}、组件 ${needComponents.size} 类（任一为 0＝扫描失效，判据会假绿）`);
  ok(needMark.size === 0, `① 图表没有用 mark* 系列（用了就必须注册 MarkLineComponent 等，实测 ${[...needMark].join(" ") || "无"}）`);
  const registered = new Set(useList);
  const chartCands = { line: "LineChart", bar: "BarChart", pie: "PieChart", scatter: "ScatterChart" };
  const missCharts = [...needCharts].filter((t) => !registered.has(chartCands[t]));
  const missComps = [...needComponents].filter((c) => !registered.has(c));
  ok(missCharts.length === 0 && missComps.length === 0,
    `① 需求集 ⊆ 注册集（缺：${[...missCharts, ...missComps].join(" ") || "无"}）`);

  // 4) 真执行：拿注册集去 SSR 出一张图，看 echarts 自己报不报「not imported」
  //    入口文件不在（改动没落地）时整段跳过：这时反例也会一起红，那是噪声不是信息
  if (U_OK) {
  const echarts = await import("echarts/core");
  const buckets = {};
  for (const [name, spec] of importMap) {
    if (spec === "echarts/core") continue;
    buckets[spec] = buckets[spec] || new Set();
    buckets[spec].add(name);
  }
  for (const [spec, names] of Object.entries(buckets)) {
    const m = await import(spec);
    const missing = [...names].filter((n) => typeof m[n] !== "function");
    ok(missing.length === 0, `① ${spec} 真的导出得了 ${[...names].join(" ")}（拿不到＝假注册）`);
    echarts.use([...names].map((n) => m[n]));
  }
  const { SVGRenderer } = await import("echarts/renderers");
  echarts.use([SVGRenderer]); // 只为在 Node 里出图：产品用 CanvasRenderer，option 解析路径两者共用
  ok(typeof echarts.graphic.LinearGradient === "function",
    "① 入口注释里承诺的 echarts.graphic.LinearGradient 在 echarts/core 上真是构造函数（图表面积渐变靠它）");

  const buildOption = () => ({
    legend: { type: "scroll", data: ["a"] }, tooltip: {}, grid: {},
    xAxis: { type: "category", data: ["a", "b", "c"] }, yAxis: { type: "value" },
    series: [...needCharts].map((t, i) => ({
      name: "a", type: t, data: [1, 5, 2],
      areaStyle: t === "line" ? { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: "#f00" }, { offset: 1, color: "#0f0" }]) } : undefined,
    })),
  });
  const runSsr = (opt) => {
    const errs = [], warns = [];
    const origErr = console.error, origWarn = console.warn;
    console.error = (...a) => errs.push(a.join(" "));
    console.warn = (...a) => warns.push(a.join(" ")); // 「legend 与 series 名不匹配」这类提示与本判据无关，别刷屏
    let svg = "";
    try {
      const c = echarts.init(null, null, { renderer: "svg", ssr: true, width: 320, height: 160 });
      c.setOption(opt);
      svg = c.renderToSVGString();
      c.dispose();
    } finally { console.error = origErr; console.warn = origWarn; }
    return { errs, paths: (svg.match(/<path/g) || []).length };
  };
  const good = runSsr(buildOption());
  ok(good.errs.length === 0,
    `① 用注册集 SSR 出图，echarts 一条「not imported」都不报（实测 ${good.errs.length} 条：${good.errs.slice(0, 1).map((e) => e.slice(0, 60)).join(" / ") || "无"}）`);
  ok(good.paths > 0, `① 那张图真画出东西了（<path> ${good.paths} 条；0 条＝图是空的，判据不能只看没报错）`);

  // 反例 1：option 里冒出没注册的 series 类型 → 必须报
  const bad1 = runSsr({ ...buildOption(), series: [{ type: "bar", data: [1, 2, 3] }] });
  ok(bad1.errs.some((e) => /Series bar is used but not imported/.test(e)),
    `反例 1（正对照）：未注册的 bar 必须被这套装置抓到（实测报错 ${bad1.errs.length} 条）——抓不到就说明 ① 的「零报错」是空转`);
  // 反例 2：option 里冒出没注册的组件键 → 必须报
  const bad2 = runSsr({ ...buildOption(), dataZoom: [{ type: "inside" }] });
  ok(bad2.errs.some((e) => /Component dataZoom is used but not imported/.test(e)),
    `反例 2：未注册的 dataZoom 必须被抓到（实测报错 ${bad2.errs.length} 条）`);
  // 反例 3：空 option → 不该有 path，证明 paths>0 是真信号而不是恒定值
  const empty = runSsr({});
  ok(empty.paths === 0 && good.paths > empty.paths,
    `反例 3：空 option 出 ${empty.paths} 条 <path>、真 option 出 ${good.paths} 条——两者必须分叉，否则「画出东西」是假判据`);
  } // ① U_OK 真执行块

  // =====================================================================
  // ② Element Plus 按需
  // =====================================================================
  const main = rd("src/main.ts");
  ok(!/import\s+ElementPlus\s+from\s*["']element-plus["']/.test(main),
    "② main.ts 不再默认导入全量 ElementPlus（回来了就是按需失效）");
  ok(!/element-plus\/dist\/index\.css/.test(main),
    "② main.ts 不再引全量 index.css");
  ok(!/app\.use\(ElementPlus/.test(main), "② main.ts 不再 app.use(ElementPlus)");

  // 服务式 API：插件接管不到，必须各自有显式样式引入
  const svc = new Set();
  for (const f of SRC_FILES) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*["']element-plus["']/g)) {
      for (const raw of m[1].split(",")) { const n = raw.trim(); if (/^El[A-Z]/.test(n)) svc.add(n); }
    }
  }
  const NO_STYLE = new Set(["ElConfigProvider"]); // provider 不渲染 DOM、theme-chalk 里没有它的 css 文件
  const kebab = (n) => "el-" + n.slice(2).replace(/([A-Z])/g, (m, c, i) => (i ? "-" : "") + c.toLowerCase());
  const styleImports = new Set([...main.matchAll(/element-plus\/es\/components\/([a-z-]+)\/style\/css/g)].map((m) => m[1]));
  // 引入路径里的段名不带 el- 前缀（element-plus/es/components/message/style/css），这里统一剥掉
  const seg = (n) => kebab(n).slice(3);
  const svcMissing = [...svc].filter((n) => !NO_STYLE.has(n) && !styleImports.has(seg(n))).sort();
  ok(svc.size > 0 && svcMissing.length === 0,
    `② 服务式 API ${svc.size} 个（${[...svc].sort().join(" ")}）都有显式样式引入（缺：${svcMissing.join(" ") || "无"}）`);
  // 反例 4：把某条显式引入「删掉」后判据必须分叉——在内存里重放，不动磁盘
  const replay = (drop) => {
    const fake = new Set([...styleImports].filter((k) => k !== drop));
    return [...svc].filter((n) => !NO_STYLE.has(n) && !fake.has(seg(n))).length;
  };
  const sample = seg([...svc].find((n) => !NO_STYLE.has(n)));
  ok(replay(sample) > 0 && replay("no-such-component") === 0,
    `反例 4：抽掉 ${sample} 的引入后判据报出缺失（${replay(sample)} 项），抽一个不存在的键则 0 项——两向都对才说明这条判据在管真事`);

  // locale 通道：全量注册删掉后，中文文案全靠 provider，漏了没有任何报错
  const appVue = rd("src/App.vue");
  ok(/import\s+zhCn\s+from\s*["']element-plus\/es\/locale\/lang\/zh-cn["']/.test(appVue)
    && /<el-config-provider\s+:locale="zhCn">/.test(appVue)
    && /<\/el-config-provider>/.test(appVue),
    "② 中文 locale 有注入点（App.vue 里 el-config-provider + zhCn，开闭都在）——这条漏了界面会静默变英文");

  // 指令面：插件按 directives:false 配置，用了指令式组件就必须先开那个开关
  const directiveHits = [];
  for (const f of SRC_FILES) {
    const src = fs.readFileSync(f, "utf8");
    for (const d of ["v-loading", "v-infinite-scroll"]) if (src.includes(d)) directiveHits.push(`${relOf(f)}:${d}`);
  }
  ok(directiveHits.length === 0,
    `② 全库没用指令式组件（v-loading / v-infinite-scroll），与 vite.config.ts 的 directives:false 一致（实测 ${directiveHits.join(" ") || "0 处"}）`);

  const vite = rd("vite.config.ts");
  ok(/ElementPlusResolver\(\{\s*directives:\s*false\s*\}\)/.test(vite) && /dirs:\s*\[\]/.test(vite)
    && /dts:\s*"src\/components\.d\.ts"/.test(vite),
    "② vite.config.ts 的插件配置三要素齐（resolver 关指令 / dirs 关本地扫描 / dts 落到 src/components.d.ts）");

  // 模板标签 ↔ 插件生成表：表里没有＝插件没接管，运行时是未知标签
  const tags = new Set();
  for (const f of SRC_FILES) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/<(el-[a-z][a-z0-9-]*)[\s/>]/g)) tags.add(m[1]);
  }
  const pascal = (t) => "El" + t.slice(3).split("-").map((s) => s[0].toUpperCase() + s.slice(1)).join("");
  let declared = null;
  const dtsPath = path.join(ROOT, "src", "components.d.ts");
  if (fs.existsSync(dtsPath)) {
    const dts = fs.readFileSync(dtsPath, "utf8");
    declared = new Set([...dts.matchAll(/^\s{4}(El[A-Za-z0-9]+):/gm)].map((m) => m[1]));
  }
  ok(declared !== null && declared.size > 0,
    `② 生成表 src/components.d.ts 在且非空（${declared ? declared.size : 0} 条声明）——不在就先跑一次 npm run build 再提交`);
  if (declared) {
    const undeclared = [...tags].filter((t) => t !== "el-config-provider" && !declared.has(pascal(t))).sort();
    ok(tags.size > 0 && undeclared.length === 0,
      `② 模板里 ${tags.size} 个 el-* 标签都在生成表里（缺：${undeclared.join(" ") || "无"}）`);
  }

  // =====================================================================
  // ③ Phosphor 子集
  // =====================================================================
  const PH_FILES = ["tools/gen-phosphor-subset.cjs", "src/assets/phosphor/style.full.css", "src/assets/phosphor/phosphor-used.css"];
  const phAbsent = PH_FILES.filter((r) => !fs.existsSync(path.join(ROOT, r)));
  if (phAbsent.length) {
    ok(false, `③ 子集三件不齐（缺：${phAbsent.join(" ")}）——这三件由本 PR 引入，缺任何一件这条判据都不成立`);
  } else {
  const gen = require(path.join(ROOT, "tools", "gen-phosphor-subset.cjs"));
  const used = gen.collectUsed(ROOT);
  const { rules } = gen.readFullRepo(rd("src/assets/phosphor/style.full.css"));
  const subsetPath = "src/assets/phosphor/phosphor-used.css";
  ok(fs.existsSync(path.join(ROOT, subsetPath)), `③ 子集文件在仓库里（${subsetPath}）`);
  const subset = rd(subsetPath);
  const inSubset = new Set([...subset.matchAll(/\.ph\.ph-([a-z0-9-]+):before/g)].map((m) => "ph-" + m[1]));
  const notInFont = [...used].filter((c) => !rules.has(c)).sort();
  ok(notInFont.length === 0 && used.size > 0,
    `③ 源码用到的 ${used.size} 个类名都在字体表里（字体表没有的：${notInFont.join(" ") || "无"}——这些图标现在就是空白）`);
  const lagging = [...used].filter((c) => rules.has(c) && !inSubset.has(c)).sort();
  ok(lagging.length === 0, `③ 用到的字形子集里都有（缺＝加了图标没重跑生成器：${lagging.join(" ") || "无"}）`);
  const stale = [...inSubset].filter((c) => !used.has(c)).sort();
  ok(stale.length === 0, `③ 子集里没有已不用的死规则（多＝该重跑生成器：${stale.join(" ") || "无"}）`);
  const handEdited = [...inSubset].filter((c) => !rules.has(c) || !subset.includes(rules.get(c))).sort();
  ok(handEdited.length === 0 && inSubset.size > 0,
    `③ 子集里每条规则都逐字来自全量表（对不上的：${handEdited.join(" ") || "无"}）——手改子集会把生成器变成装饰品`);
  ok((subset.match(/url\(/g) || []).length === 1 && /woff2/.test(subset),
    `③ 子集只留 woff2 一条 url（实测 ${(subset.match(/url\(/g) || []).length} 条）——全量那 3 条死 url 会让 Vite 构建时各报一次未解析警告`);
  ok(/import\s*["']\.\/assets\/phosphor\/phosphor-used\.css["']/.test(main) && !/phosphor\/style\.css/.test(main),
    "③ main.ts 引的是子集，不是全量 style.css");
  // 动态拼名是静态扫描的盲区，出现就必须显式处理（否则静默空白图标）
  const dynHits = [];
  for (const f of SRC_FILES) {
    const src = fs.readFileSync(f, "utf8");
    if (/"ph-["']\s*\+|'ph-["']\s*\+|`ph-\$\{/.test(src)) dynHits.push(relOf(f));
  }
  ok(dynHits.length === 0,
    `③ 没有用字符串拼 ph-* 类名（拼出来的扫描看不见，会静默空白：${dynHits.join(" ") || "0 处"}）`);
  // 反例 5：临时夹具里用一个字体表没有的类名 → 生成器必须非零退出并点名它
  {
    const fix = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ah-phos-fix-"));
    fs.mkdirSync(path.join(fix, "src", "assets", "phosphor"), { recursive: true });
    fs.mkdirSync(path.join(fix, "src", "components"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "src", "assets", "phosphor", "style.full.css"),
      path.join(fix, "src", "assets", "phosphor", "style.full.css"));
    fs.writeFileSync(path.join(fix, "src", "components", "Probe.vue"),
      '<template><i class="ph ph-no-such-glyph-xyz"></i></template>\n', "utf8");
    const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "gen-phosphor-subset.cjs"), "--root", fix], { encoding: "utf8" });
    ok(r.status === 1 && /ph-no-such-glyph-xyz/.test(r.stderr || ""),
      `反例 5：夹具里用字体表没有的类名，生成器必须 exit 1 并点名（实测 exit=${r.status}，stderr 含名字=${/ph-no-such-glyph-xyz/.test(r.stderr || "")}）`);
    // 反例 6：把那个假名字换回真字形 → 同一夹具必须成功（证明 5 的红是判据在管，不是夹具坏了）
    fs.writeFileSync(path.join(fix, "src", "components", "Probe.vue"),
      '<template><i class="ph ph-robot"></i></template>\n', "utf8");
    const r2 = spawnSync(process.execPath, [path.join(ROOT, "tools", "gen-phosphor-subset.cjs"), "--root", fix], { encoding: "utf8" });
    const made = path.join(fix, "src", "assets", "phosphor", "phosphor-used.css");
    ok(r2.status === 0 && fs.existsSync(made) && /\.ph\.ph-robot:before/.test(fs.readFileSync(made, "utf8")),
      `反例 6：同一夹具换成真字形后必须生成成功（实测 exit=${r2.status}）`);
    fs.rmSync(fix, { recursive: true, force: true });
  }

  } // ③ else（三件齐）

  // =====================================================================
  // ④ 产物核对（--dist）
  // =====================================================================
  if (WITH_DIST) {
    const dir = path.join(ROOT, "dist", "assets");
    if (!fs.existsSync(dir)) {
      ok(false, "④ --dist 要求 dist/assets 存在（先跑 npm run build）");
    } else {
      const cssF = fs.readdirSync(dir).find((f) => f.endsWith(".css"));
      const jsF = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
      const css = fs.readFileSync(path.join(dir, cssF), "utf8");
      const jsBytes = jsF.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
      const KB = (n) => (n / 1024).toFixed(1);
      ok(css.length > 0 && jsBytes > 0, `④ 产物读到了：CSS ${KB(css.length)} KB（${cssF}）、JS ${jsF.length} 个 chunk 合计 ${KB(jsBytes)} KB`);
      // 阈值按本次实测（CSS 374.6 KB / 单 chunk JS 1804 KiB）留 ~12% 余量，只拦失控级
      ok(KB(css.length) < 420, `④ 产物 CSS ${KB(css.length)} KB < 420 KB`);
      ok(KB(jsBytes) < 2050, `④ 产物 JS 合计 ${KB(jsBytes)} KB < 2050 KB`);
      // 每个用到的 el-* 都得有它自己的类名（子组件按 EP 的 BEM 归到父组件）
      const ALIAS = { "el-option": "el-select", "el-option-group": "el-select", "el-dropdown-item": "el-dropdown", "el-dropdown-menu": "el-dropdown", "el-radio-button": "el-radio", "el-step": "el-steps", "el-date-picker": "el-date-picker" };
      const has = (cls) => css.includes("." + cls) || css.includes("." + (ALIAS[cls] || cls));
      const noCss = [...tags].filter((t) => t !== "el-config-provider" && !has(t)).sort();
      ok(tags.size > 0 && noCss.length === 0,
        `④ 模板里 ${tags.size} 个 el-* 标签在产物 CSS 里都有类名（缺：${noCss.join(" ") || "无"}）`);
      const svcNoCss = [...svc].filter((n) => !NO_STYLE.has(n) && !css.includes("." + kebab(n))).sort();
      ok(svcNoCss.length === 0, `④ 服务式 API 的样式真进了产物（缺：${svcNoCss.join(" ") || "无"}）`);
      ok((css.match(/url\([^)]*Phosphor/g) || []).length === 1,
        `④ 产物里 Phosphor 的 url() 只 1 条（实测 ${(css.match(/url\([^)]*Phosphor/g) || []).length} 条）`);
    }
  } else {
    console.log("  · ④ 产物核对段未跑（要跑先 npm run build，再 node scripts/test-bundle-size.cjs --dist）");
  }

  console.log(`\n${failed ? "FAIL" : "OK"} 体积包自测：${pass} 项通过，${failed} 项失败${WITH_DIST ? "（含产物核对）" : ""}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(`\nFAIL 自测异常中断：${(e && e.stack) || e}`);
  process.exit(1);
});
