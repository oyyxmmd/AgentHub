// 号池同步「用户编辑时钟」自测：改名/备注不再被活动时钟（updated_at）判负
// 运行：node scripts/test-pool-edit-clock.cjs
// 只碰 AGENTHUB_DATA_DIR 指向的临时目录（config.cjs 的自测沙箱钩子），不联网、不碰真实数据
//
// 缺陷回顾（本文件 ③④⑤⑧ 各钉一条，改动前必红）：
//   store.updateAccount 无条件把 accounts.updated_at 写成当下，而每次代理请求扣减（server.cjs）
//   与每 30min 的额度刷新（credits.cjs）都调它 ⇒ updated_at 量的是「这台机器多忙」，不是
//   「谁最后改了这个名字/备注」。name 与 note 的 LWW 原来都比它，于是：
//     ① 高频机的陈旧名字会反向覆盖低频机的新改名（③）；
//     ② 真改名的那台反而推不出去（④，与①互为正反）；
//     ③ 「删掉备注」这个动作传不到对端（⑤，原判据要求 remoteNote 非空）；
//     ④ 采纳远端凭据时 meta 整份合并，会把远端的编辑时钟继承过来（⑧）。
//   修法：name/note 各带一条用户编辑时钟（meta.renamedAt / meta.noteAt），比较用它，
//   快照里没这条时（存量数据）退回原 updatedAt 口径。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-pool-edit-clock-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

const store = require("../electron/backend/proxy/store.cjs");
const poolsync = require("../electron/backend/proxy/poolsync.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

const DAY = 86400000;
const now = Date.now();

/** 本机账号：活动时钟（updatedAt）与 name/note 的编辑时钟分开给，才演得出「活动新、编辑旧」 */
function localAccount({ uid, name, updatedAt, meta }) {
  return store.addAccount({
    channel: "trae", uid, name, token: "tk-same", refreshToken: "", source: "paste",
    expiresAt: 0, updatedAt, meta,
  });
}
function row(id) { return store.listAccounts().find((a) => a.id === id); }

/** 远端快照行。凭据默认与本机相同 ⇒ 不触发凭据分支，这条测的就只剩 name/note */
function remoteAccount({ uid, name, updatedAt, renamedAt, note, noteAt, token = "tk-same" }) {
  const meta = {};
  if (renamedAt !== undefined) meta.renamedAt = renamedAt;
  if (note !== undefined) meta.note = note;
  if (noteAt !== undefined) meta.noteAt = noteAt;
  return {
    key: `trae:${uid}`, channel: "trae", uid, name, token, refreshToken: "",
    expiresAt: 0, credits: 0, creditsAt: 0, updatedAt, meta, source: "paste",
  };
}
const snapOf = (accounts) => ({ format: "agenthub-pool@1", deviceId: "dev-b", accounts });

// ===== ① store：改名的编辑时钟 =====
{
  const id = localAccount({ uid: "u-clock", name: "旧名", updatedAt: now - 10 * DAY });
  const tBefore = Date.now();
  store.updateAccount(id, { name: "新名" });
  const m = row(id).meta;
  ok(m.renamedAt >= tBefore && m.renamedAt <= Date.now(), "① 改名落 meta.renamedAt＝当下（此前只写 name 列，编辑时刻无处可查）");

  const first = m.renamedAt;
  store.updateAccount(id, { name: "新名" }); // 同名重写
  ok(row(id).meta.renamedAt === first, "① 同名重写不推进编辑时钟（否则两侧拿同一个值互相追赶、每轮白写）");

  store.updateAccount(id, { name: "外部给的时刻", renamedAt: 123 });
  ok(row(id).meta.renamedAt === 123, "① 显式传 renamedAt 时以传入值为准（同步采纳远端名要走这条，不能记成本机当下）");

  const before = row(id);
  const tCall = Date.now();
  store.updateAccount(id, { credits: 5, creditsAt: now });
  const after = row(id);
  ok(after.meta.renamedAt === before.meta.renamedAt, "① 只改额度不得推进编辑时钟");
  // updated_at 被写成「调用当下」：判据用 >= 而不是 >。这两步在同一毫秒内跑完时
  // Date.now() 相等，严格大于会随机器快慢随机判红（约 1/4 概率）。「两条尺不是一条」
  // 由后半段承担：编辑时钟此刻还是上面写进去的 123，活动时钟是当下，两者必然分开。
  ok(after.updatedAt >= tCall && after.updatedAt > after.meta.renamedAt,
    "① 而 updated_at 确实被这次额度刷新推进到当下（两条尺不是一条，③④ 的前提）");
}

// ===== ② store：备注的时钟与清除语义 =====
{
  const id = localAccount({ uid: "u-note", name: "备注号", updatedAt: now - 10 * DAY });
  store.noteAccount(id, "第一段备注");
  const m1 = row(id).meta;
  ok(m1.note === "第一段备注" && m1.noteAt > 0, "② 写备注落 meta.noteAt");

  store.noteAccount(id, "第一段备注");
  ok(row(id).meta.noteAt === m1.noteAt, "② 内容没变不推进时钟（同值重发会让每轮同步都白写一次）");

  // 清除前先把时钟按回 1 秒前再比：这两步可能落在同一毫秒，noteAt 相等时
  // 「清除推进了时钟」与「清除沿用了旧值」分不开，严格大于会随机判红
  store.updateAccount(id, { meta: { ...row(id).meta, noteAt: now - 1000 } });
  const beforeClear = row(id).meta.noteAt;
  store.noteAccount(id, "");
  const m2 = row(id).meta;
  ok("note" in m2 && m2.note === "", "② 清除写空串并保留键（原来是 delete meta.note，删键后「清除」这个动作传不出去）");
  ok(m2.noteAt > beforeClear, "② 清除同样推进编辑时钟（时钟已按回 1 秒前，清除后必须高于它）");
  ok(row(id).note === "", "② accountView 读回空串（渲染层不需要知道键在不在）");
}

// ===== ③ 核心回归：对端只是跑过流量，不得把本机改名还原 =====
{
  const T_RENAME = now - 2 * DAY;
  const id = localAccount({ uid: "u-keep", name: "我改过的名字", updatedAt: T_RENAME, meta: { renamedAt: T_RENAME } });
  const r = poolsync.mergeSnapshot(snapOf([
    // 对端：名字是它自己的旧名（30 天前那次编辑），但刚刷过额度 ⇒ updatedAt 是当下
    remoteAccount({ uid: "u-keep", name: "对端的旧名", updatedAt: now, renamedAt: now - 30 * DAY }),
  ]));
  ok(row(id).name === "我改过的名字", "③ 对端的流量时间戳不得覆盖本机改名（改动前这一条必红：updated_at 新者胜）");
  ok(r.updated === 0, "③ 且本轮不该产生任何写入");
  ok(row(id).meta.renamedAt === T_RENAME, "③ 本机改名时刻保持原值（没被远端 30 天前那次编辑顶掉）");
}

// ===== ④ 正反两向：远端编辑确实更晚 ⇒ 必须采纳，并把时钟追平 =====
{
  const T_REMOTE_EDIT = now - 1 * DAY;
  const id = localAccount({ uid: "u-push", name: "本机旧名", updatedAt: now, meta: { renamedAt: now - 9 * DAY } });
  const snap = snapOf([
    // 对端改名更早发生在本机之后（1 天前），但它这台机不忙 ⇒ updatedAt 反而更旧
    remoteAccount({ uid: "u-push", name: "远端新名", updatedAt: now - 5 * DAY, renamedAt: T_REMOTE_EDIT }),
  ]);
  const r = poolsync.mergeSnapshot(snap);
  ok(row(id).name === "远端新名", "④ 低频机的真改名不再推不出去（改动前按 updatedAt 比，远端这台「不忙」就判负）");
  ok(row(id).meta.renamedAt === T_REMOTE_EDIT, "④ 采纳时把编辑时钟追平到远端那次编辑，不是记成本机当下");
  const r2 = poolsync.mergeSnapshot(snap);
  ok(r2.updated === 0, "④ 追平后同一份快照再跑一轮不该重发（不追平就每轮都白写一次）");
}

// ===== ⑤ 备注清除要能传播 =====
{
  const id = localAccount({ uid: "u-clear", name: "清除号", updatedAt: now, meta: { note: "要删掉的备注", noteAt: now - 1 * DAY } });
  poolsync.mergeSnapshot(snapOf([
    remoteAccount({ uid: "u-clear", name: "清除号", updatedAt: now - 20 * DAY, note: "", noteAt: now }),
  ]));
  const m = row(id).meta;
  ok("note" in m && m.note === "", "⑤ 远端清除备注（空串保留键）必须覆盖本机（改动前要求 remoteNote 非空，删除永远传不到）");
  ok(m.noteAt === now, "⑤ 采纳后时钟追平远端那次清除");
}

// ===== ⑥ 备注同值不重发 =====
{
  const T = now - 3 * DAY;
  const id = localAccount({ uid: "u-same", name: "同值号", updatedAt: now - 30 * DAY, meta: { note: "两边一样的备注", noteAt: T } });
  const r = poolsync.mergeSnapshot(snapOf([
    remoteAccount({ uid: "u-same", name: "同值号", updatedAt: now, note: "两边一样的备注", noteAt: T }),
  ]));
  ok(r.updated === 0, "⑥ 备注内容相同即视为已一致，不因两侧时间戳互相追赶而反复重写");
}

// ===== ⑦ 存量兼容：快照里没有编辑时钟时，退回改动前的口径 =====
{
  const id = localAccount({ uid: "u-legacy", name: "本机名", updatedAt: now - 40 * DAY });
  poolsync.mergeSnapshot(snapOf([remoteAccount({ uid: "u-legacy", name: "远端名", updatedAt: now })]));
  ok(row(id).name === "远端名", "⑦ 老快照无 renamedAt ⇒ 按 updatedAt 比，存量行为不变（采纳）");

  const id2 = localAccount({ uid: "u-legacy2", name: "本机名", updatedAt: now });
  poolsync.mergeSnapshot(snapOf([remoteAccount({ uid: "u-legacy2", name: "远端名", updatedAt: now - 40 * DAY })]));
  ok(row(id2).name === "本机名", "⑦ 反向也一样：本机 updatedAt 更新 ⇒ 仍不采纳");
}

// ===== ⑧ 凭据采纳不得把本机编辑时钟换成远端的 =====
{
  const T_NAME = now - 3 * DAY;
  const T_NOTE = now - 4 * DAY;
  const id = localAccount({ uid: "u-cred", name: "本机名", updatedAt: now - 10 * DAY, meta: { renamedAt: T_NAME, note: "本机备注", noteAt: T_NOTE } });
  poolsync.mergeSnapshot(snapOf([
    // 凭据确实不同且远端 updatedAt 更新 ⇒ 走采纳分支；远端 meta 里带一对更早的编辑时钟
    remoteAccount({
      uid: "u-cred", name: "远端名", token: "tk-other", updatedAt: now,
      renamedAt: now - 30 * DAY, note: "远端备注", noteAt: now - 30 * DAY,
    }),
  ]));
  const m = row(id).meta;
  ok(m.renamedAt === T_NAME, "⑧ 采纳远端凭据时，name 的编辑时钟仍是本机那次（整份合并会把它继承成远端的，之后本机真改名反而判负）");
  ok(m.noteAt === T_NOTE, "⑧ 备注的编辑时钟同理");
  ok(row(id).name === "本机名", "⑧ 远端编辑更早 ⇒ 名字不采纳");
  ok(m.note === "本机备注", "⑧ 备注也不采纳（改动前这条会被远端覆盖：它只看 updatedAt，而远端 updatedAt 更新）");
  ok(store.accountSecrets(store.getAccount(id)).token === "tk-other", "⑧ 凭据本身照常采纳（本 PR 只收窄编辑时钟的继承）");
}

// ===== ⑨ 接线钉：判据落到代码构造，且只看目标函数体（注释里提字段名不算命中） =====
{
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const ps = read("electron/backend/proxy/poolsync.cjs");
  const mergeBody = ps.slice(ps.indexOf("function mergeSnapshot"), ps.indexOf("function applyTombstones"));
  ok(mergeBody.length > 200, "⑨ 拿到 mergeSnapshot 函数体（切不到就说明函数改名了，宁可判红）");
  ok(/remoteNameAt > localNameAt/.test(mergeBody), "⑨ name 的比较必须落在用户编辑时钟上");
  ok(/remoteNoteAt > localNoteAt/.test(mergeBody), "⑨ note 的比较必须落在用户编辑时钟上");
  ok(!/ra\.name !== local\.name && raUpdatedAt > localUpdatedAt/.test(mergeBody),
    "⑨ mergeSnapshot 里不得再出现「改名比活动时钟」那条例据");
  ok(/typeof ra\.meta\.note === "string"[^\n]*: null/.test(mergeBody),
    "⑨ 远端备注按「键存在」判定（缺省给 null），空串才传得动");
  ok(/note: localMeta\.note, renamedAt: localMeta\.renamedAt, noteAt: localMeta\.noteAt/.test(mergeBody),
    "⑨ 凭据合并分支必须把本机的备注文本与两条编辑时钟一起钉回去（只钉时钟不钉文本会留下「文本来自远端、时钟来自本机」的错配）");

  const st = read("electron/backend/proxy/store.cjs");
  const updBody = st.slice(st.indexOf("function updateAccount"), st.indexOf("/** 记录账号最近一次上游错误"));
  const noteBody = st.slice(st.indexOf("function noteAccount"), st.indexOf("/** 记录账号今日签到结果"));
  ok(updBody.length > 200 && noteBody.length > 100, "⑨ 拿到 updateAccount / noteAccount 函数体");
  ok(/editClock\.renamedAt = Date\.now\(\)/.test(updBody), "⑨ 改名自动落编辑时钟");
  ok(/patch\.renamedAt != null/.test(updBody), "⑨ 显式传入的编辑时钟优先于本机当下");
  ok(/meta\.noteAt = Date\.now\(\)/.test(noteBody), "⑨ 备注落编辑时钟");
  ok(!/delete meta\.note/.test(noteBody), "⑨ 清除不得再删键（删键就传不出去）");
}

store.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录被占用不影响结论 */ }

console.log(`\n${failed ? "FAIL" : "OK"} 号池编辑时钟自测：${pass} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
