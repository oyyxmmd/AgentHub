// Qoder 签名器结构提取自测（issue #119 / #147）
// 运行：node scripts/test-qoder-signer-extract.cjs
// 只测纯函数（pickByStructure / patchText）——不读客户端、不加载 wasm、不联网。
//
// 背景：客户端升级后 obf 的打包结构一变，通用提取就会五缺四（issue #119 的原文）。
// 但真正失配的往往不是「结构彻底变了」，而是引号类型、容器字段数量这类无关语义的细节。
// 本闸用**构造的最小结构**覆盖这些宽容路径，另有一条：本机装了 Qoder 时，
// 对真实 obf 的提取结果必须与基线逐字一致（防止放宽正则反而把已知结构带偏）。
// #147 追加：末尾 worker 启动入口必须被中和——不中和会在 import 时 process.exit（应用闪退）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const signer = require("../electron/backend/proxy/qoderSigner.cjs");

let pass = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", msg);
  } else {
    failed++;
    console.log("  \u2717", msg, got !== undefined ? `→ got ${JSON.stringify(got).slice(0, 200)}` : "");
  }
}

/** 子进程 import 补丁并 initGlue：worker 入口没中和干净，进程会在 1.2s 内 exit */
function smokeImport(patched, tag) {
  const file = path.join(os.tmpdir(), `agenthub-signer-smoke-${tag}-${process.pid}.mjs`);
  fs.writeFileSync(file, patched, "utf8");
  const code = [
    "try {",
    "  const m = await import(process.argv[1]);",
    "  await m.initGlue();",
    "  await new Promise((r) => setTimeout(r, 1200));",
    '  console.log("SIGNER-OK");',
    "  process.exit(0);",
    "} catch (e) {",
    '  console.error("SIGNER-ERR", e && (e.stack || e.message));',
    "  process.exit(8);",
    "}",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, pathToFileURL(file).href], { timeout: 20000, encoding: "utf8" });
  try { fs.unlinkSync(file); } catch { /* 清理失败不影响断言 */ }
  return r;
}

/**
 * 构造一段最小可提取结构。options：
 *   quote    —— wasm 字面量的引号类型（" / ' / `）
 *   longGlue —— 胶水容器里塞 1200 字符冗余字段（旧正则的 [^{}]{0,800} 会失配）
 *   noProfile—— 不写 ProfileEncryptor（旧路径①必失配，只能走 glueVar 反查）
 */
function build(opt) {
  const o = opt || {};
  const q = o.quote || '"';
  const filler = o.longGlue ? "y".repeat(1200) + "," : "";
  const profile = o.noProfile ? "" : "ProfileEncryptor:()=>P1,";
  return [
    `var A1,G1=b(()=>{A1=${q}AGFzbQEAAAA${q}});`,
    `var Z1,X1=b(()=>{er(Z1,{${filler}${profile}QoderContext:()=>C1,default:()=>B1,initSync:()=>I1})});`,
  ].join("\n");
}

console.log("\n[1] 基线结构（双引号 / 有 ProfileEncryptor / 容器短）");
{
  const n = signer.pickByStructure(build());
  ok(n.wasmVar === "A1", "wasmVar 命中", n.wasmVar);
  ok(n.loaderWasm === "G1", "loaderWasm 命中", n.loaderWasm);
  ok(n.glueVar === "Z1", "glueVar 命中", n.glueVar);
  ok(n.loaderGlue === "X1", "loaderGlue 命中", n.loaderGlue);
  ok(n.initAsync === "B1", "initAsync 命中", n.initAsync);
  ok(n.initSync === "I1", "initSync 命中", n.initSync);
  ok(n.profileEnc === "P1", "profileEnc 命中", n.profileEnc);
}

console.log("\n[2] 引号变体：单引号 / 反引号（旧实现只认双引号 → wasmVar 直接失配）");
{
  const a = signer.pickByStructure(build({ quote: "'" }));
  ok(a.wasmVar === "A1", "单引号 wasm 也能取到变量名", a.wasmVar);
  const b = signer.pickByStructure(build({ quote: "`" }));
  ok(b.wasmVar === "A1", "反引号 wasm 也能取到变量名", b.wasmVar);
}

console.log("\n[3] 胶水容器字段变多（旧上限 800 字符 → glueVar 失配）");
{
  const n = signer.pickByStructure(build({ longGlue: true }));
  ok(n.glueVar === "Z1", "容器 1200 字符仍能取到 glueVar", n.glueVar);
  ok(n.initAsync === "B1", "default（async init）也在放宽后的窗口内取到", n.initAsync);
}

console.log("\n[4] ProfileEncryptor 被删/改名（旧路径①失配 → 从 glueVar 反查 loaderGlue）");
{
  const n = signer.pickByStructure(build({ noProfile: true }));
  ok(n.profileEnc === "", "profileEnc 如实为空（没有就是没有）", n.profileEnc);
  ok(n.loaderGlue === "X1", "靠 er(glueVar 反查拿到 loaderGlue", n.loaderGlue);
  ok(n.glueVar === "Z1", "glueVar 不受影响", n.glueVar);
}

console.log("\n[5] 组合最坏情况：单引号 + 长容器 + 无 ProfileEncryptor");
{
  const n = signer.pickByStructure(build({ quote: "'", longGlue: true, noProfile: true }));
  const missing = ["wasmVar", "loaderWasm", "glueVar", "loaderGlue", "initAsync"].filter((k) => !n[k]);
  ok(missing.length === 0, "五项必需特征全部取到（旧实现此处五缺四）", missing);
  // patchText 必须能据此生成完整补丁，而不是抛「结构变化」
  let patched = "";
  try {
    patched = signer.patchText(build({ quote: "'", longGlue: true, noProfile: true }));
  } catch (e) {
    patched = "ERR:" + e.message;
  }
  ok(/export async function initGlue/.test(patched), "patchText 生成 initGlue 导出", patched.slice(-200));
  ok(/export function glue/.test(patched), "patchText 生成 glue 导出", patched.slice(-200));
}

console.log("\n[6] 真的缺特征时，仍如实抛错并带诊断");
{
  let err = null;
  try {
    signer.patchText("这是一段没有任何 wasm-bindgen 特征的文本");
  } catch (e) {
    err = e;
  }
  ok(!!err, "缺特征 → 抛错（不能静默产出坏补丁）");
  ok(err && err.qoderDiag && Array.isArray(err.qoderDiag.missing), "错误上挂了 qoderDiag.missing", err && err.qoderDiag);
  ok(err && /通用提取缺/.test(err.message), "错误消息仍说明缺了什么", err && err.message.slice(0, 120));
}

console.log("\n[7] 末尾 worker 启动入口必须被中和（三种现网收尾形态，issue #147 闪退）");
{
  // 最小可提取结构 + 假 wasm init：只验证「末尾入口被裁掉、模块仍能 import」。
  const base = [
    'var W1="AGFzbQEAAAA";',
    "var G1={ok:1};",
    "function I1(){}",
    "function P1(){}",
    "function S1(){}",
    "var Z1;",
    "function er(a,b){}",
    "er(G1,{ProfileEncryptor:()=>P1,QoderContext:()=>G1,default:()=>I1,initSync:()=>S1});",
  ];
  const shapes = {
    "env": [
      "function parse(){}",
      "function main(){process.exit(1)}",
      "function fail(){}",
      'process.env.QODERCLI_RUNTIME_PACKAGING="worker_mjs",parse(process.argv),main().catch(e=>{fail(e)});',
    ],
    "async-call": [
      "function main(){process.exit(1)}",
      "async function q(){process.env.QODERCLI_RUNTIME_PACKAGING=\"worker_mjs\";try{await main()}catch(e){}}",
      "var SD=()=>{};",
      "SD(),q(async()=>{return {}});",
    ],
    "sites-ternary": [
      "function main(){process.exit(1)}",
      "function runSites(){process.exit(1)}",
      "function j0r(fn){process.env.QODERCLI_RUNTIME_PACKAGING=\"worker_mjs\";return main()}",
      "var AQ=()=>{};",
      'AQ(),"sites"===process.argv[2]?Promise.resolve().then(()=>runSites()):j0r(async()=>{return {}});',
    ],
  };
  for (const [tag, tail] of Object.entries(shapes)) {
    const text = base.concat(tail).join("\n");
    const hit = signer.findWorkerBootstrap(text);
    ok(!!hit && hit.kind === "invocation", `${tag}：能定位末尾启动入口`, hit);
    let patched = "";
    try {
      patched = signer.patchText(text);
    } catch (e) {
      patched = "ERR:" + e.message;
    }
    const leftover = signer.findWorkerBootstrap(patched);
    ok(!leftover || leftover.kind !== "invocation", `${tag}：补丁里不再有会启动 worker 的入口`, leftover);
    const r = smokeImport(patched, tag);
    ok(r.status === 0 && /SIGNER-OK/.test(String(r.stdout || "")), `${tag}：子进程 import + initGlue 后不退出`, { status: r.status, stderr: String(r.stderr || "").slice(-200) });
  }
}

console.log("\n[8] 真实客户端（本机装了才跑）：提取结果必须与基线逐字一致");
{
  const loc = signer.locate("qoder_intl") || signer.locate("qoder");
  if (!loc) {
    console.log("  · 本机未安装 Qoder 客户端，跳过（不影响其它用例）");
  } else {
    const text = fs.readFileSync(loc.obf, "utf8");
    const n = signer.pickByStructure(text);
    const missing = ["wasmVar", "loaderWasm", "glueVar", "loaderGlue", "initAsync"].filter((k) => !n[k]);
    ok(missing.length === 0, `真实 obf（${loc.version} / ${loc.sdk}）五项必需特征齐全`, missing);
    const patched = signer.patchText(text);
    ok(/export async function initGlue/.test(patched) && /export function glue/.test(patched), "真实 obf 能产出完整补丁");
  }
}

console.log(`\n${failed ? "\u2717" : "OK"} Qoder 签名器提取自测：${pass} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
