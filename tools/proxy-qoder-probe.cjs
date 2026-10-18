// 反代网关 · Qoder 签名器结构取证（issue #119 取证工具）
// 用法：node tools/proxy-qoder-probe.cjs [qoder|qoder_intl] [--json]
//      不传产品名则两个都探；--json 输出机器可读结果（便于整段回传）。
//
// 只读：不加载 wasm、不写缓存、不联网。用来定位「Qoder 签名器不可用」到底是哪一类：
//   · 入口标记还在 → 走截断路径，通用提取根本没被用到；
//   · 入口标记没了、但内嵌 wasm 还在 → 结构变了，放宽特征正则有机会救；
//   · 内嵌 wasm 也没了 → 客户端把 wasm 拆成外链文件，要新增一条读取路径（不是调正则的事）。
//
// 客户端未安装、或装在了非默认路径时，可用环境变量直接指定 resources 目录：
//   AGENTHUB_QODER_RESOURCES / AGENTHUB_QODER_INTL_RESOURCES
"use strict";

const SIGNER = "../electron/backend/proxy/qoderSigner.cjs";
const INSTALL = "../electron/backend/proxy/qoderInstall.cjs";

const ok = (b) => (b ? "✓" : "✗");
const num = (n) => Number(n || 0).toLocaleString("en-US");

function printProbe(r, label) {
  const line = "=".repeat(68);
  console.log(line);
  console.log(`产品: ${r.product}${label ? `（${label}）` : ""}`);
  console.log("-".repeat(68));
  if (!r.installed) {
    console.log(`  ✗ ${r.message}`);
    return;
  }
  console.log(`  客户端版本 : ${r.version}`);
  console.log(`  SDK 目录   : ${r.sdk}`);
  console.log(`  obf 路径   : ${r.obf}`);
  console.log(`  obf 体积   : ${num(r.obfSize)} B   (mtime ${r.obfMtime})`);
  console.log(`  入口标记   : ${ok(r.entryMark.hit)} ${r.entryMark.hit ? "命中" : "未命中"}   "${r.entryMark.mark}"${r.entryMark.hit ? ` @ offset ${r.entryMark.offset}` : ""}`);
  console.log(`  内嵌 wasm  : ${ok(r.inlineWasm.hit)} ${r.inlineWasm.hit ? "在" : "不在"}     "${r.inlineWasm.magic}"${r.inlineWasm.hit ? ` @ offset ${r.inlineWasm.offset}` : ""}`);
  console.log(`  提取路径   : ${r.path}`);
  console.log("");
  console.log("  结构特征:");
  for (const k of ["wasmVar", "loaderWasm", "glueVar", "loaderGlue", "initAsync", "profileEnc", "initSync"]) {
    const v = r.features[k];
    console.log(`    ${ok(v)} ${k.padEnd(13)} ${v || "(未命中)"}`);
  }
  console.log(`    缺失(必需): ${r.missing.length ? r.missing.join(", ") : "无"}`);

  const sn = r.snippets || {};
  const hasSnip = Object.values(sn).some(Boolean);
  if (hasSnip) {
    console.log("");
    console.log("  诊断片段（客户端混淆代码，不含用户数据；回传时整段带上）:");
    for (const [k, v] of Object.entries(sn)) {
      if (!v) continue;
      console.log(`    [${k}]`);
      console.log(`      ${v.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
}

function main() {
  const signer = require(SIGNER);
  const install = require(INSTALL);
  const products = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const list = products.length ? products : ["qoder", "qoder_intl"];
  const asJson = process.argv.includes("--json");

  const results = list.map((p) => signer.probe(p));

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log("");
  for (const r of results) {
    printProbe(r, install.EXE_LABELS[r.product]);
    console.log("");
  }
  console.log("提示：本脚本只读，未加载 wasm、未写缓存、未联网。");
  console.log("若某项显示「客户端未安装」，而你确认装过，请把安装路径告诉我，或用");
  console.log("AGENTHUB_QODER_RESOURCES / AGENTHUB_QODER_INTL_RESOURCES 指向它的 resources 目录后重跑。");
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("取证失败：", (e && e.stack) || e);
  process.exit(1);
}
