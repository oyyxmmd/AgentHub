// Qoder 账号设备标识（machineId）保留规则自测（issue #118）
// 运行：node scripts/test-qoder-machineid-keep.cjs
// 隔离：APPDATA 指到 mkdtemp 出来的临时目录，不碰真实号池
//
// 背景：machineId 是**该账号登录时**客户端生成并落盘的，而读取端
// （~/.qoder{,-cn}/.auth/machine_id）永远只能读到「当前登录的那个账号」的。
// 重新导入别的账号时若直接覆盖，两个账号会共用同一个设备标识——上游按设备去重时，
// 第二个账号永远领不到，表现为「永远显示已签到、积分不涨」（issue #118）。
// raccoon 的 deviceId 早就是「旧值优先」，qoder 这边漏了。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-meta-"));

const store = require("../electron/backend/proxy/store.cjs");
const discovery = require("../electron/backend/proxy/discovery.cjs");

let pass = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", msg);
  } else {
    failed++;
    console.log("  \u2717", msg, got !== undefined ? `→ got ${JSON.stringify(got)}` : "");
  }
}

const metaOf = (id) => {
  const r = store.getAccount(id);
  try {
    return JSON.parse((r && r.meta) || "{}");
  } catch {
    return {};
  }
};
const idOf = (uid) => {
  const a = store.listAccounts("qoder_intl").find((x) => x.uid === uid);
  return a ? a.id : "";
};
const cand = (uid, machineId, token) => ({
  channel: "qoder_intl",
  uid,
  name: uid,
  token,
  refreshToken: "rt-" + uid,
  meta: { machineId, product: "qoder_intl" },
  source: "scan",
  file: "自测",
});

store.open();

console.log("\n[1] 首次导入 → machineId 正常落库");
{
  const r = discovery.importCandidate(cand("u1", "machine-A", "tok-1"), "qoder_intl");
  ok(!!r.id && r.updated !== true, "账号落库（新增路径）", r);
  ok(metaOf(r.id).machineId === "machine-A", "machineId = machine-A", metaOf(r.id));
}

console.log("\n[2] 同一账号再次导入（读到的是别的账号的 machineId）→ 必须保留旧值");
{
  const r = discovery.importCandidate(cand("u1", "machine-B", "tok-1b"), "qoder_intl");
  ok(r.updated === true, "走更新路径", r);
  ok(metaOf(r.id).machineId === "machine-A", "machineId 仍是 machine-A（旧值优先）", metaOf(r.id));
  ok(store.accountSecrets(store.getAccount(r.id)).token === "tok-1b", "token 正常更新（只有设备标识受保护）");
}

console.log("\n[3] 两个账号各自导入 → 设备标识互不覆盖");
{
  const r2 = discovery.importCandidate(cand("u2", "machine-B", "tok-2"), "qoder_intl");
  const m1 = metaOf(idOf("u1")).machineId;
  const m2 = metaOf(r2.id).machineId;
  ok(m1 === "machine-A", "账号 1 仍是 machine-A", m1);
  ok(m2 === "machine-B", "账号 2 是 machine-B（没被账号 1 带偏）", m2);
  ok(m1 !== m2, "两个账号设备标识不同（上游不会把它们当成同一设备）");
}

console.log("\n[4] 旧 meta 里没有 machineId → 新值应补上（不能把空值钉死）");
{
  const id = store.addAccount({ channel: "qoder_intl", uid: "u3", name: "u3", token: "t3", refreshToken: "r3", meta: { product: "qoder_intl" } });
  ok(!metaOf(id).machineId, "前置：旧 meta 无 machineId");
  const r = discovery.importCandidate(cand("u3", "machine-C", "t3b"), "qoder_intl");
  ok(metaOf(r.id).machineId === "machine-C", "空值时新值补上（不然账号永远签不了名）", metaOf(r.id));
}

console.log("\n[5] 反复导入同一账号，machineId 稳定不漂移");
{
  for (const m of ["machine-X", "machine-Y", "machine-Z"]) {
    discovery.importCandidate(cand("u2", m, "tok-2"), "qoder_intl");
  }
  ok(metaOf(idOf("u2")).machineId === "machine-B", "三轮覆盖后仍是首次的 machine-B", metaOf(idOf("u2")).machineId);
}

console.log(`\n${failed ? "\u2717" : "OK"} Qoder 设备标识保留自测：${pass} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
