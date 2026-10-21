// Cline 双池专项自测：离线协议断言 + 本地假上游端到端链路。
// 运行：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-cline-selftest.cjs
// 离线：workos: 前缀幂等 / JWT 解析（exp/external_id/identity）/ expiresAt 双形态 /
//       设备授权轮询四态 / 归池按分组（free 组裸 id 不误判）/ clineCloud 过滤 /
//       短名补池前缀 / 出站 body 改写 / 错误分类（403·404 不重试、429 人话时长）/
//       双池注册与配置隔离。
// e2e：真适配器 + 假上游（随机端口）——对话 SSE 全链（头/路径/body 断言、model 回写、
//       reasoning 帧透传）、目录拉取按池过滤、余额 ÷1e6 + plan 404、续期裸 JWT 补前缀、
//       设备授权三函数、桌面 providers.json 扫描导入。
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

// 独立数据目录：rules/config 落临时目录，绝不触碰真实 %APPDATA%（须在 require store/rules 之前设）；
// USERPROFILE 一并沙箱（桌面扫描读 ~/.cline/data/settings/providers.json）
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cline-test-"));
process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cline-home-"));

const assert = (cond, msg) => {
  if (!cond) throw new Error("断言失败: " + msg);
};

const clineCredentials = require("../electron/backend/proxy/cline/credentials.cjs");
const clineLogin = require("../electron/backend/proxy/cline/login.cjs");
const clineModels = require("../electron/backend/proxy/cline/models.cjs");
const clineHeaders = require("../electron/backend/proxy/cline/headers.cjs");
const clineBalance = require("../electron/backend/proxy/cline/balance.cjs");
const { makeCline, parseTryAgainMs } = require("../electron/backend/proxy/cline/adapter.cjs");
const rulesMod = require("../electron/backend/proxy/rules.cjs");
const storeMod = require("../electron/backend/proxy/store.cjs");
const utilMod = require("../electron/backend/proxy/util.cjs");

/** 造一个 workos: JWT（payload 自定义） */
function makeJwt(claims) {
  const head = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `workos:${head}.${body}.sig`;
}

// ===== 离线协议断言 =====
function offline() {
  // ① workos: 前缀幂等 + JWT 解析
  {
    assert(clineCredentials.ensureTokenPrefix("eyJx") === "workos:eyJx", "裸 JWT 补 workos: 前缀");
    assert(clineCredentials.ensureTokenPrefix("workos:eyJx") === "workos:eyJx", "已带前缀不重复补（幂等）");
    assert(clineCredentials.ensureTokenPrefix("  ") === "", "空白凭据归一为空串");
    const jwt = makeJwt({ exp: 1789842888, external_id: "usr-01M2VW", email: "a@b.c", firstName: "亮", lastName: "欧阳" });
    assert(clineCredentials.expiresAtFromJwt(jwt) === 1789842888000, "JWT exp 秒 → 毫秒");
    assert(clineCredentials.accountIdFromJwt(jwt) === "usr-01M2VW", "账号 id 取 external_id（不是 sub）");
    assert(clineCredentials.identityFromJwt(jwt) === "a@b.c", "展示名 email 优先");
    const cn = makeJwt({ firstName: "亮", lastName: "欧阳" });
    assert(clineCredentials.identityFromJwt(cn) === "欧阳亮", "无 email 时中文姓名按姓+名拼");
    assert(clineCredentials.accountIdFromJwt("not-a-jwt") === "", "非 JWT 不抛错返回空");
  }

  // ② expiresAt 双形态（providers.json 毫秒 / refresh 响应 ISO）
  {
    assert(clineCredentials.parseExpiresAt(1789842888000) === 1789842888000, "毫秒数字原样");
    assert(clineCredentials.parseExpiresAt("1789842888000") === 1789842888000, "数字字符串按毫秒");
    assert(clineCredentials.parseExpiresAt("2026-09-19T19:30:04Z") > 0, "ISO 8601 可解析");
    assert(clineCredentials.parseExpiresAt("garbage") === 0 && clineCredentials.parseExpiresAt(null) === 0, "非法值归 0 不抛错");
  }

  // ③ 设备授权轮询四态（RFC 8628）
  {
    const ok = clineLogin.classifyPollResult(200, { access_token: "a", refresh_token: "r" });
    assert(ok.kind === "confirmed" && ok.accessToken === "a", "200 且双令牌齐备 → confirmed");
    assert(clineLogin.classifyPollResult(400, { error: "authorization_pending" }).kind === "pending", "authorization_pending → 继续轮询");
    assert(clineLogin.classifyPollResult(400, { error: "slow_down" }).kind === "slowDown", "slow_down → 拉长间隔");
    assert(clineLogin.classifyPollResult(400, { error: "expired_token" }).kind === "failed", "expired_token → 终止");
    assert(clineLogin.classifyPollResult(400, { error: "access_denied" }).kind === "failed", "access_denied → 终止");
    assert(clineLogin.classifyPollResult(200, {}).kind === "failed", "200 缺令牌按失败（不落半截凭证）");
  }

  // ④ 归池按响应分组（**不按前缀猜**——free 组里混着别家裸 id）
  {
    const payload = {
      recommended: [{ id: "openai/gpt-6-astra", name: "gpt-6-astra" }, { id: "cline-pass/glm-5.3", name: "x" }],
      free: [
        { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek" },
        { id: "z-ai/glm-5.3-flash", name: "glm-flash" },
        { id: "poolside/laguna-s-2.1:free", name: "laguna" },
      ],
      clinePass: [{ id: "cline-pass/kimi-k3", name: "k3" }],
      clineCloud: [{ id: "cline-cloud/glm-5.3", name: "cloud" }],
    };
    const all = clineModels.parseRecommended(payload);
    assert(!all.some((e) => e.id.startsWith("cline-cloud/")), "clineCloud 不收录（实测 403）");
    const free = clineModels.filterByPool(all, "free");
    assert(free.some((e) => e.id === "z-ai/glm-5.3-flash") && free.some((e) => e.id === "poolside/laguna-s-2.1:free"), "free 组裸 id 归免费池（前缀猜会错判进订阅池）");
    const pass = clineModels.filterByPool(all, "pass");
    assert(!pass.some((e) => e.id === "z-ai/glm-5.3-flash"), "裸 id 不出现在订阅池");
    assert(pass.some((e) => e.id === "openai/gpt-6-astra"), "recommended 组无池信息按前缀兜底（保守归 pass）");
    assert(all.length === new Set(all.map((e) => e.id)).size, "同 id 去重");
  }

  // ⑤ 短名归一（resolveBodyModel）：本池补前缀、跨池/未知/身份前缀不动
  {
    const entries = [
      { id: "cline-free/deepseek-v4.1-flash" },
      { id: "cline-pass/deepseek-v4.1-flash" },
      { id: "z-ai/glm-5.3-flash" },
    ];
    assert(clineModels.resolveBodyModel("cline-free/deepseek-v4.1-flash", entries, "free") === "cline-free/deepseek-v4.1-flash", "完整 id 原样");
    assert(clineModels.resolveBodyModel("deepseek-v4.1-flash", entries, "free") === "cline-free/deepseek-v4.1-flash", "短名补本池前缀（free）");
    assert(clineModels.resolveBodyModel("deepseek-v4.1-flash", entries, "pass") === "cline-pass/deepseek-v4.1-flash", "短名补本池前缀（pass）——同名两池各归各的");
    assert(clineModels.resolveBodyModel("DEEPSEEK-V4.1-FLASH", entries, "free") === "cline-free/deepseek-v4.1-flash", "大小写不敏感");
    assert(clineModels.resolveBodyModel("cline-pass/glm-5.3", entries, "free") === "cline-pass/glm-5.3", "跨池前缀 id 不改写（改写会换计费通道）");
    assert(clineModels.resolveBodyModel("z-ai/glm-5.3-flash", entries, "free") === "z-ai/glm-5.3-flash", "免费池裸厂商 id 原样");
    assert(clineModels.resolveBodyModel("unknown-model", entries, "free") === "unknown-model", "未知模型原样（转发试错，上游 404 如实报错）");
    assert(clineModels.friendlyAlias("poolside/laguna-s-2.1:free") === null, "无池前缀的裸 id 不剥厂商前缀（会造出上游不存在的名字）");
  }

  // ⑥ 429 人话时长解析（单位组合）
  {
    assert(parseTryAgainMs('Try again in 17h 59m.') === 17 * 3600000 + 59 * 60000, "17h 59m");
    assert(parseTryAgainMs("Try again in 1d 2h 30m") === 86400000 + 2 * 3600000 + 30 * 60000, "1d 2h 30m");
    assert(parseTryAgainMs("Try again in 500ms") === 500, "ms 在裸 m 之前判");
    assert(parseTryAgainMs("Try again in 30s") === 30000, "30s");
    assert(parseTryAgainMs("no wait text") === 0, "无文案归 0");
  }

  // ⑦ 上游请求头唯一实现（对话/登录/续期三处共用，契约）
  {
    const h = clineHeaders.buildUpstreamHeaders(
      { upstreamHeaders: { "User-Agent": "Cline/9.9", "X-Custom": "", "Content-Type": "text/plain", Authorization: "Bearer hack", "X-Task-ID": "hack" } },
      { "content-type": "application/json", accept: "text/event-stream", authorization: "Bearer real", "x-task-id": "sess_1" }
    );
    assert(h["user-agent"] === "Cline/9.9", "伪装头按小写键覆盖默认值");
    assert(!("x-custom" in h), "覆盖值空串 = 该头不发（显式删除）");
    assert(h["content-type"] === "application/json", "Content-Type 拒绝覆盖（协议必需）");
    assert(h.accept === "text/event-stream", "Accept 拒绝覆盖（协议必需）");
    assert(h.authorization === "Bearer real", "Authorization 拒绝覆盖（协议必需）");
    assert(h["x-task-id"] === "sess_1", "X-Task-ID 拒绝覆盖（每请求动态生成）");
  }

  // ⑧ 双池注册与配置（双表一致性由 consistencyReport 兜底）
  {
    const rules = rulesMod.DEFAULTS;
    const chIds = storeMod.CHANNELS.map((c) => c.id);
    assert(chIds.includes("cline_free") && chIds.includes("cline_pass"), "CHANNELS 含 cline_free / cline_pass");
    assert(storeMod.CHANNELS.find((c) => c.id === "cline_free").costTier === "free", "免费池标 costTier free（cost-first 正确优先）");
    assert(!storeMod.CHANNELS.find((c) => c.id === "cline_pass").costTier, "订阅池不标成本档（错标 free 会让 cost-first 烧钱）");
    const hdr = rules["headers.json"].cline;
    assert(hdr && hdr.upstreamHeaders["X-CLIENT-TYPE"] === "cline-sdk", "伪装头含 X-CLIENT-TYPE: cline-sdk（免费池硬门槛）");
    assert(hdr.apiBase === "https://api.cline.bot/api/v1" && !/\/v1\/v1/.test(hdr.apiBase + hdr.modelsPath), "apiBase 只有一个 v1");
    const cat = rules["catalog.json"];
    assert(cat.cline_free && cat.cline_free.models.length && cat.cline_pass && cat.cline_pass.models.length, "catalog 双段静态兜底齐备");
    assert(cat.cline_free.models.every((m) => /^(cline-free\/|z-ai\/|poolside\/)/.test(m.id)), "免费池兜底 id 形态（带前缀或裸厂商 id）");
  }
}

// ===== 假上游：按 pathname 分发（验证「路径只有一个 v1」）=====
function fakeUpstream() {
  const seen = { chat: [], other: [] };
  const jwtNew = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, external_id: "usr-01M2VW", email: "u@c.test" });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://127.0.0.1");
      // 对话（完整路径 /api/v1/chat/completions——发成 /api/v1/v1/... 这里就 404）
      if (req.method === "POST" && u.pathname === "/api/v1/chat/completions") {
        const parsed = JSON.parse(body || "{}");
        seen.chat.push({ path: u.pathname, headers: req.headers, body: parsed });
        // 特权模型名模拟 403（ENTITLEMENT_ERROR：该账号对该模型无权限）
        if (String(parsed.model || "").includes("forbidden")) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "ENTITLEMENT_ERROR", message: "You are not subscribed to required model plan" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        // 裸 chat.completion.chunk 帧：model 是上游内部名（必须被适配器回写成请求名）
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", model: "deepseek/deepseek-v4.1-flash", choices: [{ index: 0, delta: { reasoning: "想想" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", model: "deepseek/deepseek-v4.1-flash", choices: [{ index: 0, delta: { content: "你好" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", model: "deepseek/deepseek-v4.1-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      // 模型目录（无需鉴权）
      if (req.method === "GET" && u.pathname === "/api/v1/ai/cline/recommended-models") {
        seen.other.push({ path: u.pathname, headers: req.headers });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          recommended: [{ id: "openai/gpt-6-astra", name: "gpt-6-astra" }],
          free: [{ id: "cline-free/deepseek-v4.1-flash", name: "Deepseek" }, { id: "z-ai/glm-5.3-flash", name: "glm-flash" }],
          clinePass: [{ id: "cline-pass/kimi-k3", name: "k3" }],
          clineCloud: [{ id: "cline-cloud/glm-5.3", name: "cloud" }],
        }));
        return;
      }
      // 余额：-17704 微 credit（官方界面显示 -0.0177）
      if (req.method === "GET" && /^\/api\/v1\/users\/usr-[^/]+\/balance$/.test(u.pathname)) {
        seen.other.push({ path: u.pathname, headers: req.headers });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { userId: "usr-01M2VW", balance: -17704 }, success: true }));
        return;
      }
      // 套餐：没订阅是 404（正常状态）
      if (req.method === "GET" && u.pathname === "/api/v1/users/me/plan") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: null, error: "no plan history found for user", success: false }));
        return;
      }
      // 续期：返回**裸 JWT**（不带 workos: 前缀）+ ISO expiresAt + 轮换后的 refreshToken
      if (req.method === "POST" && u.pathname === "/api/v1/auth/refresh") {
        seen.other.push({ path: u.pathname, headers: req.headers, body: JSON.parse(body || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { accessToken: jwtNew.replace(/^workos:/, ""), refreshToken: "rv-new", expiresAt: "2026-12-19T19:30:04Z", tokenType: "Bearer" }, success: true }));
        return;
      }
      // 令牌登记（第四步）
      if (req.method === "POST" && u.pathname === "/api/v1/auth/register") {
        seen.other.push({ path: u.pathname, headers: req.headers, body: JSON.parse(body || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { accessToken: jwtNew, refreshToken: "rv-session", expiresAt: "2026-12-19T19:30:04Z" }, success: true }));
        return;
      }
      // WorkOS 设备授权
      if (req.method === "POST" && u.pathname === "/user_management/authorize/device") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ device_code: "dc-1", user_code: "PXQF-MWRC", verification_uri: "https://authkit.cline.bot/device", verification_uri_complete: "https://authkit.cline.bot/device?user_code=PXQF-MWRC", expires_in: 300, interval: 5 }));
        return;
      }
      if (req.method === "POST" && u.pathname === "/user_management/authenticate") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: jwtNew, refresh_token: "rv-session" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    });
  });
  return { server, seen, jwtNew };
}

// ===== 端到端链路 =====
async function e2e() {
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  rules.init(); // 首次跑：把内置默认拷到沙箱 rules/ 并加载（app 运行时由 main.cjs 调）

  const fu = fakeUpstream();
  await new Promise((resolve) => fu.server.listen(0, "127.0.0.1", resolve));
  const port = fu.server.address().port;
  try {
    // 把 apiBase / workosBase 指到假上游（headers.json 热改 + reload）
    const hf = path.join(rules.rulesDir(), "headers.json");
    const cfgAll = JSON.parse(JSON.stringify(rules.DEFAULTS["headers.json"]));
    cfgAll.cline.apiBase = `http://127.0.0.1:${port}/api/v1`;
    cfgAll.cline.workosBase = `http://127.0.0.1:${port}`;
    cfgAll.cline.modelsPath = "/ai/cline/recommended-models";
    fs.writeFileSync(hf, JSON.stringify(cfgAll, null, 2), "utf8");
    rules.reload("headers.json");

    const free = adapters.get("cline_free");
    const pass = adapters.get("cline_pass");
    assert(free && pass, "双池适配器已注册");
    assert(free.refreshWindowSec === 600, "临期窗口 600s（access 1 小时的 1/6）");
    assert(free.zeroBalanceUsable === true && pass.zeroBalanceUsable === true, "余额 0 非硬门禁旗标（免费池余额恒 0 时仍可被调度，不误标 exhausted）");

    // —— 1. 对话：头/路径/body 断言 + model 回写 + reasoning 帧透传
    const accId = storeMod.addAccount({ channel: "cline_free", uid: "usr-01M2VW", name: "自测号", token: "eyJx", refreshToken: "rv-old", source: "paste" });
    const acc = storeMod.getAccount(accId);
    const secrets = storeMod.accountSecrets(acc);
    const events = [];
    const r = await free.chat({
      account: acc,
      secrets,
      // 客户端用短名请求（server 层 targetModel 原样透传进来，适配器补前缀）
      model: "deepseek-v4.1-flash",
      body: { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], reasoningEffort: "low" },
      emit: (e) => events.push(e),
      meta: {},
    });
    assert(r.status === 200, "chat 返回 200");
    assert(r.model === "cline-free/deepseek-v4.1-flash", "chat 回传实际转发模型名（短名补前缀对记账可见，不静默）");
    const sent = fu.seen.chat[0];
    assert(sent.path === "/api/v1/chat/completions", "路径只有一个 v1（/api/v1/v1 会 404）");
    assert(sent.headers.authorization === "Bearer workos:eyJx", "Authorization 带 workos: 前缀（去掉会 401）");
    assert(sent.headers["x-client-type"] === "cline-sdk", "X-CLIENT-TYPE: cline-sdk（免费池硬门槛）");
    assert(sent.headers["x-task-id"] === sent.body.session_id, "X-Task-ID 与 body.session_id 同值");
    assert(/^sess_\d+$/.test(sent.body.session_id), "session_id 是 sess_<毫秒> 形态（官方 CLI 同形）");
    assert(sent.body.model === "cline-free/deepseek-v4.1-flash", "短名补本池前缀后转发");
    assert(sent.body.stream === true, "恒以 stream:true 请求上游");
    assert(sent.body.reasoning_effort === "low" && sent.body.reasoningEffort === undefined, "驼峰 effort 归一为 snake 上行");
    const frames = events.filter((e) => e.type === "delta").map((e) => e.delta);
    assert(frames.some((d) => d.reasoning === "想想"), "reasoning 帧原样透传（不替客户端翻译字段名）");
    assert(frames.some((d) => d.content === "你好"), "正文 delta 透传");
    assert(events.find((e) => e.type === "usage").usage.total_tokens === 10, "usage 透传");
    assert(events.find((e) => e.type === "finish").reason === "stop", "finish_reason 透传");
    // model 回写：所有事件的 chunk model 必须是客户端请求名（上游给的是 deepseek/deepseek-v4.1-flash）
    assert(!JSON.stringify(events.map((e) => e.delta)).includes("deepseek/deepseek-v4.1-flash"), "帧内无上游内部模型名泄漏");

    // —— 2. 403 分类（假上游对 forbidden 模型名回 403 → 走真 chat 抛错路径）
    {
      let err403 = null;
      try {
        await free.chat({ account: acc, secrets, model: "forbidden-model", body: { model: "forbidden-model", messages: [] }, emit: () => {}, meta: {} });
      } catch (e) {
        err403 = e;
      }
      assert(err403 && err403.status === 403, "chat 对上游 403 如实抛错（带 status/body）");
      const cls = free.classifyError(err403);
      assert(cls && cls.kind === "model_denied" && cls.switchable === false, "403 → model_denied（不重试不罚号，确定性拒绝）");
      assert(/not subscribed/.test(cls.message), "403 上游文案带给客户端（用户据此知道该换模型或订阅）");
      assert(!cls.channelLevel, "账号级 403 不带渠道级标记（不污染账号卡片）");
      const clsCh = free.classifyError({ status: 403, body: JSON.stringify({ error: { message: "This model is only available via Cline product surfaces" } }) });
      assert(clsCh.kind === "model_denied" && clsCh.channelLevel === true && /伪装头/.test(clsCh.message), "渠道级 403 带 channelLevel 标记与可操作提示（server 侧据此记入账号错误，整池失效不再静默）");
      const cls404 = free.classifyError({ status: 404, body: JSON.stringify({ error: "model not found" }) });
      assert(cls404.kind === "model_denied" && cls404.switchable === false, "404 → model_denied（模型名不对，换号无用）");
      const cls429 = free.classifyError({ status: 429, body: JSON.stringify({ error: { code: "INFERENCE_CAP_ERROR", message: "Rate limited. Try again in 17h 59m." } }) });
      assert(cls429.kind === "rate" && cls429.switchable === true && Math.abs(cls429.resetMs - Date.now() - (17 * 3600000 + 59 * 60000)) < 5000, "429 → rate + 人话时长对齐墙钟");
      assert(free.classifyError({ status: 401 }) === null, "401 不拦截（走通用层刷新重试）");
    }

    // —— 3. 目录拉取：按池过滤（一次拉回四组，各取本池）
    {
      const fm = await free.fetchModels(acc, secrets);
      assert(fm.ok && fm.models.some((m) => m.id === "cline-free/deepseek-v4.1-flash") && fm.models.some((m) => m.id === "z-ai/glm-5.3-flash"), "免费池目录含带前缀与裸 id 两类");
      assert(!fm.models.some((m) => m.id.startsWith("cline-pass/") || m.id.startsWith("cline-cloud/")), "免费池不含订阅池/云池模型");
      const pm = await pass.fetchModels(null, null);
      assert(pm.ok && pm.models.some((m) => m.id === "cline-pass/kimi-k3"), "订阅池目录含 clinePass 组");
      // 写回 catalog 后 models() 只认目录
      const catFile = path.join(rules.rulesDir(), "catalog.json");
      const cat = JSON.parse(JSON.stringify(rules.DEFAULTS["catalog.json"]));
      cat.cline_free = { syncedAt: Date.now(), models: fm.models };
      cat.cline_pass = { syncedAt: Date.now(), models: pm.models };
      fs.writeFileSync(catFile, JSON.stringify(cat, null, 2), "utf8");
      rules.reload("catalog.json");
      assert(JSON.stringify(free.models()) === JSON.stringify(fm.models.map((m) => m.id)), "拉取后免费池只认目录");
      assert(JSON.stringify(pass.models()) === JSON.stringify(pm.models.map((m) => m.id)), "拉取后订阅池只认目录（双池隔离）");
    }

    // —— 3b. 目录缓存：空目录段也不得每次重读（判据与 entries.length 解耦）
    {
      const cat2 = JSON.parse(JSON.stringify(rules.DEFAULTS["catalog.json"]));
      cat2.cline_free = { syncedAt: Date.now(), models: [] };
      fs.writeFileSync(path.join(rules.rulesDir(), "catalog.json"), JSON.stringify(cat2, null, 2), "utf8");
      rules.reload("catalog.json");
      assert(Array.isArray(free.models()) && free.models().length === 0, "空目录段返回空数组（不抛错）");
      // 缓存命中只省「读文件 + 解析」（statSync 在判据之前必执行），故统计 readFileSync 增量
      const origRead = fs.readFileSync;
      let n = 0;
      fs.readFileSync = (p, ...rest) => { n++; return origRead(p, ...rest); };
      free.models();
      const before = n;
      free.models();
      const after = n;
      fs.readFileSync = origRead;
      assert(after === before, `空目录段二次 models() 命中缓存（不再读文件，增量 ${after - before}）`);
    }

    // —— 4. 余额：÷1e6 + 负值保留 + plan 404 正常态
    {
      const q = await free.queryCredits(acc, secrets);
      assert(q.credits === -0.02, `-17704 微 credit ÷1e6 → -0.02（实际 ${q.credits}）`);
      assert(q.unit === "credit", "单位是 credit（不是积分）");
      assert(q.detail.balanceMicrocredits === -17704, "原始微 credit 留存排障");
      assert(q.subscription === null && !q.detail.subscriptionError, "plan 404 是正常态（没订阅），不算失败");
      assert(fu.seen.other.some((s) => /\/users\/usr-01M2VW\/balance$/.test(s.path)), "余额路径用账号 uid（usr-...）");
      // 上游 200 但缺 balance 字段：必须如实报错，不能返回 0——
      // 0 会落库后被 routeUsable 判成「余额已耗尽」，把可用渠道静默踢出
      let balErr = null;
      try {
        await clineBalance.queryBalance({
          cfg: rules.get("headers.json").cline,
          token: "workos:x",
          httpJson: async () => ({ status: 200, ok: true, data: { data: { userId: "usr-x" }, success: true } }),
          userId: "usr-x",
          parseExpiresAt: clineCredentials.parseExpiresAt,
        });
      } catch (e) { balErr = e; }
      assert(balErr && /balance/.test(balErr.message), "上游 200 但缺 balance 字段 → 如实报错（不返回 0）");
    }

    // —— 5. 续期：裸 JWT 补前缀 + 轮换 + ISO expiresAt + camelCase grantType
    {
      const rt = await free.refreshToken(acc, secrets);
      assert(rt.ok && rt.token.startsWith("workos:"), "续期返回裸 JWT 已补 workos: 前缀");
      assert(rt.refreshToken === "rv-new", "refreshToken 轮换取新值");
      assert(rt.expiresAt > 0, "ISO expiresAt 已转毫秒");
      const sent = fu.seen.other.find((s) => s.path === "/api/v1/auth/refresh");
      assert(sent.body.grantType === "refresh_token" && sent.body.grant_type === undefined, "grantType 是 camelCase（不是 OAuth 标准的 grant_type）");
    }

    // —— 6. 设备授权三函数（真 httpJson 打假上游）
    {
      const cfg = rules.get("headers.json").cline;
      const start = await clineLogin.startDeviceAuth(cfg, adapters.httpJson);
      assert(start.ok && start.userCode === "PXQF-MWRC" && start.intervalMs === 5000 && start.expiresIn === 300, "设备授权起会话（user_code + interval + expires_in，会话超时跟随有效期）");
      const poll = await clineLogin.pollDeviceToken(cfg, start.deviceCode, adapters.httpJson);
      assert(poll.kind === "confirmed" && poll.accessToken, "轮询直达 confirmed");
      const reg = await clineLogin.registerSession(cfg, poll.accessToken, poll.refreshToken, adapters.httpJson);
      assert(reg.ok && reg.accessToken.startsWith("workos:"), "令牌登记换回会话令牌（带 workos: 前缀）");
    }

    // —— 7. 桌面 providers.json 扫描导入（两池各一条候选）
    {
      const discovery = require("../electron/backend/proxy/discovery.cjs");
      const dir = path.join(process.env.USERPROFILE, ".cline", "data", "settings");
      fs.mkdirSync(dir, { recursive: true });
      const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, external_id: "usr-DESK01", email: "d@c.test" });
      fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify({
        version: "1.0.0",
        providers: { cline: { settings: { auth: { accessToken: jwt, refreshToken: "rv-desk", expiresAt: Date.now() + 3600000, accountId: "usr-DESK01", metadata: { userInfo: { email: "d@c.test" } } } } } },
      }));
      const cands = discovery.scanAll().filter((c) => String(c.channel).startsWith("cline"));
      assert(cands.length === 2 && cands.every((c) => c.uid === "usr-DESK01" && c.token.startsWith("workos:")), "桌面登录态两池各产出候选（不猜池）");
      const imported = discovery.importCandidate(cands[1], "cline_pass");
      assert(!!imported.id, "桌面候选可导入指定池");
      fs.rmSync(path.join(process.env.USERPROFILE, ".cline"), { recursive: true, force: true });
    }

    console.log("Cline e2e 全绿（对话/错误分类/目录归池/余额/续期/设备授权/桌面导入）");
  } finally {
    fu.server.close();
  }
}

(async () => {
  offline();
  await e2e();
  console.log("Cline 自测全部通过");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
