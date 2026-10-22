// 自定义提供商 · 渲染层接线闸
//
// 为什么单独一条闸：这一段的产物主要是「接线」——一条 IPC 命令、一张词表、一个页签。
// 三处漂移的共同表现都不是报错而是静默：白名单漏登记 → 界面卡在加载态；档位词表漂了 →
// 思考档位下拉与实际降级不一致；页签没进 MODULES → 页面永远进不去。类型检查抓不到任何一条。
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
let failed = 0;
function ok(cond, name, got) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}` + (got === undefined ? "" : ` → got ${JSON.stringify(got).slice(0, 260)}`));
  }
}

const PROVIDER_CMDS = [
  "proxy_provider_list",
  "proxy_provider_create",
  "proxy_provider_update",
  "proxy_provider_delete",
  "proxy_provider_add_key",
  "proxy_provider_remove_key",
  "proxy_provider_test",
  "proxy_provider_fetch_models",
  "proxy_provider_balance",
];

// ===== ① IPC 三面一致：渲染层调用名 ⊆ preload 白名单，且每条都有主进程注册 =====
console.log("① IPC 三面一致（漏一处表现为界面假死，不是报错）");
{
  const preload = read("electron/preload.cjs");
  const allow = new Set([...preload.matchAll(/^\s+"([a-z0-9_]+)",/gm)].map((m) => m[1]));
  const ipc = read("src/api/ipc.ts");
  const index = read("electron/backend/proxy/index.cjs");
  const registered = new Set([...index.matchAll(/ipcMain\.handle\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
  const called = new Set([...ipc.matchAll(/"(proxy_provider_[a-z_]+)"/g)].map((m) => m[1]));

  ok([...PROVIDER_CMDS].every((c) => called.has(c)), "渲染层把九条命令都封了函数", PROVIDER_CMDS.filter((c) => !called.has(c)));
  const missAllow = PROVIDER_CMDS.filter((c) => !allow.has(c));
  ok(missAllow.length === 0, "九条命令都在 preload 白名单里（漏登记＝「未授权的 IPC 命令」）", missAllow);
  const missReg = PROVIDER_CMDS.filter((c) => !registered.has(c));
  ok(missReg.length === 0, "九条命令都在主进程注册了", missReg);
  ok(called.size === PROVIDER_CMDS.length, "渲染层没有第十条 provider 命令（新增必须同步登记两处）", [...called]);

  // 拉取合并的元数据语义：已存在行只填空缺、不覆盖用户手填值；这是「上下文自动匹配」的落点，
  // 判据必须钉在视图源码上——后端富化有自测守，前端这层静默丢元数据不会有任何报错。
  const providersView = read("src/views/proxy/ProxyProvidersView.vue");
  ok(/upstreamMeta/.test(providersView), "视图保存了拉取返回的模型元数据（models.dev 补的上下文靠它落进表格）", "upstreamMeta");
  ok(/if \(!Number\(r\.contextLength\) && meta\.contextLength\)/.test(providersView),
    "已存在行只在上下文为空时补齐，不覆盖用户手填值");
  ok(/if \(!Number\(r\.maxOutputTokens\) && meta\.maxOutputTokens\)/.test(providersView),
    "输出上限同样只填空缺");
  ok(/v-model="m\.proxyModel"/.test(providersView), "代理模型名输入框在模型清单每一行，不在供应商表单上");
  ok(!/v-model="form\.proxyModel"/.test(providersView), "旧供应商级代理名输入框已移除");
  ok(/out\.proxyModel = r\.proxyModel\.trim\(\)/.test(providersView), "保存模型行时把代理名写进 models[]");

  // 装置自证：把一条不存在的命令塞进判据，必须被抓出来——否则上面几条绿得没有意义
  const fakeCheck = ["proxy_provider_list", "proxy_provider_zzz"].filter((c) => !allow.has(c));
  ok(fakeCheck.length === 1 && fakeCheck[0] === "proxy_provider_zzz", "漏登记的探测本身是有效的（能认出编造的命令）", fakeCheck);
}

// ===== ② 思考档位词表与后端同源（顺序也要一致：下拉按序展示） =====
console.log("\n② 档位词表同源（前端写死的那张表 vs util.EFFORT_RANK）");
{
  const view = read("src/views/proxy/ProxyProvidersView.vue");
  const m = view.match(/const EFFORT_LEVELS = \[([^\]]*)\]/);
  const ui = m ? m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : null;
  const back = require(path.join(ROOT, "electron/backend/proxy/util.cjs")).EFFORT_LEVELS;
  ok(!!ui, "视图里能找到 EFFORT_LEVELS 常量（改名了就要同步改这条闸）", ui);
  ok(JSON.stringify(ui) === JSON.stringify(back), "前端档位表与后端逐字同序（漂移的表现是选了某档却被静默降级）", [ui, back]);
  ok(JSON.stringify(ui) !== JSON.stringify(back.slice(0, 5)), "同序判据不是恒真（截短一档必须不等）");
}

// ===== ③ 协议形态值集合与后端 KINDS 同源 =====
console.log("\n③ 上游协议形态值集合（types 与 provider.cjs 必须同一份）");
{
  const types = read("src/types/index.ts");
  const tm = types.match(/^export type ProxyProviderKind = ([^;]+);/m);
  const uiKinds = tm ? [...tm[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : null;
  const src = read("electron/backend/proxy/provider.cjs");
  const km = src.match(/^const KINDS = new Set\[?\(?\[(.*?)\]\)?;?$/m);
  const backKinds = km ? [...km[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : null;
  ok(!!uiKinds, "types 里能解析出 ProxyProviderKind", uiKinds);
  ok(!!backKinds, "provider.cjs 里能解析出 KINDS", backKinds);
  ok(
    !!uiKinds && !!backKinds && uiKinds.slice().sort().join() === backKinds.slice().sort().join(),
    "两侧值集合完全相同（前端多一档会存下后端拒收的 kind，后端多一档前端选不到）",
    [uiKinds, backKinds],
  );
}

// ===== ④ 页面可达：MODULES 页签 + App.vue 挂载三处都对得上 =====
console.log("\n④ 页面可达（页签注册 + 挂载，缺一处就是进不去或白屏）");
{
  const types = read("src/types/index.ts");
  // 作用域切到 proxy 模块那段 pages 数组：全文正则会撞上别的模块的同名 id，切不到即判红
  const pm = types.match(/key:\s*"proxy",[\s\S]*?pages:\s*\[([\s\S]*?)\]/);
  ok(!!pm, "能在 MODULES 里定位到反代网关模块的 pages 数组", pm && pm[1].slice(0, 60));
  const ids = pm ? [...pm[1].matchAll(/\{\s*id:\s*"([a-z]+)"/g)].map((x) => x[1]) : [];
  ok(ids.includes("providers"), "proxy 页签里含 providers", ids);
  ok(pm[1].includes('id: "providers", name: "自定义提供商"'), "页签有中文名（没 name 会渲染成空按钮）", pm && pm[1]);

  const app = read("src/App.vue");
  ok(/import\s+ProxyProvidersView\s+from\s+"\.\/views\/proxy\/ProxyProvidersView\.vue"/.test(app), "App.vue 引了该视图");
  const block = app.match(/<ProxyProvidersView[^>]*\/>/);
  ok(!!block, "App.vue 里有该视图的挂载块", block && block[0]);
  const b = block ? block[0] : "";
  ok(
    /v-if="seen\('proxy', 'providers'\)"/.test(b) && /v-show="on\('proxy', 'providers'\)"/.test(b) && /'page-anim': on\('proxy', 'providers'\)/.test(b),
    "挂载块三处页签名一致（v-if 拼错＝永不挂载，v-show 拼错＝永远不显示）",
    b,
  );
}

// ===== ⑤ Key 列表的数据源：号池视图不含提供商，照 fork 写法会拿到空表 =====
console.log("\n⑤ 「Key 管理」的取数路径");
{
  const view = read("src/views/proxy/ProxyProvidersView.vue");
  ok(!/api\.proxyPool\(\)/.test(view), "视图不调 proxyPool（那条视图按内置 CHANNELS 迭代，提供商恒不在其中）", view.match(/api\.proxyPool\(\)/g));
  ok(/\.keys\b/.test(view), "视图从 proxy_provider_list 的 keys 字段取 Key 列表");
  const provider = read("electron/backend/proxy/provider.cjs");
  ok(/keys,/.test(provider) && /pool\.poolAccounts\(p\.id\)/.test(provider), "后端 list() 确实带上了 keys（与号池同一个脱敏视图）");
}

// ===== ⑥ 内置优先开关：面板、类型、默认值与落盘调用必须同名同义 =====
console.log("\n⑥ 内置优先开关的接线与默认值");
{
  const view = read("src/views/proxy/ProxyProvidersView.vue");
  ok(/app\.config\.proxy\.preferBuiltin/.test(view), "面板绑定 preferBuiltin（不能用另一个同义词代替）");
  ok(/setPreferBuiltin\(!app\.config\.proxy\.preferBuiltin\)/.test(view), "开关点击只翻转当前值");
  // 落盘通路：走独立 IPC（proxy_prefer_builtin_set）而不是整份配置保存。
  // 原因：这个字段的写入口有两处（本页面 + 托盘面板），两边各持配置快照；
  // 走整份提交时后保存的一方会用旧快照把先保存的一方冲掉（开关「自己弹回来」）。
  ok(/api\.proxyPreferBuiltinSet\(/.test(view), "开关走独立 IPC 落盘（只改内存会在重启时丢）");
  ok(!/await app\.save\(\)/.test(view), "开关不走整份配置保存（那会被另一处的旧快照冲掉）");
  ok(/if \(r && r\.ok === false\) app\.config\.proxy\.preferBuiltin = old/.test(view), "保存失败回滚开关，不留下假的已开启状态");
  ok(/显式[\s\S]{0,40}标识\/模型名[\s\S]{0,40}始终直达/.test(view), "面板明确说明显式前缀不受偏好影响");
  const config = read("electron/backend/config.cjs");
  const types = read("src/types/index.ts");
  const store = read("src/stores/app.ts");
  const mock = read("src/api/mock.ts");
  ok(/preferBuiltin:\s*false/.test(config) && /allowBareProviderModel:\s*true/.test(config), "后端默认值：内置优先关、旧裸名兜底保持开");
  ok(/preferBuiltin:\s*boolean/.test(types) && /allowBareProviderModel:\s*boolean/.test(types), "ProxyConfig 声明两个字段");
  ok(/preferBuiltin:\s*false/.test(store) && /allowBareProviderModel:\s*true/.test(store), "Pinia 默认值跟后端一致");
  ok(/preferBuiltin:\s*false/.test(mock) && /allowBareProviderModel:\s*true/.test(mock), "浏览器 mock 默认值同步，避免预览态行为漂移");
}

// ===== ⑦ 默认思考强度的档位词表：前端与后端必须同一份 =====
// 前端抄一份字面量的后果是"界面能选、后端判非法后静默丢弃"，这类分叉不会报错，只会不生效。
console.log("\n⑦ 默认思考强度的档位词表");
{
  const view = read("src/views/proxy/ProxyCcSwitchView.vue");
  const util = read("electron/backend/proxy/util.cjs");
  const fe = /const CLIENT_EFFORTS = \[([^\]]*)\]/.exec(view);
  const be = /const CLIENT_EFFORT_LEVELS = \[([^\]]*)\]/.exec(util);
  ok(!!fe && !!be, "两侧都能解析出档位数组", [fe && fe[1], be && be[1]]);
  const norm = (s) => String(s || "").split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  ok(JSON.stringify(norm(fe && fe[1])) === JSON.stringify(norm(be && be[1])),
    "前端可选档与后端词表完全一致（多一档＝选得到但写不进去）", [norm(fe && fe[1]), norm(be && be[1])]);
  ok(/CLAUDE_CODE_EFFORT_LEVEL/.test(read("electron/backend/proxy/direct.cjs")), "Claude Code 侧确实写 CLAUDE_CODE_EFFORT_LEVEL");
  ok(/default_reasoning_level/.test(read("electron/backend/proxy/direct.cjs")), "Codex 侧确实写 default_reasoning_level");
  ok(/model_reasoning_effort/.test(read("electron/backend/proxy/ccswitch.cjs")), "CC Switch 侧确实写 model_reasoning_effort");
}

// ===== ⑧ 内置优先开关的托盘接入 =====
// 这个开关的写入口有两处（主窗口「自定义提供商」页 + 托盘状态栏面板），两边各持配置快照。
// 三处漏登记的共同表现都是「静默不生效」而不是报错：preload 漏登记＝未授权的 IPC 命令、
// 主进程漏注册＝invoke reject、配置保护名单漏登记＝另一处的整份保存把改动冲回去。
console.log("\n⑧ 内置优先的托盘接入与写入通路");
{
  const CMD = "proxy_prefer_builtin_set";
  const preload = read("electron/preload.cjs");
  const allow = new Set([...preload.matchAll(/^\s+"([a-z0-9_]+)",/gm)].map((m) => m[1]));
  const index = read("electron/backend/proxy/index.cjs");
  const registered = new Set([...index.matchAll(/ipcMain\.handle\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
  const ipc = read("src/api/ipc.ts");
  const mock = read("src/api/mock.ts");
  const tray = read("src/tray/TrayPanel.vue");
  const config = read("electron/backend/config.cjs");

  ok(allow.has(CMD), "命令在 preload 白名单里（漏登记＝「未授权的 IPC 命令」）", [...allow].filter((c) => c.includes("prefer")));
  ok(registered.has(CMD), "命令在主进程注册了");
  ok(new RegExp(`"${CMD}"`).test(ipc), "前端封了调用函数（api/ipc.ts）");
  ok(new RegExp(`case "${CMD}"`).test(mock), "浏览器 mock 有对应分支（预览态不能退化成「未检测到后端」）");

  // 托盘面板：读状态 + 写切换，两处都要在
  ok(/loadConfig\(\)/.test(tray), "托盘读配置拿开关状态");
  ok(/proxy\.preferBuiltin\s*===\s*true/.test(tray), "托盘按 proxy.preferBuiltin 判定开/关");
  ok(/proxyPreferBuiltinSet\(/.test(tray), "托盘写切换走同一个 IPC");
  ok(/preferBuiltin\.value\s*=\s*old/.test(tray), "写入失败回滚，不留下假的已开启状态");
  ok(/内置渠道启用/.test(tray) || /内置优先/.test(tray), "托盘面板有该开关的标题");
  ok(/内置优先/.test(tray) && /仅自定义/.test(tray), "两种状态都有明确文案（用户能看出当前是哪种）");

  // 配置保护名单：这个字段的写权归独立 IPC，整份保存不得回冲
  const oob = /const OUT_OF_BAND_PROXY_FIELDS = \[([^\]]*)\]/.exec(config);
  ok(!!oob && /"preferBuiltin"/.test(oob[1]), "preferBuiltin 在 out-of-band 保护名单里（否则整份保存会把它冲回去）", oob && oob[1]);

  // 主窗口也必须改走同一个 IPC——否则它自己的 app.save() 会被保护名单回冲成磁盘值，开关失效
  const view = read("src/views/proxy/ProxyProvidersView.vue");
  ok(/api\.proxyPreferBuiltinSet\(/.test(view), "主窗口开关走同一个 IPC（与托盘共用一份磁盘值）");

  // 装置自证：判据不是恒真——把一条不存在的命令塞进去必须被抓出来
  const fake = allow.has("proxy_prefer_provider_zzz");
  ok(fake === false, "白名单判据能认出编造的命令", fake);
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
