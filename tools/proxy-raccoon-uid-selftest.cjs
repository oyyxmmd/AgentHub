// 小浣熊账号 ID（uid）解析自测：JWT 里到底该取哪个 claim
//
// 背景（2026-10-14 用**真实 token** 解出 claim 核实）：
//   小浣熊 access/refresh JWT 的 payload：
//     iss = "xiaohuanxiong.com/iam"      ← **签发方**，对所有账号都是同一个常量，**不是**账号 ID
//     sub = "pu-00000000-0000-0000-…"    ← **账号 ID**（每个账号稳定且唯一）—— 要的是它
//     sid = "ses-00000000-…"             ← 登录**会话** ID，每次登录都变
//     jti = "ak-00000000-…"              ← 本次 token 的 ID
//   而 tokenUid 原先取 `iss || sid`，两个都错且各错一个方向：
//     · 取 iss ⇒ 所有账号 uid 相同 ⇒ discovery 的 find(a => a.uid === uid) 恒命中「已存在」
//       ⇒ **号池里加不进第二个小浣熊号**（每次登录只更新既有那条，不新增）
//     · 取 sid ⇒ 每次登录都变 ⇒ 每次都新增一条（用户得手动删）
//   跨机更糟：号池合并键是 channel:uid ⇒ 不同机器上的不同账号 uid 全同
//   ⇒ 被当成同一个账号互相覆盖凭据 ⇒ **多机掉登录**。
//
// 跑法（与其它自测一致，需 Electron 的 Node）：
//   ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/electron.exe" tools/proxy-raccoon-uid-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

// 沙箱：绝不碰真实号池与真实配置
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "raccoon-uid-selftest-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;
process.env.APPDATA = SANDBOX;

const ROOT = path.join(__dirname, "..");
const raccoonAuth = require(path.join(ROOT, "electron/backend/proxy/raccoonAuth.cjs"));

// ---- 造一个像真小浣熊那样的 JWT（三段，payload 带 iss/sub/sid/jti）----
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (payload) => [b64u({ alg: "RS256", typ: "JWT" }), b64u(payload), "signature"].join(".");
const RACCOON_ISS = "xiaohuanxiong.com/iam";
const tokenFor = (sub, sid) => jwt({ sid, ver: 0, iss: RACCOON_ISS, sub, aud: ["xiaohuanxiong.com"], exp: 1794578621, nbf: 1791986616, iat: 1791986621, jti: "ak-" + sid.slice(4) });

// 旧实现（照抄改前的代码），用于反向对照：证明旧行为确实是坏的
const oldTokenUid = (token) => {
  const p = String(token || "").trim().split(".");
  if (p.length < 2) return "";
  const payload = JSON.parse(Buffer.from(p[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  return String((payload && (payload.iss || payload.sid)) || "");
};

let pass = 0, fail = 0;
const cases = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; cases.push(name); console.log("  FAIL " + name + (detail ? "  <- " + detail : "")); } };

console.log("\n=== T1 取账号 ID（sub），不是签发方（iss）也不是会话（sid）===");
{
  const A = tokenFor("pu-00000000-0000-0000-0000-000000000000", "ses-aaaa");
  ok("T1a 解出的是 sub", raccoonAuth.tokenUid(A) === "pu-00000000-0000-0000-0000-000000000000", raccoonAuth.tokenUid(A));
  ok("T1b 不含签发方域名", !raccoonAuth.tokenUid(A).includes("xiaohuanxiong.com"));
  ok("T1c 不是 sid", !raccoonAuth.tokenUid(A).startsWith("ses-"));
}

console.log("\n=== T2 两个不同账号必须得到不同 uid（否则号池加不进第二个号）===");
{
  const A = tokenFor("pu-00000000-0000-0000-0000-000000000000", "ses-aaaa");
  const B = tokenFor("pu-11111111-1111-1111-1111-111111111111", "ses-bbbb");
  ok("T2a 新实现：不同账号 → 不同 uid", raccoonAuth.tokenUid(A) !== raccoonAuth.tokenUid(B), raccoonAuth.tokenUid(A) + " vs " + raccoonAuth.tokenUid(B));
  // 反向对照：旧实现在同一组 token 上必然撞车
  ok("T2b 反向对照：旧实现（iss||sid）两个账号 uid 相同 = 加不进第二个号", oldTokenUid(A) === oldTokenUid(B) && oldTokenUid(A) === RACCOON_ISS, oldTokenUid(A) + " vs " + oldTokenUid(B));
}

console.log("\n=== T3 同一账号重新登录（sid 变了）uid 必须不变 ===");
{
  const sub = "pu-00000000-0000-0000-0000-000000000000";
  const t1 = tokenFor(sub, "ses-aaaa");
  const t2 = tokenFor(sub, "ses-zzzz");
  ok("T3a 新实现：sid 变化不影响 uid", raccoonAuth.tokenUid(t1) === raccoonAuth.tokenUid(t2), raccoonAuth.tokenUid(t1) + " vs " + raccoonAuth.tokenUid(t2));
  ok("T3b 反向对照：旧实现取 sid 兜底时会每次新增（此例取 iss 恒同，故仅断言其等于常量）", oldTokenUid(t1) === RACCOON_ISS);
  // 没有 iss 的极端形态：旧实现会退回 sid（每次登录都变）
  const noIss1 = jwt({ sid: "ses-1", sub: "pu-x" });
  const noIss2 = jwt({ sid: "ses-2", sub: "pu-x" });
  ok("T3c 反向对照：无 iss 时旧实现取 sid ⇒ 两次登录 uid 不同（= 每次新增一条）", oldTokenUid(noIss1) !== oldTokenUid(noIss2), oldTokenUid(noIss1) + " vs " + oldTokenUid(noIss2));
  ok("T3d 新实现在同一形态下仍取 sub（稳定）", raccoonAuth.tokenUid(noIss1) === "pu-x" && raccoonAuth.tokenUid(noIss2) === "pu-x");
}

console.log("\n=== T4 兼容与健壮 ===");
{
  ok("T4a 老 token 无 sub 时退回 iss（不抛）", raccoonAuth.tokenUid(jwt({ iss: RACCOON_ISS })) === RACCOON_ISS);
  ok("T4b 有 uid 字段时用它（其它形态兼容）", raccoonAuth.tokenUid(jwt({ uid: "pu-y", iss: RACCOON_ISS })) === "pu-y");
  ok("T4c 坏 token 返回空串", raccoonAuth.tokenUid("not-a-jwt") === "");
  ok("T4d 空 token 返回空串", raccoonAuth.tokenUid("") === "");
  ok("T4e 带 Bearer 前缀也能解（与 ownedTokens 一致）", raccoonAuth.tokenUid("Bearer " + tokenFor("pu-z", "ses-1")) === "pu-z");
}

console.log("\n=== T5 登录查重：uid 撞车时用 officeIdentity 二次判别 ===");
{
  const s = fs.readFileSync(path.join(ROOT, "electron/backend/proxy/discovery.cjs"), "utf8");
  ok("T5a beginRaccoonOAuth 内有 sameAccount 判别", /const sameAccount = \(a\) => \{/.test(s));
  ok("T5b uid 不同直接不算同一账号", /String\(a\.uid \|\| ""\) !== String\(uid\)\) return false;/.test(s));
  ok("T5c 两边都有 officeIdentity 时按它区分", /return oldOi && newOi \? oldOi === newOi : true;/.test(s));
  ok("T5d 仍以 uid 为前提查重", /store\.listAccounts\(channel\)\.find\(sameAccount\)/.test(s));
}

console.log("\n=== T6 一次性迁移：历史行 uid 由域名纠正为 sub ===");
{
  const s = fs.readFileSync(path.join(ROOT, "electron/backend/proxy/store.cjs"), "utf8");
  ok("T6a open() 内有该迁移", s.includes("RACCOON_ISS_UID"));
  ok("T6b 只匹配 uid 恰好等于签发方域名的行", /WHERE channel = 'raccoon' AND uid = \?/.test(s) && /RACCOON_ISS_UID = "xiaohuanxiong\.com\/iam"/.test(s));
  ok("T6c 用 token 里的 sub 纠正", /return String\(\(pl && pl\.sub\) \|\| ""\);/.test(s));
  ok("T6d 没有 sub 时跳过（不写坏数据）", /if \(!sub \|\| sub === RACCOON_ISS_UID\) continue;/.test(s));
}

console.log("\n=== T7 口径一致：scanRaccoon / ideswitch 与 tokenUid 必须同一条链 ===");
{
  // 这条守卫来自真实返工：只改 tokenUid 与登录落库、漏改 scanRaccoon 时，同一条凭据
  // 「本机扫描入池」与「OAuth 登录落库」会算出两个不同 uid —— 同一账号在号池里出现两条，
  // 且 store.open() 的一次性历史纠正会被下一次扫描重新打回域名形态（来回震荡，修不干净）。
  const disc = fs.readFileSync(path.join(ROOT, "electron/backend/proxy/discovery.cjs"), "utf8");
  const ide = fs.readFileSync(path.join(ROOT, "electron/backend/proxy/ideswitch.cjs"), "utf8");
  ok("T7a scanRaccoon 与 tokenUid 同链（sub → uid → id → iss）",
    /const uid = String\(dec\.sub \|\| dec\.uid \|\| dec\.id \|\| dec\.iss \|\| ""\)/.test(disc));
  ok("T7b ideswitch 状态上报与 tokenUid 同链",
    /ruid = String\(\(payload && \(payload\.sub \|\| payload\.uid \|\| payload\.id \|\| payload\.iss\)\) \|\| ""\)/.test(ide));
  ok("T7c scanRaccoon 不再有「iss 优先」的旧形态", !/const uid = String\(dec\.iss/.test(disc));
  ok("T7d ideswitch 不再有「iss || sid」的旧形态", !/payload\.iss \|\| payload\.sid/.test(ide));
  ok("T7e tokenUid 自身绝不回退 sid（会话 ID，每次登录都变）",
    !/payload\.sid/.test(fs.readFileSync(path.join(ROOT, "electron/backend/proxy/raccoonAuth.cjs"), "utf8").split("function tokenUid")[1].split("function ownedTokens")[0]));
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log("\n  小浣熊账号 ID 自测: 通过 " + pass + "  失败 " + fail);
if (fail) console.log("  失败项:\n    - " + cases.join("\n    - "));
process.exit(fail ? 1 : 0);