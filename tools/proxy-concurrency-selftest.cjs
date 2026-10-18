// 反代网关「单渠道并发上限」自测（issue #106）：并发闸门必须是**选路过滤器**而非全局 429 闸门。
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-concurrency-selftest.cjs
//
// 背景：旧实现 runtime.active 是全渠道共享的一个计数，且闸门在渠道解析之前——渠道 A 打满
// 会连带 429 渠道 B（哪怕 B 刚加、一个请求都没发过），文案还写成「上游并发已满」把责任推给上游。
//   B1 单渠道打满时，同模型的请求必须跳到**空闲备选渠道**出线（旧实现：全局 429）
//   B2 全部候选渠道都满时，才 429，且文案如实写「在途并发已满」并带渠道轨迹
//   B3 请求结束后计数必须归零（在途起算移入 try 后无泄漏；旧写法起算点在 try 外 109 行处）
//   B4 计数归零后同渠道立即可用（行为级证明 per-channel 计数有借有还）
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-conc-test-"));
process.env.APPDATA = tmp; // config.cjs 纯 Node 模式退回 %APPDATA%\AgentHub

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
    return true;
  }
  fail++;
  fails.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  return false;
}

async function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const server = require("../electron/backend/proxy/server.cjs");

  store.open();
  rules.init();

  // ===== 假上游：workbuddy / workbuddy_ai 各一条 SSE；按需把在途请求挂住以占满单渠道计数 =====
  const http = require("node:http");
  const hits = { wb: 0, wba: 0 };
  const hold = { wb: { on: false, waiters: [] }, wba: { on: false, waiters: [] } };
  const release = (k) => { while (hold[k].waiters.length) hold[k].waiters.shift()(); };
  const sse = 'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"shared-model","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n' +
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"shared-model","choices":[{"index":0,"delta":{"content":" "},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
    "data: [DONE]\n\n";
  const fake = http.createServer((req, res) => {
    const url = req.url || "";
    req.resume();
    req.on("end", async () => {
      const channel = url.includes("/wba/") ? "wba" : url.includes("/wb/") ? "wb" : "";
      if (!channel) { res.writeHead(404); res.end(); return; }
      hits[channel]++;
      if (hold[channel].on) await new Promise((r) => hold[channel].waiters.push(r));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });
  });
  await new Promise((r) => fake.listen(19561, "127.0.0.1", r));

  const headersPath = path.join(rules.rulesDir(), "headers.json");
  const headersCfg = JSON.parse(fs.readFileSync(headersPath, "utf8"));
  headersCfg.workbuddy.chatUrl = "http://127.0.0.1:19561/wb/chat";
  headersCfg.workbuddy_ai.consoleChatUrl = "";
  headersCfg.workbuddy_ai.chatUrl = "http://127.0.0.1:19561/wba/chat";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");

  // ===== 目录：shared-model 同时被两渠道拥有（打满时有备选可跳）=====
  const catFile = path.join(rules.rulesDir(), "catalog.json");
  const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
  const ent = { id: "shared-model", name: "shared-model", rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 };
  for (const ch of ["workbuddy", "workbuddy_ai"]) {
    if (!cat[ch]) cat[ch] = { syncedAt: 0, models: [] };
    cat[ch].models = [...(cat[ch].models || []), ent];
  }
  fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));
  rules.reload("catalog.json");

  // ===== 每渠道一个可用账号；Key 钉死 workbuddy 为主渠道（备选 workbuddy_ai）=====
  for (const [ch, uid, name] of [["workbuddy", "cc1", "WB号"], ["workbuddy_ai", "cc2", "WBA号"]]) {
    const id = store.addAccount({ channel: ch, uid, name, token: `${ch}-token`, source: "paste", expiresAt: Date.now() + 7200000 });
    store.updateAccount(id, { credits: 1000, creditsAt: Date.now() });
  }

  const cfg = {
    port: 19562, bind: "127.0.0.1", rateLimitPerMin: 120, concurrency: 1, // 每渠道上限 1：并发现场最容易构造
    routeStrategy: "smart", fixedChannel: "", modelOverrides: {}, debugStatus: false,
    humanizeJitter: false, disabledModels: [],
    routeOrder: "score", channelFailover: true, channelFailoverMax: 3,
    channelCooldownMs: 120000, channelCooldownCapMs: 600000,
  };
  const sr = await server.start(() => cfg);
  if (!sr.ok) throw new Error("网关启动失败: " + (sr.message || ""));
  const base = "http://127.0.0.1:19562";
  const k = store.createKey({ name: "并发自测", route: "workbuddy", dailyQuota: 0, rateLimit: 0 });
  const call = () =>
    fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + k.secret },
      body: JSON.stringify({ model: "shared-model", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
  /** 轮询等待条件成立（在途计数/上游命中都是异步落地的，轮询比 sleep 稳） */
  const until = async (cond, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      if (cond()) return true;
      if (Date.now() - t0 > ms) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const lastRow = () => store.recentRequests(1)[0];

  try {
    // ===== B1：wb 被占满（在途 1/1）→ 同模型请求必须跳到空闲的 wba 出线 =====
    hold.wb.on = true;
    let p1 = call();
    check("B1 前置：R1 已到 wb 假上游（单渠道在途已占满）", await until(() => hits.wb >= 1), JSON.stringify(hits));
    let r2 = await call();
    let body2 = await r2.text();
    check("B1 渠道打满不拒绝请求、跳空闲备选出线（旧实现：全局 429「上游并发已满」）", r2.status === 200, `${r2.status} ${body2.slice(0, 200)}`);
    check("B1 实际落在备选 workbuddy_ai", hits.wba >= 1 && hits.wb === 1, JSON.stringify(hits));
    check("B1 记账带 failover 轨迹", /failover:workbuddy→/.test(String((lastRow() || {}).error || "")), String((lastRow() || {}).error));

    // ===== B2：两个候选渠道都满 → 才 429，且文案如实归因到网关并发 =====
    hold.wba.on = true;
    let p4 = call();
    // 判据必须是「第 2 次」命中：第 1 次是 R2 贡献的，轮询它成立不代表 R4 已占到槽位
    check("B2 前置：R4 已到 wba（第二渠道在途也占满）", await until(() => hits.wba >= 2), JSON.stringify(hits));
    let r5 = await call();
    let body5 = await r5.text();
    check("B2 全部候选都满才 429", r5.status === 429, `${r5.status} ${body5.slice(0, 200)}`);
    check("B2 文案如实写「在途并发已满」并带渠道轨迹（不再冒充上游）", /在途并发已满/.test(body5) && /已尝试/.test(body5), body5.slice(0, 260));

    // ===== B3：放行后在途计数必须归零（泄漏面与租约同生命周期）=====
    // 先关开关再放行：waiters 是「已挂住的旧请求」，开关管的是「之后的新请求」——B4 要发新请求
    hold.wb.on = false;
    hold.wba.on = false;
    release("wb");
    release("wba");
    await p1;
    await p4;
    check("B3 请求全部结束后全局在途归零（在途起算移入 try 后无泄漏）", await until(() => server.status().active === 0), String(server.status().active));

    // ===== B4：计数归零后同渠道立即可用（行为级证明 per-channel 计数有借有还）=====
    let r6 = await call();
    const body6 = await r6.text();
    check("B4 归零后同渠道立即可用", r6.status === 200 && hits.wb === 2, `${r6.status} / ${JSON.stringify(hits)} / ${body6.slice(0, 220)} / row=${JSON.stringify((lastRow() || {}).error || "")}`);
  } finally {
    hold.wb.on = false;
    hold.wba.on = false;
    release("wb");
    release("wba");
    await server.stopAsync().catch(() => {});
    fake.close();
    fake.closeAllConnections?.();
  }

  console.log(`\n并发作用域自测：${pass} 通过 / ${fail} 失败${fails.length ? "\n  " + fails.join("\n  ") : ""}`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
