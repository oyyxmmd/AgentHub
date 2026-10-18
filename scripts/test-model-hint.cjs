// 反代网关 · 未知模型提示自测（issue #117）
// 运行：node scripts/test-model-hint.cjs
// 隔离：APPDATA 指到 mkdtemp 出来的临时目录；端口 19575（与其它闸错开）
//
// 背景：用户报「WorkBuddy 里明明有 deepseek4.1，网关却说找不到」。查下来模型确实在目录里
// （workbuddy_ai 区的 deepseek-v4.1-flash），真正的坑是**名字**——漏后缀、写简写、
// 分隔符不一致（gpt5 vs gpt-5）。此时原先只回一长串可用模型，人眼在那串里对不上，
// 用户的第一反应是「网关不支持这个模型」。
//
// 现在先给最接近的几个（nearModelIds），再给全量列表。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-modelhint-"));

const PORT = 19575;

let pass = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", msg);
  } else {
    failed++;
    console.log("  \u2717", msg, got !== undefined ? `→ got ${JSON.stringify(got).slice(0, 260)}` : "");
  }
}

const store = require("../electron/backend/proxy/store.cjs");
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

(async () => {
  // ===== ① 形近匹配（纯函数）=====
  console.log("① 形近匹配（纯函数）:");
  const all = [{ id: "deepseek-v4.1-flash" }, { id: "claude-sonnet-4.5" }, { id: "gpt-5" }, { id: "kimi-k2.8-preview" }];
  ok(server.nearModelIds("deepseek-v4.1", all).join() === "deepseek-v4.1-flash", "漏后缀：deepseek-v4.1 → deepseek-v4.1-flash");
  ok(server.nearModelIds("claude-sonnet", all).join() === "claude-sonnet-4.5", "少一段：claude-sonnet → claude-sonnet-4.5");
  ok(server.nearModelIds("gpt5", all).join() === "gpt-5", "只差分隔符：gpt5 → gpt-5");
  ok(server.nearModelIds("Claude-Sonnet", all).join() === "claude-sonnet-4.5", "大小写不敏感");
  ok(server.nearModelIds("nope-xyz", all).length === 0, "完全不像 → 空（不乱猜）");
  ok(server.nearModelIds("", all).length === 0, "空串 → 空");
  ok(server.nearModelIds("model", []).length === 0, "目录为空 → 空");
  // 短名的误报：归一后 <4 时不做「包含」判定——一个 "a" 会命中目录里所有含 a 的模型，
  // 三个名额被毫无关系的名字占满，提示反而变成噪音（比不提示更误导）
  ok(server.nearModelIds("a", [{ id: "a-b" }, { id: "a-c" }, { id: "a-d" }, { id: "a-e" }]).length === 0, "归一后过短（<4）不做包含判定：一个 \"a\" 不该把无关模型全列出来");
  ok(server.nearModelIds("gpt-5", [{ id: "gpt5" }, { id: "zzz" }]).join() === "gpt5", "归一后完全相同仍命中（只差分隔符的误用照旧提示）");
  ok(server.nearModelIds("gpt5", [{ id: "gpt5-a" }, { id: "gpt5-b" }, { id: "gpt5-c" }, { id: "gpt5-d" }]).length === 3, "最多只给 3 个（不刷屏）");
  // 目录顺序随机，不排序时更接近的名字可能被挤在三个名额之外
  ok(server.nearModelIds("claude-sonnet", [{ id: "claude-sonnet-4.5-20260101" }, { id: "claude-sonnet-4.5" }])[0] === "claude-sonnet-4.5", "更接近的排前面（长度差小者优先）");

  // ===== ② 端到端：真 HTTP 打进真调度核心 =====
  console.log("\n② 端到端·未知模型提示:");
  store.open();
  const gwKey = store.createKey({ name: "modelhint-e2e", route: "auto", dailyQuota: 0, rateLimit: 0 });
  const SETTINGS = () => ({
    port: PORT, bind: "127.0.0.1", rateLimitPerMin: 0, concurrency: 8,
    routeStrategy: "smart", fixedChannel: "", modelOverrides: {}, debugStatus: false,
    humanizeJitter: false, disabledModels: [], modelFallback: {}, modelAliases: {},
    channelCooldownMs: 1, channelCooldownCapMs: 1,
  });
  const sr = await server.start(SETTINGS);
  ok(sr.ok === true && sr.port === PORT, "端到端：网关在测试端口起来", sr);

  const MSG = (model) => ({ model, max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] });

  {
    const res = await post(MSG("deepseek-v4.1"), { "x-api-key": gwKey.secret });
    ok(res.status === 400, "未知模型 → 400", res.status);
    ok(/model_not_found|invalid_request_error/.test(res.text), "错误类型是 model_not_found / invalid_request_error", res.text.slice(0, 160));
    ok(/相近的模型有：/.test(res.text), "提示里出现「相近的模型有：」", res.text.slice(0, 260));
    ok(/deepseek-v4\.1-flash/.test(res.text), "形近模型正是 deepseek-v4.1-flash（漏后缀的典型误用）", res.text.slice(0, 260));
  }
  {
    // 完全不像的模型：不该乱猜，但仍要给全量可用列表
    const res = await post(MSG("zzz-not-a-real-model"), { "x-api-key": gwKey.secret });
    ok(res.status === 400, "无相似项时仍 400", res.status);
    ok(!/相近的模型有：/.test(res.text), "没有形近项就不出现「相近的模型有：」（避免噪声）", res.text.slice(0, 200));
    ok(/可用模型：/.test(res.text), "仍然给出可用模型列表", res.text.slice(0, 200));
  }

  console.log(`\n${failed ? "\u2717" : "OK"} 未知模型提示自测：${pass} 项通过，${failed} 项失败`);
  await server.stopAsync().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("自测异常：", (e && e.stack) || e);
  process.exit(1);
});
