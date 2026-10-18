// 反代网关 · 协议转换损失落库自测（issue #126）
// 运行：node scripts/test-conv-notes-log.cjs
// 隔离：APPDATA 指到 mkdtemp 出来的临时目录；端口 19573（避开 dev-sink-golden 的 19551
//       与 dev-anthropic-in-test 的 19571，可并发跑）
//
// 背景：/v1/messages 与 /v1/responses 的入站归一是有损的——thinking.signature 无法伪造、
// document 块没有 OpenAI 对应物、hosted_tool 退化成 auto。这些损失原先只进 console.warn，
// 用户看到「同一段对话在官方能跑、走网关差一点」却无处查证。
//
// 现在一并落进该请求的**操作日志行 detail**（issue #126 作者给的三个选项里选 op_logs）：
// 不动 usage_requests 表结构（加列要走 DB 迁移），日志页本来就有 detail 的展示位。
// 两个新端点共用 handleChat 的 record 路径，这里以 /v1/messages 为代表验证。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-convnotes-"));

const PORT = 19573;
const MODEL = "glm-4.6";

let pass = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", msg);
  } else {
    failed++;
    console.log("  \u2717", msg, got !== undefined ? `→ got ${JSON.stringify(got).slice(0, 220)}` : "");
  }
}

const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const server = require("../electron/backend/proxy/server.cjs");

function post(body, headers) {
  return new Promise((resolve, reject) => {
    const h = { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(headers || {}) };
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/v1/messages", method: "POST", headers: h }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.setTimeout(15000, () => req.destroy(new Error("请求 15s 无响应")));
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

const MSG = (extra) => Object.assign({ model: MODEL, max_tokens: 512, stream: true, messages: [{ role: "user", content: "hi" }] }, extra || {});

/** assistant 消息里带 thinking 块 —— 入站归一必然产出一条转换损失 note */
const WITH_THINKING = [
  { role: "user", content: "hi" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先想想", signature: "sig-xyz" },
      { type: "text", text: "好的" },
    ],
  },
];

(async () => {
  store.open();
  const gwKey = store.createKey({ name: "convnotes-e2e", route: "auto", dailyQuota: 0, rateLimit: 0 });
  const secret = gwKey.secret;

  // ===== 打桩：上游与号池（照 dev-anthropic-in-test 的口径，只留单渠道单账号）=====
  const accounts = { acc1: { id: "acc1", channel: "trae", name: "一号", status: "online" } };
  let pickIdx = 0;
  let callIdx = 0;

  const raw = {
    adaptersGet: adapters.get,
    adaptersOwners: adapters.modelOwners,
    poolPick: pool.pickAccount,
  };
  adapters.modelOwners = (model) => (String(model) === MODEL ? ["trae"] : raw.adaptersOwners(model));
  adapters.get = (channel) => {
    const real = raw.adaptersGet(channel);
    if (!real) return real;
    return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      chat: async (ctx) => {
        callIdx += 1;
        // 一句话的正常回答：让请求走完整成功路径（200 + usage），而不是靠失败路径凑一条日志
        ctx.emit({ type: "delta", delta: { role: "assistant", content: "" } });
        ctx.emit({ type: "delta", delta: { content: "收到" } });
        ctx.emit({ type: "finish", reason: "stop" });
        ctx.emit({ type: "usage", usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
        return { status: 200, planLimit: false };
      },
    });
  };
  adapters.refreshTokenLocked = async () => ({ ok: false });
  pool.pickAccount = (channel, strategy, exclude) => {
    pickIdx += 1;
    if (pickIdx > 1) return null;
    if ((exclude || []).includes("acc1")) return null;
    return accounts.acc1;
  };
  pool.acquireAccount = () => {};
  pool.releaseAccount = () => {};
  pool.isModelCooled = () => false;
  pool.noteSuccess = () => {};
  pool.noteSessionDead = () => false;
  pool.noteServerError = () => 0;
  pool.softBackoffMs = () => 1000;
  pool.coolAccount = () => {};
  pool.coolAccountModel = () => {};
  pool.coolAccountMs = () => {};
  pool.poolSummary = (channel) => ({ channel, onlineCount: 1, totalCredits: 100, accountCount: 1, todayReq: 0, todayTokens: 0, lastCreditsAt: 0, earliestExpire: 0, expiringSoon: false });
  store.getAccount = (id) => ({ id: String(id), channel: "trae", token_enc: "", refresh_enc: "", meta: "", status: "online" });
  store.accountSecrets = () => ({ token: "tok", refreshToken: "ref" });
  store.updateAccount = () => true;
  store.bumpAccountUsage = () => {};
  store.noteError = () => {};
  store.keyTodayReq = () => 0;

  const SETTINGS = () => ({
    port: PORT, bind: "127.0.0.1", rateLimitPerMin: 0, concurrency: 8,
    routeStrategy: "smart", fixedChannel: "trae", modelOverrides: {}, debugStatus: false,
    humanizeJitter: false, disabledModels: [], modelFallback: {}, modelAliases: {},
    channelCooldownMs: 1, channelCooldownCapMs: 1,
  });

  const latestLog = () => store.listOpLogs({ op: "代理请求", limit: 1 }).rows[0] || {};

  const sr = await server.start(SETTINGS);
  ok(sr.ok === true && sr.port === PORT, "端到端：网关在测试端口起来", sr);

  console.log("\n[1] 带 thinking 块 → 转换损失进操作日志");
  {
    pickIdx = 0;
    callIdx = 0;
    const res = await post(MSG({ messages: WITH_THINKING }), { "x-api-key": secret });
    ok(res.status === 200, "请求正常返回 200（损失不影响响应本身）", res.status);
    const log = latestLog();
    ok(!!log.message, "该请求落了一条操作日志", log);
    ok(/thinking\.signature/.test(String(log.detail || "")), "日志 detail 带上了转换损失", log.detail);
    ok(String(log.channel || "") === "trae", "日志行仍带渠道信息（没被损失串掉）", log.channel);
  }

  console.log("\n[2] 普通请求（无损失）→ detail 不带转换损失");
  {
    pickIdx = 0;
    callIdx = 0;
    const res = await post(MSG(), { "x-api-key": secret });
    ok(res.status === 200, "普通请求 200", res.status);
    const log = latestLog();
    ok(!/thinking\.signature/.test(String(log.detail || "")), "无损失时 detail 不出现损失字样", log.detail);
  }

  console.log("\n[3] 多种损失一次请求 → 全部落进同一行");
  {
    pickIdx = 0;
    callIdx = 0;
    const multi = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "想", signature: "s" },
          { type: "redacted_thinking", data: "xx" },
          { type: "text", text: "答" },
        ],
      },
    ];
    const res = await post(MSG({ messages: multi }), { "x-api-key": secret });
    ok(res.status === 200, "多损失请求 200", res.status);
    const d = String(latestLog().detail || "");
    ok(/thinking\.signature/.test(d) && /redacted_thinking/.test(d), "两条损失都在 detail 里（用 · 连接）", d);
  }

  console.log(`\n${failed ? "\u2717" : "OK"} 转换损失落库自测：${pass} 项通过，${failed} 项失败`);
  await server.stopAsync().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("自测异常：", (e && e.stack) || e);
  process.exit(1);
});
