// WorkBuddy 国际版「每日活跃」保活自测：验证三条通道各自的请求形状、错误容错与汇总口径。
//
// 依据：上游保活接口（issue #277 的实测结论）——
//   ① POST /v2/report            活跃上报（chat_request_send 事件数组）→ 点亮连登 streak
//   ② POST {chat}/chat/completions  免费模型最小对话（维持「账号有调用」）
//   ③ POST /console/as/conversations/  网页会话（**每日活跃计数只认它**）
// 本自测不起真实上游：用本地 http 服务逐个断言「打到哪个路径、带了什么头、体是什么形状」，
// 并覆盖三条都失败时 dailyActivity 仍返回结构化结果（不让签到因此翻成失败）。
//
// 用法：node tools/proxy-workbuddy-activity-selftest.cjs
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let failures = 0;
function assert(cond, label, extra) {
  if (cond) console.log("  ok   " + label);
  else { failures++; console.error("  FAIL " + label + (extra ? " —— " + extra : "")); }
}

async function main() {
  const seen = [];
  let failMode = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, headers: { ...req.headers }, body });
      if (failMode === "all") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"code":500,"message":"boom"}');
        return;
      }
      if (req.url.includes("/console/as/conversations")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"code":0,"data":{"conversationId":"c1"}}');
        return;
      }
      if (req.url.includes("/activity/growth/streak")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"code":0,"data":{"streak":{"days":3}}}');
        return;
      }
      if (req.url.endsWith("/report") || req.url.includes("/v2/report")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"code":0}');
        return;
      }
      // chat/completions：最小 SSE
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"h"}}]}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-activity-"));
  const locFile = path.join(os.homedir(), ".Dosage_sync.location");
  const prevLoc = fs.existsSync(locFile) ? fs.readFileSync(locFile, "utf8") : null;
  fs.writeFileSync(locFile, JSON.stringify({ path: dir }));
  try {
    const rules = require("../electron/backend/proxy/rules.cjs");
    const cfgPath = path.join(rules.rulesDir(), "headers.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    // 三个域都指到本地假上游：billingBase（report/streak）、chatUrl（免费模型）、pluginBase
    cfg.workbuddy_ai.chatUrl = `${base}/v2/chat/completions`;
    cfg.workbuddy_ai.billingBase = base;
    cfg.workbuddy_ai.pluginBase = base;
    cfg.workbuddy_ai.webBase = base;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    rules.reload("headers.json");

    const adapters = require("../electron/backend/proxy/adapters.cjs");
    const ad = adapters.get("workbuddy_ai");
    const account = { id: "a1", uid: "u-123", channel: "workbuddy_ai" };
    const secrets = { token: "tk", refreshToken: "rt" };

    // ---- ① 活跃上报 ----
    seen.length = 0;
    const rep = await ad.reportActivity(account, secrets);
    assert(rep.succeeded === true, "活跃上报成功", rep.message);
    assert(rep.streakDays === 3, "回读连登天数", String(rep.streakDays));
    const reportReq = seen.find((s) => /\/report$|\/v2\/report/.test(s.url));
    assert(!!reportReq, "打到 /report");
    const reportBody = JSON.parse(reportReq.body);
    assert(Array.isArray(reportBody) && reportBody.length === 1, "体是「一个事件的数组」");
    const ev = reportBody[0];
    assert(ev.eventCode === "chat_request_send", "eventCode=chat_request_send");
    assert(ev.mode === "craft" && ev.agentType === "conversation", "mode/agentType 形状对齐");
    assert(ev.userId === "u-123", "事件带 userId");
    assert(typeof ev.presentAt === "number" && typeof ev.timestamp === "number", "时间戳为数字");

    // ---- ② 免费模型保活 ----
    seen.length = 0;
    const poke = await ad.pokeActivity(account, secrets);
    assert(poke.succeeded === true, "免费模型保活成功", poke.message);
    const chatReq = seen.find((s) => s.url.includes("/chat/completions"));
    assert(!!chatReq, "打到 chat/completions");
    const chatBody = JSON.parse(chatReq.body);
    assert(chatBody.stream === true && chatBody.max_tokens === 16, "最小流式体（stream + max_tokens=16）");
    assert(Array.isArray(chatBody.messages) && chatBody.messages.length === 2, "system+user 两条消息");
    // 必须与真对话同头族（缺 X-CodeBuddy-Request 就会被 11128 渠道校验拒）
    assert(chatReq.headers["x-codebuddy-request"] === "1", "保活沿用真对话的风控闸门头");
    assert(String(chatReq.headers.authorization || "").startsWith("Bearer "), "保活沿用 Bearer 鉴权");

    // ---- ③ 网页会话 ----
    seen.length = 0;
    const web = await ad.webConversation(account, secrets);
    assert(web.succeeded === true, "网页会话建立成功", web.message);
    const webReq = seen.find((s) => s.url.includes("/console/as/conversations"));
    assert(!!webReq, "打到 /console/as/conversations/");
    assert(!webReq.headers["x-ide-name"] && !webReq.headers["x-machine-id"], "网页链路剥掉桌面端指纹头");
    assert(webReq.headers["x-user-id"] === "u-123", "带 X-User-Id");
    const webBody = JSON.parse(webReq.body);
    assert(webBody.conversationOrigin === "workbuddy-app", "体带 conversationOrigin");
    assert(Array.isArray(webBody.plugins) && webBody.plugins.length === 1, "体带 plugins");

    // ---- 汇总：三步互补，任一成功即 ok ----
    seen.length = 0;
    const da = await ad.dailyActivity(account, secrets);
    assert(da.ok === true && da.report.succeeded && da.poke.succeeded && da.web.succeeded, "组合动作三步都成功");
    assert(/活跃上报|网页会话/.test(da.message), "汇总文案包含各步结论", da.message);

    // ---- 全失败：仍返回结构化结果，不抛 ----
    failMode = "all";
    const bad = await ad.dailyActivity(account, secrets);
    assert(bad && bad.ok === false && bad.report && bad.poke && bad.web, "全失败时返回结构化结果（不抛）");
    assert(typeof bad.message === "string" && bad.message.includes("失败"), "全失败文案如实报错");
  } finally {
    server.close();
    if (prevLoc === null) fs.rmSync(locFile, { force: true });
    else fs.writeFileSync(locFile, prevLoc);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures ? `\nRESULT: ${failures} failed` : "\nWorkBuddy 每日活跃自测全过");
  // Windows 上 fetch（undici）的连接池会在 process.exit 与 libuv 关闭句柄之间抢跑，
  // 触发 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" 并把退出码变成 127。
  // 让事件循环自然收尾（undici 的连接在 keep-alive 超时后释放）比强退更可靠；
  // 5 秒兜底仍不退就说明真有挂起句柄，此时 exitCode 已设置，断言结果仍可被 CI 读到。
  process.exitCode = failures ? 1 : 0;
  const t = setTimeout(() => process.exit(failures ? 1 : 0), 5000);
  t.unref();
}

main().catch((e) => {
  console.error("自测异常：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
