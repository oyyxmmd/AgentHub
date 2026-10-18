// 反代网关 · Qoder 多账号签到诊断（issue #118 取证工具）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-checkin-probe.cjs [channel]
//      不传 channel 则扫描号池里所有 qoder / qoder_intl 账号。
//      --selftest 跑内置判据自测（不读号池、不联网）。
//
// 只读诊断：不改号池、不触发领取。只打 campaigns 列表接口（GET，无副作用），
// 用来区分「同机多账号签到只成功一个」的两种根因：
//
//   A) 服务端按机器风控身份去重 —— 两个账号的 campaigns 返回**同一 campaignId** 且都 CLAIMED。
//      此时网关侧无解（服务端语义），只能如实展示，不能承诺修复。
//   B) 号池里两个账号的 token 实际相同 —— 导入/续期环节串号。此时推理请求也会用错 token，
//      属于数据正确性缺陷，必须修（同型先例见 PR #135 对 raccoon 渠道 uid 的修法）。
//
// 网络：直连失败时自动尝试 HTTPS_PROXY / HTTP_PROXY 环境变量（走 https-proxy-agent 隧道）。
"use strict";
const crypto = require("node:crypto");
const https = require("node:https");
const os = require("node:os");

const fp = (s) => crypto.createHash("sha256").update(String(s || "")).digest("hex").slice(0, 12);
const line = (n = 70) => console.log("-".repeat(n));

/** 代理 agent（有环境变量才建；require 失败不阻断——直连仍可跑） */
function proxyAgent() {
  const url = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!url) return null;
  try {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    return new HttpsProxyAgent(url);
  } catch {
    return null;
  }
}

/** 最小 GET JSON（https + 可选代理隧道）；任何异常都归一成 {status,data,error} 不抛 */
function httpGetJson(url, headers, agent) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "GET", headers, agent, timeout: 20000 },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          buf += d;
        });
        res.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(buf);
          } catch {
            /* 非 JSON（HTML 错误页/空体）——raw 留片段供人工判断 */
          }
          resolve({ status: res.statusCode || 0, data, raw: buf.slice(0, 200) });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时（20s）")));
    req.on("error", (e) => resolve({ status: 0, data: null, error: String((e && e.message) || e) }));
    req.end();
  });
}

async function fetchCampaigns(adapter, secrets, risk, machineId, agent) {
  const c = adapter && adapter.cfg ? adapter.cfg() : {};
  const base = String(c.openApi || "https://openapi.qoder.sh").replace(/\/+$/, "");
  const hdrs = {
    Authorization: `Bearer ${secrets.token}`,
    Accept: "application/json",
    "User-Agent": c.userAgent || "Qoder",
    "Cosy-ClientType": "10",
    "Cosy-Version": c.cosyVersion || "0.4.3",
    "Cosy-MachineId": machineId || "",
    "Cosy-MachineOS": os.release(),
    "Cosy-MachineHostname": os.hostname(),
    "Cosy-MachineToken": (risk && risk.machineToken) || "",
    "Cosy-MachineType": (risk && risk.machineType) || "",
    "Cosy-MachineCode": (risk && risk.machineCode) || "",
  };
  return httpGetJson(`${base}/sash/api/v1/me/campaigns?forceRefresh=true`, hdrs, agent);
}

/** 从 campaigns 响应抽「领取态」摘要：同一 campaignId 出现在多个账号 = 服务端按机器去重 */
function campaignDigest(res) {
  if (!res || !res.data) return { error: (res && (res.error || `HTTP ${res.status}`)) || "无响应", items: [] };
  const list = Array.isArray(res.data.campaigns) ? res.data.campaigns : [];
  const items = list
    .filter((x) => x && (x.actionType === "CLAIM_BENEFIT" || x.claimStatus))
    .map((x) => ({ id: String(x.campaignId || ""), action: String(x.actionType || ""), status: String(x.claimStatus || ""), endAt: Number(x.endAt) || 0 }));
  return { items };
}

/**
 * 纯判据：rows = [{ acc:{uid,channel,name}, secrets:{token}, machineId, risk:{machineToken}, digest:{items} }]
 * 返回 { verdict:"B"|"A"|"unknown", evidence:[...] } —— 抽出来是为了可单测（--selftest）。
 */
function diagnose(rows) {
  if (!rows || rows.length < 2) return { verdict: "unknown", evidence: ["可诊断账号不足 2 个，无法做多账号对比"] };
  const tokenFps = new Set(rows.map((r) => fp(r.secrets && r.secrets.token)));
  const uids = new Set(rows.map((r) => (r.acc && r.acc.uid) || ""));
  const machineIds = new Set(rows.map((r) => r.machineId || ""));
  const riskTokens = new Set(rows.map((r) => (r.risk && fp(r.risk.machineToken)) || ""));
  const claimedSets = rows.map(
    (r) => new Set((((r.digest && r.digest.items) || []).filter((x) => x.action === "CLAIM_BENEFIT" && x.status === "CLAIMED")).map((x) => x.id))
  );
  const sharedClaimed = [...(claimedSets[0] || [])].filter((id) => id && claimedSets.slice(1).every((s) => s.has(id)));

  const evidence = [
    `账号数=${rows.length}`,
    `token 指纹唯一数=${tokenFps.size}`,
    `uid 唯一数=${uids.size}`,
    `machineId 唯一数=${machineIds.size}`,
    `风控身份唯一数=${riskTokens.size}`,
  ];
  if (tokenFps.size < rows.length) return { verdict: "B", evidence, sharedClaimed };
  if (sharedClaimed.length) return { verdict: "A", evidence, sharedClaimed };
  return { verdict: "unknown", evidence };
}

const VERDICT_TEXT = {
  A: [
    "★ 结论 A：不同账号的同一活动（campaignId=%s）都已是 CLAIMED。",
    "  即服务端把领取状态绑定到了机器风控身份（两账号 Cosy-Machine* 头逐字相同）。",
    "  网关侧无技术解，只能把「可能被同机其它账号占用」如实展示给用户。",
  ],
  B: [
    "★ 结论 B：号池里有账号共用同一 token（导入/续期串号）。",
    "  这是数据正确性缺陷——推理请求也会用错 token，不只是签到。",
    "  修法对齐 PR #135：核对 discovery 导入与续期链路的 uid 提取，确保按 JWT 账号字段去重。",
  ],
  unknown: [
    "★ 结论：待定。账号的 token/uid 各自独立，campaigns 也没有共享的已领活动。",
    "  请把上面的完整输出回传，并补充：当天是否两个账号都点过签到、各自的 campaigns 原始响应。",
  ],
};

async function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const auth = require("../electron/backend/proxy/qoderAuth.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");

  store.open();
  if (typeof rules.init === "function") rules.init();

  const want = process.argv[2] && !process.argv[2].startsWith("--") ? String(process.argv[2]) : "";
  const all = store.listAccounts();
  const accounts = all.filter((a) => (want ? a.channel === want : /^qoder/.test(a.channel)) && a.hasToken && a.status !== "disabled");

  console.log(`号池账号总数: ${all.length}；本次诊断目标: ${accounts.length} 个`);
  if (!accounts.length) {
    console.log("没有可诊断的 Qoder 账号（需已导入且未禁用）。请先在「号池」页导入 Qoder 账号后重跑。");
    return;
  }

  const agent = proxyAgent();
  if (agent) console.log(`（经代理 ${process.env.HTTPS_PROXY || process.env.HTTP_PROXY} 访问上游）`);

  const rows = [];
  for (const acc of accounts) {
    line();
    const row = store.getAccount(acc.id);
    const secrets = store.accountSecrets(row);
    const meta = secrets.meta || {};
    const machineId = meta.machineId || row.machineId || "";
    const risk = auth.readRiskIdentity ? auth.readRiskIdentity(acc.channel, acc.uid) : null;
    const adapter = adapters.get(acc.channel);

    console.log(`账号 ${acc.name || acc.id}  [${acc.channel}]  status=${acc.status}`);
    console.log(`  uid          = ${acc.uid || "(空)"}`);
    console.log(`  token 指纹    = ${fp(secrets.token)}  (长度 ${String(secrets.token || "").length})`);
    console.log(`  refresh 指纹  = ${fp(secrets.refreshToken)}`);
    console.log(`  machineId    = ${machineId || "(空)"}`);
    console.log(`  风控身份      = ${risk ? `machineToken=${fp(risk.machineToken)} type=${risk.machineType} code=${fp(risk.machineCode)}` : "不可用（客户端未装/已卸载）"}`);

    if (!adapter) {
      console.log("  ! 该渠道无适配器，跳过 campaigns 探测");
      rows.push({ acc, secrets, machineId, risk, digest: { error: "无适配器", items: [] } });
      continue;
    }
    const res = await fetchCampaigns(adapter, secrets, risk, machineId, agent);
    const digest = campaignDigest(res);
    console.log(`  campaigns HTTP ${res.status}${digest.error ? ` (${digest.error})` : ""}`);
    if (digest.items.length) {
      for (const it of digest.items) console.log(`    · ${it.id}  ${it.action}  ${it.status}  endAt=${it.endAt}`);
    } else if (res.data) {
      console.log(`    原始片段: ${JSON.stringify(res.data).slice(0, 200)}`);
    } else if (res.raw) {
      console.log(`    原始片段: ${res.raw}`);
    }
    rows.push({ acc, secrets, machineId, risk, digest });
  }

  line();
  console.log("诊断结论");
  line();
  const d = diagnose(rows);
  for (const e of d.evidence) console.log(`  ${e}`);
  console.log("");
  const text = VERDICT_TEXT[d.verdict];
  text.forEach((t, i) => console.log(i === 0 && t.includes("%s") ? t.replace("%s", d.sharedClaimed[0]) : t));
  line();
  console.log("提示：本脚本只读，未修改号池、未触发领取。");
}

/** 内置判据自测：构造 rows 断言 A / B / unknown 三条分支 */
function selftest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error("断言失败: " + msg);
    console.log("  ✓ " + msg);
  };
  const mk = (uid, token, machineToken, items) => ({
    acc: { uid, channel: "qoder_intl", name: uid },
    secrets: { token },
    machineId: "m-1",
    risk: { machineToken },
    digest: { items },
  });
  const claim = (id, status) => ({ id, action: "CLAIM_BENEFIT", status, endAt: 0 });

  console.log("[1] B 分支：两账号共用同一 token");
  let d = diagnose([mk("u1", "dt-same", "rk-1", []), mk("u2", "dt-same", "rk-1", [])]);
  assert(d.verdict === "B", "token 相同 → 判 B（串号）");

  console.log("[2] A 分支：token 不同但共享同一已领活动");
  d = diagnose([mk("u1", "dt-a", "rk-1", [claim("c-1", "CLAIMED")]), mk("u2", "dt-b", "rk-1", [claim("c-1", "CLAIMED")])]);
  assert(d.verdict === "A", "共享已领 campaignId → 判 A（服务端按机器去重）");

  console.log("[3] unknown：token 不同、活动也各自独立");
  d = diagnose([mk("u1", "dt-a", "rk-1", [claim("c-1", "CLAIMED")]), mk("u2", "dt-b", "rk-1", [claim("c-2", "CLAIMABLE")])]);
  assert(d.verdict === "unknown", "无共享证据 → 待定");

  console.log("[4] 账号不足时判 unknown");
  d = diagnose([mk("u1", "dt-a", "rk-1", [])]);
  assert(d.verdict === "unknown", "单账号 → 待定");

  console.log("\n[selftest] 4/4 通过");
}

if (process.argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("诊断失败：", (e && e.stack) || e);
    process.exit(1);
  });
