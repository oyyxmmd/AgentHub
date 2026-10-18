// 反代网关 · Qoder 客户端安装定位（qoder / qoder_intl 共用）
//
// Windows 下的安装形态（全部实测于本机）：
//   ① 默认安装：%LOCALAPPDATA%\Programs\<exeLabel>\resources
//   ② 启动器（launcher）形态：应用本体在版本目录里，如
//      %LOCALAPPDATA%\Qoder\Qoder Launcher\state.ini
//        [launcher] installDir=E:\Qoder   appExecutable=.qoder-versions\0.3.3\Qoder.exe
//      → resources = <installDir>\.qoder-versions\0.3.3\resources
//      （state.ini 为 UTF-16LE；install.ini 是旧字段/兜底）
//   ③ 解包直装：%LOCALAPPDATA%\<exeLabel>\resources
//   ④ 注册表兜底（自定义安装路径、无 launcher）：Uninstall 项 DisplayIcon / InstallLocation
//
// macOS（.app bundle，路径与形态都不同，另立一族——本机实测 2026-10-18）：
//   ⑤ 国际版：/Applications/Qoder.app/Contents/Resources
//        ├─ app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/...  ← wasm 签名器
//        └─ umid/runtime-info                                        ← 风控身份（无 .exe 后缀）
//   ⑥ 国内版：/Applications/Qoder CN IDE.app/Contents/Resources
//        └─ app/resources/bin/<arch>_darwin/QoderCN                 ← 风控身份走子命令
//             （CN 版无 umid/ 目录、也无 app.asar.unpacked——它把运行时放在 app/node_modules，
//               因此 CN 的命中判据不能沿用国际版的 app.asar.unpacked）
//
// 硬编码单一路径会在 launcher/自定义路径/macOS 上失明——wasm 签名器与风控身份
// 都依赖本模块，定位失败即该渠道不可调用。找到即缓存；全部失败返回 null（不缓存失败：
// 用户装完客户端后无需重启 AgentHub）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** 产品 → exeLabel（安装目录名，与 qoderAuth.PRODUCTS 共用同一份事实源） */
const EXE_LABELS = { qoder: "Qoder CN", qoder_intl: "Qoder" };
/** 产品 → 环境变量覆盖键（调试/测试用：直接指定 resources 目录） */
const ENV_KEYS = { qoder: "AGENTHUB_QODER_RESOURCES", qoder_intl: "AGENTHUB_QODER_INTL_RESOURCES" };
/** 产品 → macOS .app 名（CN 的安装名与 Windows 目录名不同：Qoder CN IDE.app） */
const MAC_APP_NAMES = { qoder: "Qoder CN IDE.app", qoder_intl: "Qoder.app" };

const cache = new Map(); // product -> resources 绝对路径

function isMac() {
  return process.platform === "darwin";
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

/** 解析启动器 ini（UTF-16LE（带 BOM）或 UTF-8 均可读）→ { installDir, appExecutable } */
function readLauncherIni(file) {
  let text = "";
  try {
    const buf = fs.readFileSync(file);
    const isUtf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf.length > 3 && buf[1] === 0x00 && buf[3] === 0x00);
    text = buf.toString(isUtf16 ? "utf16le" : "utf8");
  } catch {
    return null;
  }
  const pick = (k) => {
    const m = text.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, "m"));
    return m ? m[1].trim() : "";
  };
  const installDir = pick("installDir");
  if (!installDir) return null;
  return { installDir, appExecutable: pick("appExecutable") };
}

/** 目录名是否属于该产品：CN 与 INTL 是两套并行安装，不能互相命中 */
function sameProductDir(dirName, exeLabel) {
  if (!/qoder/i.test(dirName)) return false;
  const wantCn = /\bCN\b/i.test(exeLabel);
  const isCn = /\bCN\b/i.test(dirName) || /中国/i.test(dirName);
  return wantCn === isCn;
}

/** launcher 形态候选：扫 %LOCALAPPDATA% 下属于该产品的目录里的 *Launcher*（不猜死目录名） */
function launcherResources(exeLabel) {
  const local = localAppData();
  const out = [];
  let subs = [];
  try {
    subs = fs.readdirSync(local);
  } catch {
    return out;
  }
  for (const sub of subs) {
    if (!sameProductDir(sub, exeLabel)) continue;
    const base = path.join(local, sub);
    let inners = [];
    try {
      inners = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const inner of inners) {
      if (!/launcher/i.test(inner)) continue;
      const dir = path.join(base, inner);
      const st = readLauncherIni(path.join(dir, "state.ini")) || readLauncherIni(path.join(dir, "install.ini"));
      if (!st) continue;
      const appDir = st.appExecutable ? path.join(st.installDir, path.dirname(st.appExecutable)) : st.installDir;
      out.push(path.join(appDir, "resources"));
      if (appDir !== st.installDir) out.push(path.join(st.installDir, "resources")); // 版本目录已清时的兜底
    }
  }
  return out;
}

/** 注册表块的解析结果（一次查询两产品复用；reg.exe 单次 ~100ms，避免每个候选重复跑） */
let regBlocks = null;
function queryRegBlocks() {
  if (regBlocks) return regBlocks;
  const roots = [
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const blocks = [];
  for (const root of roots) {
    let txt = "";
    try {
      txt = execFileSync("reg.exe", ["query", root, "/s", "/f", "Qoder", "/d"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1 << 20,
      });
    } catch {
      continue; // 无匹配（reg 退出码 1）或平台不支持
    }
    for (const block of txt.split(/\r?\n\r?\n/)) {
      const name = (block.match(/DisplayName\s+REG_SZ\s+(.+)/i) || [])[1] || "";
      if (!/qoder/i.test(name)) continue;
      const icon = (block.match(/DisplayIcon\s+REG_SZ\s+(.+)/i) || [])[1] || "";
      const loc = (block.match(/InstallLocation\s+REG_SZ\s+(.+)/i) || [])[1] || "";
      const iconDir = icon ? path.dirname(icon.replace(/,+\d+$/, "").replace(/^"|"$/g, "")) : "";
      blocks.push({ name, iconDir, loc });
    }
  }
  regBlocks = blocks;
  return blocks;
}

/** 注册表兜底：Uninstall 项的 DisplayIcon / InstallLocation（仅在前述候选全失败时调用） */
function registryResources(exeLabel) {
  const wantCn = /\bCN\b/i.test(exeLabel);
  const out = [];
  for (const b of queryRegBlocks()) {
    // Qoder CN 与 Qoder 是两套安装：DisplayName 归属要分清
    const isCn = /\bCN\b/i.test(b.name) || /中国/i.test(b.name);
    if (wantCn !== isCn) continue;
    if (b.loc) out.push(path.join(b.loc, "resources"));
    if (b.iconDir) out.push(path.join(b.iconDir, "resources"));
  }
  return out;
}

/** 常规候选（文件系统直查，零外部进程）：环境变量覆盖 → 默认安装 → 解包直装 → launcher */
function fastCandidates(product) {
  const exeLabel = EXE_LABELS[product];
  if (!exeLabel) return [];
  const env = ENV_KEYS[product] && process.env[ENV_KEYS[product]];
  // macOS 与 Windows 安装形态完全不同，分开成候选（Windows 那套在此机器上必然全部落空）
  if (isMac()) return [...new Set([env, ...macCandidates(product)].filter(Boolean))];
  const local = localAppData();
  const out = [];
  if (env) out.push(env);
  out.push(path.join(local, "Programs", exeLabel, "resources"));
  out.push(path.join(local, exeLabel, "resources"));
  out.push(...launcherResources(exeLabel));
  return [...new Set(out.filter(Boolean))];
}

/**
 * 注册表兜底候选。**惰性**：只在常规候选全部未命中时才调用——
 * 每次定位都跑 reg.exe（3 个根，~100ms/次）纯属浪费，且在被沙箱/安全软件禁 reg 的
 * 环境下会让整个定位链路失败（本函数注释原本就写着「仅在前述候选全失败时调用」，
 * 但调用方此前无条件执行，实现与注释不符）。
 */
function registryCandidates(product) {
  const exeLabel = EXE_LABELS[product];
  if (!exeLabel) return [];
  return [...new Set(registryResources(exeLabel).filter(Boolean))];
}

/** 在候选列表里找第一个「像客户端 resources」的目录；命中即写缓存。
 *  命中判据分平台：Windows 看 app.asar.unpacked；macOS 看风控身份生成器或 SDK 目录
 *  （CN 版把运行时放在 app/node_modules，既无 app.asar.unpacked 也无 umid/，只认前者会永远失明） */
function firstHit(product, list) {
  for (const c of list) {
    try {
      if (!fs.existsSync(c)) continue;
      if (isMac()) {
        // macOS：任一可用于本产品的运行时标记存在即算命中
        if (
          existsUnder(c, "umid", "runtime-info") ||                 // 国际版风控身份
          existsUnder(c, "umid", "runtime-info.exe") ||
          existsUnder(c, "app.asar.unpacked") ||                     // 国际版 wasm 签名器
          existsUnder(c, "app", "resources", "bin") ||                // CN 版原生二进制目录
          existsUnder(c, "app", "node_modules")
        ) {
          cache.set(product, c);
          return c;
        }
      } else if (fs.existsSync(path.join(c, "app.asar.unpacked"))) {
        cache.set(product, c);
        return c;
      }
    } catch {
      /* 单个候选异常不阻断后续 */
    }
  }
  return null;
}

function existsUnder(base, ...segs) {
  try {
    return fs.existsSync(path.join(base, ...segs));
  } catch {
    return false;
  }
}

/**
 * 定位某产品的 resources 目录（判据见 firstHit）。
 * 成功缓存；失败返回 null 且不缓存（装完客户端无需重启）。
 */
function findResources(product) {
  const hit = cache.get(product);
  if (hit && fs.existsSync(hit)) return hit;
  return firstHit(product, fastCandidates(product)) || firstHit(product, registryCandidates(product));
}

/**
 * macOS 候选：.app bundle 的 Contents/Resources。
 * 常规安装位 + 用户 Applications（自装/非 root 安装），CN 与国际版按 MAC_APP_NAMES 区分。
 */
function macCandidates(product) {
  const appName = MAC_APP_NAMES[product];
  if (!appName) return [];
  const out = [];
  for (const root of ["/Applications", path.join(os.homedir(), "Applications")]) {
    out.push(path.join(root, appName, "Contents", "Resources"));
  }
  return [...new Set(out.filter(Boolean))];
}

/** CN 版 macOS：resources/app/resources/bin/<arch>_darwin 下的主二进制（风控身份走它的 machine-info 子命令） */
function macCnBinary(res) {
  const binRoot = path.join(res, "app", "resources", "bin");
  let dirs = [];
  try {
    dirs = fs.readdirSync(binRoot);
  } catch {
    return "";
  }
  // 目录名形如 aarch64_darwin / x64_darwin；按当前架构优先，再退回任意 darwin 目录
  const arch = process.arch === "arm64" ? "aarch64_darwin" : "x64_darwin";
  const ordered = [arch, ...dirs.filter((d) => /darwin/i.test(d))];
  for (const d of [...new Set(ordered)]) {
    const p = path.join(binRoot, d, "QoderCN");
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 忽略 */ }
  }
  return "";
}

/**
 * 风控身份生成器（领取接口必需，见 qoderAuth.readRiskIdentity）。
 * 返回 { bin, args, stdin }：三平台两种调用形态——
 *   Windows：resources\umid\runtime-info.exe  --account-stdin（stdin 传 uid）
 *   macOS 国际版：resources\umid\runtime-info        --account-stdin（同上，去掉 .exe 后缀）
 *   macOS 国内版：resources\app\resources\bin\<arch>_darwin\QoderCN  machine-info
 *             （无 --account-stdin；账号用 -u <uid> 传，缺省不带参数即可出机器级身份）
 * 返回空串表示本机没有可用的生成器。
 */
function riskIdentityRunner(product) {
  const res = findResources(product);
  if (!res) return null;
  if (!isMac()) {
    const exe = path.join(res, "umid", "runtime-info.exe");
    try {
      if (fs.existsSync(exe)) return { bin: exe, args: ["--account-stdin"], stdin: true, kind: "runtime-info" };
    } catch { /* 忽略 */ }
    return null;
  }
  // macOS 国际版：umid/runtime-info（无扩展名）
  for (const name of ["runtime-info", "runtime-info.exe"]) {
    const p = path.join(res, "umid", name);
    try {
      if (fs.existsSync(p)) return { bin: p, args: ["--account-stdin"], stdin: true, kind: "runtime-info" };
    } catch { /* 忽略 */ }
  }
  // macOS 国内版：QoderCN machine-info 子命令
  if (product === "qoder") {
    const bin = macCnBinary(res);
    if (bin) return { bin, args: ["machine-info"], stdin: false, kind: "machine-info" };
  }
  return null;
}

/** 兼容旧调用点（Windows 单 exe 路径）：返回可执行文件路径，无则空串 */
function runtimeInfoPath(product) {
  const r = riskIdentityRunner(product);
  return r ? r.bin : "";
}

/** 清缓存（自测用：安装目录是探测结果，测试要能重放） */
function clearCache() {
  cache.clear();
  regBlocks = null;
}

module.exports = { EXE_LABELS, ENV_KEYS, findResources, runtimeInfoPath, riskIdentityRunner, isMac, macCandidates, macCnBinary, clearCache, readLauncherIni, sameProductDir, queryRegBlocks, localAppData };
