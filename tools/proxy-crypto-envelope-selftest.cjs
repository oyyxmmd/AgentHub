// 凭据信封回归守卫：enc:v1:（Electron safeStorage）与 enc:v2:（AES-256-GCM，密钥 AGENTHUB_SECRET_KEY）
// 两种前缀的分派、互不误判、AES 往返、密钥不符/缺失时的空值语义，以及落盘往返。
// 目录沙箱运行，绝不触碰真实配置。用法：node tools/proxy-crypto-envelope-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-crypto-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;
process.env.AGENT_SKILLS_HOME = path.join(SANDBOX, "skills");
process.env.AGENTHUB_SECRET_KEY = "selftest-secret-key-please-rotate";

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}

const config = require("../electron/backend/config.cjs");

// —— 安全闸门：任何写盘都必须在沙箱内 ——
const cfgPath = config.configPath();
const inSandbox = path.resolve(cfgPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase());
console.log("=== 安全闸门 ===");
console.log("  沙箱 = " + SANDBOX);
console.log("  配置路径 = " + cfgPath);
if (!inSandbox) {
  console.error("配置路径不在沙箱内，中止！");
  process.exit(2);
}

// A. AES-256-GCM 往返（自测环境无 safeStorage，必须走 enc:v2:）
const SECRET = "sk-verysecret-0123456789";
const cipher = config.encryptSecret(SECRET);
ok("A1 无 safeStorage 时走 enc:v2: 前缀", cipher.startsWith("enc:v2:"), cipher.slice(0, 16));
ok("A2 明文不出现在密文里", !cipher.includes("sk-verysecret"));
ok("A3 解密还原原文", config.decryptSecret(cipher) === SECRET);
ok("A4 幂等：已是密文不重复加密", config.encryptSecret(cipher) === cipher);
ok("A5 同明文两次加密密文不同（nonce 随机）", config.encryptSecret(SECRET) !== cipher);

// B. isEncrypted 判定（store 的敏感 meta 剥离依赖它）
ok("B1 enc:v1: 视为密文", config.isEncrypted("enc:v1:AAAA"));
ok("B2 enc:v2: 视为密文", config.isEncrypted("enc:v2:AAAA"));
ok("B3 明文不误判", !config.isEncrypted("plain-token"));
ok("B4 非字符串不误判", !config.isEncrypted(null) && !config.isEncrypted(123) && !config.isEncrypted(undefined));

// C. 密钥不符 / 缺失：返回空串，交由上层「保留磁盘密文」的保护兜底（issue #95 同语义）
const savedKey = process.env.AGENTHUB_SECRET_KEY;
process.env.AGENTHUB_SECRET_KEY = "another-key-entirely";
ok("C1 换 key 解不开返回空串", config.decryptSecret(cipher) === "");
process.env.AGENTHUB_SECRET_KEY = "";
ok("C2 无 key 解不开返回空串", config.decryptSecret(cipher) === "");
process.env.AGENTHUB_SECRET_KEY = savedKey;

// D. 桌面密文在无 safeStorage 环境解不开（headless 读 DPAPI 密文 → 空串，绝不误当明文）
ok("D1 enc:v1: 在无 safeStorage 环境返回空串", config.decryptSecret("enc:v1:AAAA") === "");

// E. 明文透传（历史降级环境写下的数据读兼容）
ok("E1 无前缀明文原样返回", config.decryptSecret("legacy-plain") === "legacy-plain");
ok("E2 空值边界", config.encryptSecret("") === "" && config.decryptSecret("") === "" && config.encryptSecret(null) === "");

// F. 落盘往返：saveConfig 加密落盘 → loadSharedWebdav 解回明文
const DAV_PASS = "dav-pass-123456";
const cfg = config.defaultConfig();
cfg.webdavShared = Object.assign({}, cfg.webdavShared, {
  endpoint: "https://dav.example.com/dav",
  username: "tester",
  password: DAV_PASS,
});
config.saveConfig(cfg, { forceClearSharedSecrets: true });
const raw = JSON.parse(fs.readFileSync(config.configPath(), "utf8"));
ok("F1 磁盘上是 enc:v2: 密文", String(raw.webdavShared.password).startsWith("enc:v2:"), String(raw.webdavShared.password).slice(0, 16));
ok("F2 磁盘密文不含明文口令", !String(raw.webdavShared.password).includes(DAV_PASS));
ok("F3 loadSharedWebdav 解回明文", config.loadSharedWebdav().password === DAV_PASS);

// G. 密钥轮换语义：旧 key 密文在新 key 下解不开（不可恢复），文档化的恢复路径是号池重新同步
process.env.AGENTHUB_SECRET_KEY = "rotated-key-999";
ok("G1 轮换后旧密文解不开（预期，恢复靠重新同步）", config.decryptSecret(cipher) === "");
process.env.AGENTHUB_SECRET_KEY = savedKey;

console.log("");
console.log(`RESULT: ${pass} passed / ${fail} failed`);
if (bad.length) { console.log("失败项："); for (const b of bad) console.log("  - " + b); }
process.exit(fail ? 1 : 0);
