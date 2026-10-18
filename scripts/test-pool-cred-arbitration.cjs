// 号池同步「凭据仲裁」自测：凭据新旧按 tokenAt 比、可用性按 tokenExp 判，
// 不再拿活动时钟（updated_at）与额度到期（expires_at）顶替。
// 运行：node scripts/test-pool-cred-arbitration.cjs
// 只碰 AGENTHUB_DATA_DIR 指向的临时目录（config.cjs 的自测沙箱钩子），不联网、不碰真实数据
//
// 缺陷回顾（本文件逐条钉死，改动前必红）：
//   ① 小浣熊这类渠道 access 仅 3h、额度接口又不回到期时间 ⇒ expires_at 恒 0，
//      「凭据是否过期」判不出来，规则 1/2（有效性裁决）形同虚设，一切都落到 LWW；
//   ② LWW 原来比 updated_at，而它被额度刷新/冷却/备注一路顶新 ⇒ 刚刷新失败（被判 relogin）
//      的一侧凭坏凭据在 LWW 里胜出，反向污染另一台健康机器；
//   ③ 跨机兜底（凭据被服务端拒 → 拉远端取新值）需要「强制采纳」语义：远端那份哪怕更旧，
//      也是本机失败后唯一可能可用的一份。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-pool-cred-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.AGENTHUB_DATA_DIR, "proxy"), { recursive: true });

// ===== ［0］老库在线迁移：先造一个「没有 token_at 列」的旧库，再让 store 打开它 =====
// 迁移写坏的后果是程序**打不开**（启动即抛），比功能回归严重得多，所以放在最前面钉。
// 必须赶在 require store 之前把旧库摆好，否则 open() 会以新 schema 建表，测不到迁移分支。
{
  const { DatabaseSync } = require("node:sqlite");
  const legacy = new DatabaseSync(path.join(process.env.AGENTHUB_DATA_DIR, "proxy", "stats.db"));
  legacy.exec(`CREATE TABLE accounts (
    id TEXT PRIMARY KEY, channel TEXT NOT NULL, uid TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
    token_enc TEXT NOT NULL DEFAULT '', refresh_enc TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'online',
    credits INTEGER NOT NULL DEFAULT 0, credits_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0,
    cool_until INTEGER NOT NULL DEFAULT 0, cool_reason TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'paste',
    last_used INTEGER NOT NULL DEFAULT 0, today_day TEXT NOT NULL DEFAULT '', today_req INTEGER NOT NULL DEFAULT 0,
    today_tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '');`);
  legacy.prepare("INSERT INTO accounts (id, channel, uid, name, token_enc, refresh_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("legacy-1", "raccoon", "old-uid", "老库账号", "tk-old", "rt-old", 1000, 5000);
  legacy.close();
}

const store = require("../electron/backend/proxy/store.cjs");
const poolsync = require("../electron/backend/proxy/poolsync.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}
const now = Date.now();

/** 造一枚假 JWT：只求 payload.exp 可解（util.jwtDecode 不验签，签名段随便给） */
function jwt(expMs) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: Math.floor(expMs / 1000) })}.sig`;
}

function addLocal({ uid, token, refreshToken = "rt-" + uid, expiresAt = 0, meta = {} }) {
  return store.addAccount({ channel: "raccoon", uid, name: "本地 " + uid, token, refreshToken, source: "oauth", expiresAt, meta });
}
const view = (id) => store.listAccounts().find((a) => a.id === id);
const tok = (id) => store.accountSecrets(store.getAccount(id)).token;
const ref = (id) => store.accountSecrets(store.getAccount(id)).refreshToken;

/** 远端快照行（字段按需给；tokenAt/tokenExp 缺省即「老版本包」形态） */
function remoteRow(o) {
  return {
    key: `raccoon:${o.uid}`, channel: "raccoon", uid: o.uid, name: o.name || "远端 " + o.uid,
    token: o.token, refreshToken: o.refreshToken || "", expiresAt: o.expiresAt || 0,
    credits: 0, creditsAt: 0, updatedAt: o.updatedAt || 0, meta: {},
    ...(o.tokenAt !== undefined ? { tokenAt: o.tokenAt } : {}),
    ...(o.tokenExp !== undefined ? { tokenExp: o.tokenExp } : {}),
    source: "oauth",
  };
}
const merge = (rows, opts) => poolsync.mergeSnapshot({ format: "agenthub-proxy-pool@1", deviceId: "dev-b", accounts: rows }, "raccoon", opts);

console.log("\n[0] 老库在线迁移：加 token_at 列并按 updated_at 回填");
{
  const v = store.listAccounts().find((a) => a.id === "legacy-1");
  ok(!!v, "老库的账号还在（迁移没把数据弄丢）");
  ok(v.tokenAt === 5000, "存量行按 updated_at 回填凭据时刻（0 会让它永远比不过任何对端）");
  ok(store.accountSecrets(store.getAccount("legacy-1")).token === "tk-old", "老库凭据照常读得出");
}

console.log("\n[1] store：凭据时刻只在凭据真变化时推进");
{
  const id = addLocal({ uid: "s1", token: "tk1" });
  const t1 = view(id).tokenAt;
  ok(t1 > 0, "入池即记凭据时刻");
  store.updateAccount(id, { credits: 123, creditsAt: now });
  ok(view(id).tokenAt === t1, "只刷额度不推进（每 30min 一轮的额度刷新走的就是这条）");
  store.updateAccount(id, { status: "relogin", coolUntil: 0, coolReason: "凭证失效" });
  ok(view(id).tokenAt === t1, "标 relogin 不推进——它正是「刚失败」的标记，推进就等于让坏凭据变最新");
  store.noteAccount(id, "一条备注");
  ok(view(id).tokenAt === t1, "备注不推进");
  store.updateAccount(id, { token: "tk1", refreshToken: "rt-s1" });
  ok(view(id).tokenAt === t1, "凭据同值重写不推进（刷新链路每轮都会写一次）");
  const t0 = Date.now();
  store.updateAccount(id, { token: "tk2", refreshToken: "rt2" });
  ok(view(id).tokenAt >= t0 && view(id).tokenAt > t1, "凭据真变化才推进");
  ok(tok(id) === "tk2" && ref(id) === "rt2", "新凭据已落库");
}

console.log("\n[2] 规则 3：两端都有效时按凭据时刻比，不再被活动时钟带偏");
{
  // 本机：凭据时刻旧、活动时钟极新（一直跑流量）；远端：凭据时刻略新、活动时钟很旧
  const id = addLocal({ uid: "s2", token: "tk-local" });
  const busy = now + 86400000;
  store.updateAccount(id, { token: "tk-local", refreshToken: "rt-local", tokenAt: 1000, updatedAt: busy });
  merge([remoteRow({ uid: "s2", token: "tk-remote", refreshToken: "rt-remote", tokenAt: 2000, updatedAt: 1 })]);
  ok(tok(id) === "tk-remote", "远端凭据时刻更新 ⇒ 采纳（改动前比 updatedAt：本机忙碌 → 判负 → 远端新凭据永远进不来）");
  ok(view(id).tokenAt === 2000, "采纳后凭据时刻追平远端那次写入（不是本机当下）");
}

console.log("\n[3] 规则 2：远端更新但凭据已过期 ⇒ 坚决不采纳（堵反向污染）");
{
  const id = addLocal({ uid: "s3", token: "tk-good", expiresAt: now + 3600000 });
  store.updateAccount(id, { token: "tk-good", refreshToken: "rt-good", tokenAt: 1000, updatedAt: 1 });
  merge([remoteRow({ uid: "s3", token: "tk-dead", refreshToken: "rt-dead", tokenAt: 999999, tokenExp: now - 1000, updatedAt: 999999 })]);
  ok(tok(id) === "tk-good", "远端凭据已过期 + 本机可用 ⇒ 保住本机（改动前：远端 updatedAt 更大 → 采纳 → 本机也被带死）");
}

console.log("\n[4] 规则 1：本机凭据过期、远端有效 ⇒ 采纳（靠 JWT exp 判，不依赖 expires_at）");
{
  const id = addLocal({ uid: "s4", token: jwt(now - 1000), expiresAt: 0 }); // expires_at 恒 0：raccoon 历来如此
  const fresh = jwt(now + 3600000);
  merge([remoteRow({ uid: "s4", token: fresh, refreshToken: "rt-new", tokenAt: 5, tokenExp: now + 3600000, updatedAt: 5 })]);
  ok(tok(id) === fresh, "本机 access 已过期被认出来（改动前 expires_at=0 → 判不出过期）⇒ 采纳远端新鲜凭据");
}

console.log("\n[5] 规则 0：兜底强制采纳（刷新被服务端拒后拉远端取新凭据）");
{
  // 远端 access 现在就能用 ⇒ 采纳
  const id = addLocal({ uid: "s5", token: "tk-now-local" });
  store.updateAccount(id, { token: "tk-now-local", refreshToken: "rt-now-local", tokenAt: now, updatedAt: 1 });
  merge([remoteRow({ uid: "s5", token: "tk-remote-alive", refreshToken: "rt-remote", tokenAt: 10, updatedAt: 1, tokenExp: now + 3600000 })], { preferKeys: new Set(["raccoon:s5"]) });
  ok(tok(id) === "tk-remote-alive", "带 preferKeys + 远端 access 仍有效 ⇒ 换过来用");
  // 远端 access 已过期但对端轮换得更晚（本机这份才是过期的）⇒ 仍要采纳：这是自愈主路径
  const id2 = addLocal({ uid: "s6", token: "tk-stale", tokenExp: 0 });
  store.updateAccount(id2, { token: "tk-stale", refreshToken: "rt-stale", tokenAt: now - 7200000, updatedAt: 1 });
  merge([remoteRow({ uid: "s6", token: "tk-peer-rotated", refreshToken: "rt-peer-new", tokenAt: now - 1000, updatedAt: 1, tokenExp: now - 60000 })], { preferKeys: new Set(["raccoon:s6"]) });
  ok(tok(id2) === "tk-peer-rotated" && ref(id2) === "rt-peer-new", "带 preferKeys + 对端更晚轮换（access 也过期）⇒ 采纳（规则 2 会挡住，这档就是为它开的）");
  ok(view(id2).tokenAt === now - 1000, "采纳后沿用远端那一刻，不冒充「刚写的」（否则死凭据会压住对端有效凭据）");
  // 远端更旧、且它的 access 也过期 ⇒ 不许拿死凭据顶掉本机可能还活着的凭据
  const id3 = addLocal({ uid: "s7", token: "tk-maybe-ok" });
  store.updateAccount(id3, { token: "tk-maybe-ok", refreshToken: "rt-maybe-ok", tokenAt: now, updatedAt: 1 });
  merge([remoteRow({ uid: "s7", token: "tk-peer-old-dead", refreshToken: "rt-peer-old", tokenAt: 10, updatedAt: 1, tokenExp: now - 60000 })], { preferKeys: new Set(["raccoon:s7"]) });
  ok(tok(id3) === "tk-maybe-ok", "带 preferKeys 但对端更旧且已过期 ⇒ 不采纳（401 可能是瞬时的，别把还能用的换掉）");
  // 反向：不带 preferKeys（普通同步）时不采纳更旧的远端凭据
  const id4 = addLocal({ uid: "s8", token: "tk-now-local" });
  store.updateAccount(id4, { token: "tk-now-local", refreshToken: "rt-now-local", tokenAt: now, updatedAt: 1 });
  merge([remoteRow({ uid: "s8", token: "tk-older-remote", refreshToken: "rt-older-remote", tokenAt: 10, updatedAt: 1, tokenExp: now + 3600000 })]);
  ok(tok(id4) === "tk-now-local", "不带 preferKeys（普通同步）⇒ 仍不采纳更旧的远端凭据");
}

console.log("\n[6] 老版本对端（包内无 tokenAt）退回 updatedAt 旧口径，混着比会永远判负");
{
  const id = addLocal({ uid: "s7", token: "tk-a" });
  store.updateAccount(id, { updatedAt: 1000 }); // 活动时钟旧
  merge([remoteRow({ uid: "s7", token: "tk-b", refreshToken: "rt-b", updatedAt: 5000 })]);
  ok(tok(id) === "tk-b", "远端无 tokenAt ⇒ 比 updatedAt，远端更新即采纳（存量行为不变）");
  const id2 = addLocal({ uid: "s8", token: "tk-a" });
  store.updateAccount(id2, { updatedAt: 9000 });
  merge([remoteRow({ uid: "s8", token: "tk-b", refreshToken: "rt-b", updatedAt: 1000 })]);
  ok(tok(id2) === "tk-a", "反向同理：本机更新则不采纳");
}

console.log("\n[7] 整号入池：凭据时刻取远端那一刻，不按本机入池时刻记");
{
  const m = merge([remoteRow({ uid: "s9", token: "tk-fresh", tokenAt: 777, updatedAt: 777 })]);
  const id = store.listAccounts().find((a) => a.uid === "s9").id;
  ok(m.added === 1 && view(id).tokenAt === 777, "新号入池沿用快照里的凭据时刻（记成本机当下的话，下一秒就压过对端）");
}

console.log("\n[8] 快照导出：带凭据时刻与凭据到期");
{
  const expMs = now + 7200000;
  const id = addLocal({ uid: "s10", token: jwt(expMs) });
  const snap = poolsync.exportPool("raccoon");
  const a = snap.accounts.find((x) => x.uid === "s10");
  ok(!!a && a.tokenAt > 0, "快照带凭据时刻");
  ok(!!a && Math.abs(a.tokenExp - Math.floor(expMs / 1000) * 1000) <= 1000, "快照带凭据到期（本地解 JWT exp，非 JWT 渠道为 0）");
  ok(!!a && a.token === tok(id), "凭据照旧明文进包（只进加密包）");
}

console.log(`\n${failed === 0 ? "OK" : "FAIL"} 号池凭据仲裁自测：${pass} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
