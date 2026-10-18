// WorkBuddy 账号级风控拦截（403 code 11140）自测：
//   ① 渠道级分类：11140 → account_blocked（换号 + 立即冷却 + 真话文案），别的 403/5xx 不误判；
//   ② 探活 probeChat：被拦号 blocked、好号 ok、网络不通 inconclusive（探活失败不得否决切号）；
//   ③ 网关端到端：被拦号在池里排前面 → 请求内换号成功，被拦号落 2h 冷却且理由是真话；
//   ④ 全池都是被拦号 → 回给调用方的错误必须点明风控，**不得**出现上游那句「内容未通过安全审核」；
//   ⑤ 切号预检：被拦号不写本地客户端（拦在写文件/动进程之前）。
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-wb-blocked-selftest.cjs <临时数据目录>
//
// ⑤ 只覆盖「被拦」这一条路径，这是刻意的：放行路径会真的去关/拉 WorkBuddyAI.exe，
// 自测不许碰用户正在用的客户端（被拦路径在动任何进程与文件之前就返回了）。
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-wb-blocked-"));
process.env.APPDATA = tmp; // config.cjs 纯 Node 模式退回 %APPDATA%\AgentHub
process.env.LOCALAPPDATA = path.join(tmp, "LocalAppData"); // 切号预检的登录文件目录一并隔离

let pass = 0;
let fail = 0;
const failures = [];
function T(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ok  ${name}`); })
    .catch((e) => { fail++; failures.push(`${name}: ${(e && e.message) || e}`); console.log(`FAIL  ${name}: ${(e && e.message) || e}`); });
}

/** 上游 11140 的真实响应体（照抄线上报文：displayMsg 是那句误导性的内容审核文案） */
const BLOCKED_BODY = JSON.stringify({
  code: 11140,
  msg: "request illegal",
  requestId: "b9046fb9-fde7-4e0a-869f-93f3d4868f87",
  displayMsg: {
    en: "The content did not pass the safety review. Please adjust and retry.",
    zh: "内容未通过安全审核，请调整后重试。",
    zh_hant: "內容未通過安全審核，請調整後重試。",
  },
  actions: ["SUBMIT_FEEDBACK", "COPY_ERROR", "EDIT_INPUT"],
});

const SSE_OK =
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"default-model","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}\n\n' +
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"default-model","choices":[{"index":0,"delta":{"content":" ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
  "data: [DONE]\n\n";

async function main() {
  const assert = (cond, msg) => { if (!cond) throw new Error("断言失败: " + msg); };
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const pool = require("../electron/backend/proxy/pool.cjs");
  const server = require("../electron/backend/proxy/server.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const ideswitch = require("../electron/backend/proxy/ideswitch.cjs");

  store.open();
  rules.init();

  // ===== 假上游：按 authorization 里的 token 分辨账号 =====
  const hits = { blocked: 0, good: 0 };
  const shapeRejects = { n: 0 };
  const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const auth = String(req.headers.authorization || "");
      const who = auth.includes("blocked-token") ? "blocked" : auth.includes("good-token") ? "good" : "";
      if (!who) { res.writeHead(401); res.end('{"error":"unknown token"}'); return; }
      hits[who]++;
      // 复刻上游的校验顺序：先形状、后风控。体形状不对只回 11128，根本到不了 11140 那道闸
      // （探活请求体若不带 system 首条，就会卡在这一关而误报 inconclusive——这条规则守的就是它）
      let firstRole = "";
      try { firstRole = String((JSON.parse(Buffer.concat(chunks).toString("utf8")).messages || [])[0]?.role || ""); } catch { /* 非法体下面照样按形状拒 */ }
      if (firstRole !== "system") {
        shapeRejects.n++;
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"code":11128,"msg":"first message is not system prompt"}');
        return;
      }
      if (who === "blocked") {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(BLOCKED_BODY);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE_OK);
    });
  });
  await new Promise((r) => fake.listen(19533, "127.0.0.1", r));

  const headersPath = path.join(rules.rulesDir(), "headers.json");
  const headersCfg = JSON.parse(fs.readFileSync(headersPath, "utf8"));
  headersCfg.workbuddy_ai.consoleChatUrl = ""; // console 候选置空，请求只打假上游
  headersCfg.workbuddy_ai.chatUrl = "http://127.0.0.1:19533/wba/chat";
  headersCfg.workbuddy.chatUrl = "http://127.0.0.1:19533/wba/chat";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");

  const wbAi = adapters.get("workbuddy_ai");

  // ===== ① 渠道级分类 =====
  await T("T1 11140（code 通道 / body 通道 / 文案通道）都判 account_blocked，可换号", () => {
    for (const e of [
      { code: 11140 },
      { status: 403, body: BLOCKED_BODY },
      { status: 403, message: `上游 HTTP 403：${BLOCKED_BODY.slice(0, 120)}` },
      { status: 403, body: '{"code":11140,"msg":"request illegal"}' },
    ]) {
      const cls = wbAi.classifyError(e);
      assert(cls && cls.kind === "account_blocked", `应判 account_blocked：${JSON.stringify(e).slice(0, 80)}`);
      assert(cls.switchable === true && cls.status === 403, "account_blocked 必须可换号且状态码 403");
    }
  });
  await T("T2 其它错误不误判（5xx / 普通 403 / 11128 / 11102）", () => {
    for (const e of [
      { status: 500, message: "上游 HTTP 500：boom" },
      { status: 403, message: "上游 HTTP 403：forbidden" },
      { status: 400, body: '{"code":11128,"msg":"unapproved channel"}' },
      { status: 404, body: '{"code":11102,"msg":"service info not found"}' },
      null,
    ]) {
      assert(wbAi.classifyError(e) === null, `不该判 account_blocked：${JSON.stringify(e)}`);
    }
  });
  await T("T3 分类是渠道私有扩展点：其它渠道不得跟着变", () => {
    assert(typeof adapters.get("trae").classifyError !== "function", "trae 不应有 classifyError");
    assert(typeof adapters.get("raccoon").classifyError !== "function", "raccoon 不应有 classifyError");
  });

  // ===== ② 探活 =====
  const blockedId = store.addAccount({
    channel: "workbuddy_ai", uid: "fw-blocked", name: "被拦号",
    token: "blocked-token", source: "paste", expiresAt: Date.now() + 3600000,
  });
  const goodId = store.addAccount({
    channel: "workbuddy_ai", uid: "fw-good", name: "好号",
    token: "good-token", source: "paste", expiresAt: Date.now() + 7200000,
  });

  await T("T4 probeChat：被拦号 blocked、好号 ok", async () => {
    const b = await wbAi.probeChat(store.getAccount(blockedId), store.accountSecrets(store.getAccount(blockedId)));
    assert(b.ok === false && b.blocked === true, "被拦号必须 blocked: " + JSON.stringify(b));
    const g = await wbAi.probeChat(store.getAccount(goodId), store.accountSecrets(store.getAccount(goodId)));
    assert(g.ok === true, "好号探活必须通过: " + JSON.stringify(g));
  });
  await T("T5 probeChat：CN 区也走同一条探活（请求体必须过形状关，否则摸不到风控闸）", async () => {
    const wb = adapters.get("workbuddy");
    const r = await wb.probeChat({ channel: "workbuddy", uid: "fwcn", name: "CN号" }, { token: "good-token", refreshToken: "", meta: {} });
    assert(r.ok === true, "CN 探活应通过（假上游按 system 首条放行）: " + JSON.stringify(r));
    const rb = await wb.probeChat({ channel: "workbuddy", uid: "fwcn2", name: "CN被拦号" }, { token: "blocked-token", refreshToken: "", meta: {} });
    assert(rb.ok === false && rb.blocked === true, "CN 区被拦号同样要认出来: " + JSON.stringify(rb));
    assert(shapeRejects.n === 0, "探活请求体不该被形状关拒（system 首条缺失）: " + shapeRejects.n);
  });
  await T("T6 probeChat：上游不可达 → inconclusive（探活失败不等于账号坏）", async () => {
    const wb = adapters.get("workbuddy");
    const backup = headersCfg.workbuddy.chatUrl;
    headersCfg.workbuddy.chatUrl = "http://127.0.0.1:19599/dead"; // 关闭端口
    fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
    rules.reload("headers.json");
    try {
      const r = await wb.probeChat({ channel: "workbuddy", uid: "u", name: "n" }, { token: "blocked-token", refreshToken: "", meta: {} });
      assert(r.ok === false && r.inconclusive === true && !r.blocked, "网络失败必须 inconclusive: " + JSON.stringify(r));
    } finally {
      headersCfg.workbuddy.chatUrl = backup;
      fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
      rules.reload("headers.json");
    }
  });

  // ===== ③ 网关端到端 =====
  const cfg = {
    port: 19534, bind: "127.0.0.1", rateLimitPerMin: 120, concurrency: 8,
    routeStrategy: "smart", fixedChannel: "workbuddy_ai", modelOverrides: {}, debugStatus: false,
    humanizeJitter: false, disabledModels: [], channelFailover: false,
  };
  const sr = await server.start(() => cfg);
  assert(sr.ok, "网关启动: " + (sr.message || ""));
  const base = "http://127.0.0.1:19534";
  const k = store.createKey({ name: "wb拦截自测", route: "auto", dailyQuota: 0, rateLimit: 0 });
  const call = () =>
    fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + k.secret },
      body: JSON.stringify({ model: "glm-5.3", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });

  await T("T7 池内换号：被拦号打头 → 请求内换到好号成功，被拦号落 2h 冷却且理由是真话", async () => {
    hits.blocked = 0; // T4 的探活也打过假上游，这里从零开始数
    hits.good = 0;
    const r = await call();
    assert(r.status === 200, "请求应成功: " + r.status);
    const j = await r.json();
    assert(j.choices && j.choices[0].message.content.includes("pong"), "内容应来自好号: " + JSON.stringify(j).slice(0, 120));
    assert(hits.blocked === 1 && hits.good === 1, "上游各打一次（被拦一次 + 好号一次）: " + JSON.stringify(hits));
    const row = store.recentRequests(1)[0];
    assert(row.accountId === goodId, "记账应归因好号: " + row.accountId);
    const acc = store.listAccounts("workbuddy_ai").find((a) => a.id === blockedId);
    assert(acc.status === "cooling", "被拦号必须立刻冷却（不再每请求白撞）: " + acc.status);
    assert(/风控/.test(acc.coolReason) && /11140/.test(acc.coolReason), "冷却理由必须是真话: " + acc.coolReason);
    const left = acc.coolUntil - Date.now();
    assert(left > 90 * 60000 && left <= 2 * 3600000, "冷却时长应约 2h（不是默认 60s）: " + Math.round(left / 60000) + "min");
  });

  await T("T8 全池被拦：回给调用方的错误点明风控，且不得出现上游那句内容审核文案", async () => {
    store.updateAccount(goodId, { status: "disabled" });
    store.updateAccount(blockedId, { status: "online", coolUntil: 0, coolReason: "" });
    hits.blocked = 0;
    const r = await call();
    assert(r.status !== 200, "全池被拦时必须失败: " + r.status);
    const txt = await r.text();
    assert(/风控/.test(txt) && /11140/.test(txt), "错误必须点明风控与 11140: " + txt.slice(0, 200));
    assert(!/内容未通过安全审核/.test(txt), "不得把上游那句误导性文案原样透传: " + txt.slice(0, 200));
    assert(!/safety review/.test(txt), "英文误导文案同样不得透传: " + txt.slice(0, 200));
    const acc = store.listAccounts("workbuddy_ai").find((a) => a.id === blockedId);
    assert(acc.status === "cooling" && /风控/.test(acc.coolReason), "全池被拦时也要落冷却: " + acc.status);
  });

  // ===== ⑤ 切号预检 =====
  await T("T9 切号预检：被拦号不写本地客户端（拦在动文件/动进程之前）", async () => {
    store.updateAccount(blockedId, { status: "online", coolUntil: 0, coolReason: "" });
    const r = await ideswitch.switchIdeAccount(blockedId, { confirmAck: true });
    assert(r.ok === false, "被拦号切号必须被拦下: " + JSON.stringify(r).slice(0, 160));
    assert(/风控/.test(r.message) && /11140/.test(r.message), "拦下理由要点明风控: " + r.message);
    assert(/未改动任何文件/.test(r.message), "必须如实说明没动任何文件: " + r.message);
    const authDir = path.join(process.env.LOCALAPPDATA, "CodeBuddyExtension", "Data", "Public", "auth");
    assert(!fs.existsSync(authDir), "登录文件目录不该被创建: " + authDir);
  });

  await server.stopAsync();
  await new Promise((r) => fake.close(r));
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log(failures.join("\n"));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("自测异常：", (e && e.stack) || e);
  process.exit(1);
});
