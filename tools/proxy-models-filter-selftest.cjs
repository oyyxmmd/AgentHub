// 反代网关 issue #90 自测：/v1/models 过滤空号池渠道 + fixed 策略不透传已关渠道 + 回退明示
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-models-filter-selftest.cjs
//
// 现象（GitHub issue #90）：没有有道号池时 /v1/models 仍返回该渠道模型；客户端访问该渠道
// 特有模型时希望拿到明确的错误码/信息，而不是上游透传错误或被静默回退。
// 渠道「被上游启闭关闭」的 models 过滤早已实现（listableModels 过滤 channelOn）；
// 本守卫锁的是剩下三块：
//   B1/B2 渠道启用但号池为空（无号/额度耗尽/全到期）→ /v1/models 不再返回其特有模型；
//         有任一可用来源渠道的模型保留（多源收窄语义不变）
//   B3    访问「目录里查得到但当前不可用」的模型 → 400 channel_disabled，文案给渠道名与指引，
//         与「模型真不存在」的 model_not_found 区分开
//   B4    fixed 策略下指定渠道被关闭 → 不再「透传试错」，直接业务码
//   B5    配了回退模型时静默换模型 → 响应头 x-agenthub-fallback 明示（保留回退可用性设计）
//
// 走真实 HTTP 链路（假上游 + 沙盒 APPDATA），断言收集式不 fail-fast。
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-models-filter-"));
process.env.APPDATA = tmp; // config.cjs 纯 Node 模式退回 %APPDATA%\AgentHub

let pass = 0, fail = 0; const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok  ${name}`); return; }
  fail++; fails.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
}

async function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const server = require("../electron/backend/proxy/server.cjs");

  // —— 安全闸门（与其余自测同款）：数据目录必须落在临时沙箱内，绝不触碰真实 stats.db/规则 ——
  const path = require("node:path");
  const proxyDir = path.resolve(store.proxyDir()).toLowerCase();
  const inSandbox = proxyDir.startsWith(path.resolve(tmp).toLowerCase());
  if (!inSandbox) { console.error("拒绝运行：数据目录不在沙箱内（" + proxyDir + "）"); process.exit(2); }

  store.open();
  rules.init();

  // ===== 假上游：trae / workbuddy / workbuddy_ai 指向本机 =====
  const http = require("node:http");
  const hits = { trae: 0, wb: 0, wba: 0 };
  const fake = http.createServer((req, res) => {
    const url = req.url || "";
    req.on("data", () => {});
    req.on("end", () => {
      const channel = url.includes("/tr/") ? "trae" : url.includes("/wba/") ? "wba" : url.includes("/wb/") ? "wb" : "";
      if (!channel) { res.writeHead(404); res.end(); return; }
      hits[channel]++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (channel === "trae") {
        res.end(
          "event: metadata\n" + 'data: {"conversation_id":"c1"}\n\n' +
          "event: output\n" + 'data: {"response":"TRAEO"}\n\n' +
          "event: token_usage\n" + 'data: {"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}\n\n' +
          "event: done\n" + 'data: {"finish_reason":"stop"}\n\n'
        );
      } else {
        res.end(
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"shared-model","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n' +
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"shared-model","choices":[{"index":0,"delta":{"content":" "},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
          "data: [DONE]\n\n"
        );
      }
    });
  });
  await new Promise((r) => fake.listen(19551, "127.0.0.1", r));

  const headersPath = path.join(rules.rulesDir(), "headers.json");
  const headersCfg = JSON.parse(fs.readFileSync(headersPath, "utf8"));
  headersCfg.trae.chatUrl = "http://127.0.0.1:19551/tr/chat";
  headersCfg.trae.mirrorChatUrl = "";
  headersCfg.workbuddy.chatUrl = "http://127.0.0.1:19551/wb/chat";
  headersCfg.workbuddy_ai.consoleChatUrl = "";
  headersCfg.workbuddy_ai.chatUrl = "http://127.0.0.1:19551/wba/chat";
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");

  // ===== 目录：shared-model 多源（trae/workbuddy/workbuddy_ai）；ai-only-model 仅 workbuddy_ai =====
  const catFile = path.join(rules.rulesDir(), "catalog.json");
  const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
  const ent = (id) => ({ id, name: id, rate: null, capabilities: {}, contextLength: 0, maxOutputTokens: 0 });
  for (const ch of ["trae", "workbuddy", "workbuddy_ai"]) {
    if (!cat[ch]) cat[ch] = { syncedAt: 0, models: [] };
    cat[ch].models = [...(cat[ch].models || []), ent("shared-model")];
  }
  cat.workbuddy_ai.models = [...cat.workbuddy_ai.models, ent("ai-only-model")];
  fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));
  rules.reload("catalog.json");

  // 唯一可用账号在 workbuddy；trae / workbuddy_ai 号池全空
  const w1 = store.addAccount({ channel: "workbuddy", uid: "mf1", name: "可用号", token: "wb-token", source: "paste", expiresAt: Date.now() + 7200000 });
  store.updateAccount(w1, { credits: 1000, creditsAt: Date.now() });

  const cfg = {
    port: 19552, bind: "127.0.0.1", rateLimitPerMin: 120, concurrency: 8,
    routeStrategy: "smart", fixedChannel: "trae", modelOverrides: {}, debugStatus: false,
    humanizeJitter: false, disabledModels: [], channelEnabled: {},
    routeOrder: "score", channelFailover: true, channelFailoverMax: 3,
    channelCooldownMs: 120000, channelCooldownCapMs: 600000,
    autoFallbackEnabled: true, fallbackModel: "",
  };
  const sr = await server.start(() => cfg);
  if (!sr.ok) throw new Error("网关启动失败: " + (sr.message || ""));
  const base = "http://127.0.0.1:19552";
  const k = store.createKey({ name: "models 过滤自测", route: "auto", dailyQuota: 0, rateLimit: 0 });
  const getModels = async () => {
    const r = await fetch(base + "/v1/models");
    const j = await r.json();
    return (j.data || []).map((m) => m.id);
  };
  const call = (payload) =>
    fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + k.secret },
      body: JSON.stringify(payload),
    });
  const bodyMsg = [{ role: "user", content: "hi" }];
  const ids = (arr) => JSON.stringify(arr.slice().sort());

  try {
    // ===== B1 有可用渠道的模型列出，空池渠道的特有模型不列 =====
    let models = await getModels();
    check("B1 可用渠道拥有的模型在列", models.includes("shared-model"), ids(models));
    check("B1 空池渠道特有模型不列（ai-only-model 仅 workbuddy_ai 且空池）", !models.includes("ai-only-model"), ids(models));

    // ===== B2 关闭唯一可用渠道 → 模型从目录消失 =====
    cfg.channelEnabled = { workbuddy: false };
    models = await getModels();
    check("B2 渠道关闭后其模型不再返回（多源也全灭）", !models.includes("shared-model"), ids(models));
    check("B2 目录未整体清空（trae 空池不列、目录机制仍工作）", Array.isArray(models), ids(models));

    // ===== B3 访问「查得到但当前不可用」的模型 → 400 channel_disabled + 指引文案 =====
    // （关闭 shared-model 的全部归属渠道：owners 全灭走 resolveChannel 空路径，
    //   与「部分归属渠道还开着只是空池 → 正常 503」是两条不同路径）
    cfg.channelEnabled = { workbuddy: false, trae: false, workbuddy_ai: false };
    let rr = await call({ model: "shared-model", stream: false, messages: bodyMsg });
    let body = await rr.text();
    check("B3 状态码 400 + channel_disabled", rr.status === 400 && /channel_disabled/.test(body), `${rr.status} ${body.slice(0, 200)}`);
    check("B3 文案报渠道名与上游启闭指引", /上游启闭/.test(body) && (/Trae/i.test(body) || /WorkBuddy/i.test(body)), body.slice(0, 240));
    check("B3 未发起上游请求", hits.wb === 0 && hits.wba === 0 && hits.trae === 0, JSON.stringify(hits));

    // ===== B4 fixed 策略 + 指定渠道被关 + 未知模型 → 不再透传试错 =====
    cfg.routeStrategy = "fixed";
    cfg.fixedChannel = "workbuddy";
    rr = await call({ model: "totally-unknown-model", stream: false, messages: bodyMsg });
    body = await rr.text();
    check("B4 fixed 渠道被关 → 400 channel_disabled（旧实现透传试错）", rr.status === 400 && /channel_disabled/.test(body), `${rr.status} ${body.slice(0, 220)}`);
    check("B4 未发起上游请求", hits.wb === 0 && hits.trae === 0 && hits.wba === 0, JSON.stringify(hits));

    // ===== B5 回退模型可用时静默换模型 → 响应头明示 =====
    cfg.routeStrategy = "smart";
    cfg.channelEnabled = {};
    cfg.fallbackModel = "shared-model";
    rr = await call({ model: "ai-only-model", stream: false, messages: bodyMsg });
    body = await rr.text();
    check("B5 回退成功 200", rr.status === 200, `${rr.status} ${body.slice(0, 160)}`);
    check("B5 响应头明示回退", (rr.headers.get("x-agenthub-fallback") || "").includes("ai-only-model"), String(rr.headers.get("x-agenthub-fallback")));
    cfg.fallbackModel = "";

    // ===== B6 号池动态性：删光账号（=没有号池）→ 不列；重新有号 → 列出 =====
    store.removeAccount(w1);
    models = await getModels();
    check("B6 删光账号（没有号池）→ 不列", !models.includes("shared-model"), ids(models));
    const w2 = store.addAccount({ channel: "workbuddy", uid: "mf2", name: "恢复号", token: "wb-token2", source: "paste", expiresAt: Date.now() + 7200000 });
    models = await getModels();
    check("B6 重新有号 → 列出", models.includes("shared-model"), ids(models));

    // ===== B7 有号但暂时不可用（耗尽/冷却/停用）→ 仍列出，请求给明确错误 =====
    // 「没有号池」才隐藏；全渠道临时不可用时客户端模型列表不能整体闪没
    store.updateAccount(w2, { credits: 0, creditsAt: Date.now() });
    models = await getModels();
    check("B7 余额耗尽但号还在 → 仍列出", models.includes("shared-model"), ids(models));
    rr = await call({ model: "shared-model", stream: false, messages: bodyMsg });
    check("B7 耗尽请求得到明确错误（非 404/无模型）", rr.status === 502 || rr.status === 503 || rr.status === 402, String(rr.status));
    store.updateAccount(w2, { status: "disabled" });
    models = await getModels();
    check("B7 账号停用但号池仍在 → 仍列出", models.includes("shared-model"), ids(models));
  } finally {
    await server.stopAsync().catch(() => {});
    fake.close();
  }

  console.log("");
  console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail) { console.log("失败项：\n  - " + fails.join("\n  - ")); process.exit(1); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(2); });
