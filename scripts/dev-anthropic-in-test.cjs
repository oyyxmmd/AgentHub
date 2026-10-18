// 反代网关 · /v1/messages（Anthropic Messages 入站）自测
//
// 跑法：node scripts/dev-anthropic-in-test.cjs
// 隔离：APPDATA 指到 mkdtemp 出来的临时目录，不碰真实 %APPDATA%；端口用 19571，
//       与用户自己的 9527 和 dev-sink-golden 的 19551 都错开，可以并发跑。
//
// 判据分两类，缺一不可：
//  · 纯函数（归一 / 预算换算 / 读 Key）——把 Messages 请求体翻成内部规范形的每个字段
//  · 端到端（真 HTTP 打进真调度核心，只把「上游」与「号池」打桩）——事件顺序、块边界、
//    错误形状、换号时首帧不重发。sink 的字节只有放在真实流里才看得出对不对。
//
// 打桩清单照 dev-sink-golden.cjs 抄（那份逐字节守着 OpenAI 通路，这一份守着 Messages 通路）：
// 接缝接管不完整的话，用例会打到真实渠道上，测试就成了出网请求。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-anthropic-"));

const PORT = 19571;
const MODEL = "glm-4.6";

let pass = 0, failed = 0;
function ok(cond, msg, got) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { failed++; console.log("  ✗", msg, got !== undefined ? `→ got ${JSON.stringify(got).slice(0, 300)}` : ""); }
}

const ain = require("../electron/backend/proxy/protocols/anthropic-in.cjs");
const util = require("../electron/backend/proxy/util.cjs");

// ===== ① 入站归一：Messages 请求体 → 内部规范形 =====
console.log("① 入站归一（纯函数）:");
{
  ok(ain.toInternal({ max_tokens: 1, messages: [{ role: "user", content: "x" }] }).ok === false, "① 缺 model 被拒");
  ok(ain.toInternal({ model: "m", messages: [{ role: "user", content: "x" }] }).ok === false, "① 缺 max_tokens 被拒（Anthropic 唯一必填的采样参数）");
  ok(ain.toInternal({ model: "m", max_tokens: 1, messages: [] }).ok === false, "① 空 messages 被拒");
  ok(ain.toInternal({ model: "m", max_tokens: 0, messages: [{ role: "user", content: "x" }] }).ok === false, "① max_tokens=0 被拒（不接受「0 = 不限」这种读法）");
  ok(ain.toInternal(null).ok === false, "① 请求体不是对象时明确拒绝，不抛异常");

  let r = ain.toInternal({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [{ role: "user", content: "你好" }] });
  ok(r.ok && r.body.messages[0].content === "你好" && r.body.max_tokens === 1024, "① 最小合法请求：正文与 max_tokens 原样落进规范形", r);
  ok(r.body.stream === false, "① stream 缺省为 false（缺字段不能当 true，否则非流式客户端收到 SSE）", r.body.stream);

  r = ain.toInternal({
    model: "m", max_tokens: 100,
    system: [{ type: "text", text: "你是 A" }, { type: "text", text: "遵守 B", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }], stop_sequences: ["END"], top_p: 0.9, temperature: 0.2,
  });
  ok(r.body.messages[0].role === "system" && r.body.messages[0].content === "你是 A\n遵守 B", "① 多段 system 按序拼成一条（cache_control 忽略但文本不丢）", r.body.messages);
  ok(JSON.stringify(r.body.stop) === '["END"]', "① stop_sequences → stop", r.body.stop);
  ok(r.body.top_p === 0.9 && r.body.temperature === 0.2, "① top_p / temperature 透传", [r.body.top_p, r.body.temperature]);
  ok(r.notes.length === 0, "① 干净请求不该产出任何损失记录（否则日志里的「转换损失」没有信号量）", r.notes);

  r = ain.toInternal({
    model: "m", max_tokens: 100,
    messages: [
      { role: "user", content: "读文件" },
      { role: "assistant", content: [{ type: "text", text: "我读一下" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "文件内容" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "出错" }], is_error: true }] },
    ],
  });
  const m = r.body.messages;
  ok(m[1].tool_calls[0].id === "toolu_1" && m[1].tool_calls[0].function.arguments === '{"path":"/a"}', "① tool_use → tool_calls（call id 保真 + input 序列化成字符串）", m[1]);
  ok(m[1].content === "我读一下", "① assistant 的 text 与 tool_use 共存时文本不丢", m[1]);
  ok(m[2].role === "tool" && m[2].tool_call_id === "toolu_1" && m[2].content === "文件内容", "① tool_result → role:tool + tool_call_id", m[2]);
  ok(m[3].content === "[error] 出错", "① is_error 加前缀标记（上游靠它判断这一跳失败）", m[3].content);

  // 单条 user 消息带两个 tool_result（并行工具调用的标准形态）：必须都进去，不能被覆盖成只剩最后一个
  r = ain.toInternal({
    model: "m", max_tokens: 100,
    messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "a1", content: "一" },
      { type: "tool_result", tool_use_id: "a2", content: "二" },
      { type: "text", text: "顺带一句" },
    ] }],
  });
  ok(r.body.messages.length === 3 && r.body.messages[0].tool_call_id === "a1" && r.body.messages[1].tool_call_id === "a2",
    "① 一条消息里的多个 tool_result 全部展开（单变量覆盖会让上游收到缺 response 的 tool_call）", r.body.messages);
  ok(r.body.messages[2].role === "user" && r.body.messages[2].content === "顺带一句",
    "① tool_result 与 text 混排时文本另起一条 user 消息，不丢", r.body.messages[2]);

  // 同一条消息里 tool_result 与图片并存：图片既不在任何 tool_result 的 content 里，也走不到
  // 下面那条普通消息分支（tool_result 分支已经 continue）——不专门带上就是无声丢图
  r = ain.toInternal({
    model: "m", max_tokens: 100,
    messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "b1", content: "结果" },
      { type: "text", text: "看这张" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    ] }],
  });
  const mLast = r.body.messages[r.body.messages.length - 1];
  ok(mLast.role === "user" && Array.isArray(mLast.content) && mLast.content[1] && mLast.content[1].image_url.url === "data:image/png;base64,QUJD",
    "① tool_result 与图片混排时图片不丢（挂在文本那条 user 消息上）", r.body.messages);
  ok(r.body.messages[0].role === "tool" && r.body.messages[0].tool_call_id === "b1",
    "① 混排时 tool_result 照常展开成 role:tool", r.body.messages[0]);

  r = ain.toInternal({
    model: "m", max_tokens: 100,
    messages: [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] },
      { role: "user", content: [{ type: "image", source: { type: "file", file_id: "f1" } }] },
      { role: "user", content: [{ type: "document", source: { type: "text", data: "pdf" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "推理", signature: "sig" }] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "zzz" }] },
    ],
    tools: [{ name: "Read", input_schema: { type: "object" } }, { name: "bad name!", input_schema: { type: "object" } }],
    tool_choice: { type: "any" },
    top_k: 40, metadata: { user_id: "u" },
  });
  ok(r.body.messages[0].content[1].image_url.url === "data:image/png;base64,QUJD", "① base64 图 → data URI（text 块排在前面，顺序不变）", r.body.messages[0]);
  ok(r.notes.some((n) => /file/.test(n)), "① file 图源无对应物：丢弃且留痕", r.notes);
  ok(r.notes.some((n) => /signature/.test(n)), "① thinking.signature 不回投：留痕", r.notes);
  ok(r.notes.some((n) => /document/.test(n)), "① document 块丢弃：留痕", r.notes);
  ok(r.notes.some((n) => /redacted/.test(n)), "① redacted_thinking 丢弃：留痕", r.notes);
  ok(r.body.tools[0].type === "function" && r.body.tools[0].function.name === "Read", "① tools 转 OpenAI 嵌套形态", r.body.tools);
  ok(r.notes.some((n) => /工具名/.test(n)), "① Anthropic 非法工具名留痕（不静默改写）", r.notes);
  ok(r.body.tool_choice === "required", "① tool_choice any → required", r.body.tool_choice);
  ok(!("extraBody" in r.body) && !("top_k" in r.body) && !("metadata" in r.body),
    "① 转不进规范形的私有字段绝不外泄成未知键", Object.keys(r.body));
  ok(r.notes.filter((n) => /top_k|metadata/.test(n)).length === 2, "① top_k / metadata 各有且只有一条损失记录", r.notes);
}

// ===== ② thinking 预算 → reasoning_effort 换算（阈值表是可调常量，逐条钉住边界） =====
console.log("\n② thinking 预算换算:");
{
  const T = [
    [{ type: "enabled", budget_tokens: 1 }, "low"],
    [{ type: "enabled", budget_tokens: 4096 }, "low"],
    [{ type: "enabled", budget_tokens: 4097 }, "medium"],
    [{ type: "enabled", budget_tokens: 16384 }, "medium"],
    [{ type: "enabled", budget_tokens: 16385 }, "high"],
    [{ type: "enabled", budget_tokens: 32768 }, "high"],
    [{ type: "enabled", budget_tokens: 32769 }, "max"],
    [{ type: "enabled", budget_tokens: 999999 }, "max"],
    [{ type: "disabled" }, "off"],
    [{ type: "enabled", budget_tokens: 0 }, "off"],
    [{ type: "enabled", budget_tokens: -1 }, undefined],
    [{ type: "enabled" }, undefined],
    [{ type: "enabled", budget_tokens: "abc" }, undefined],
    // 「没给预算」≠「预算为 0」：Number(null) 与 Number("") 都是 0，先转数会把客户端
    // 只是没填这个字段当成「显式关掉思考」，把用户的思考静默关掉
    [{ type: "enabled", budget_tokens: null }, undefined],
    [{ type: "enabled", budget_tokens: "" }, undefined],
    [null, undefined],
  ];
  for (const [thinking, want] of T) {
    const got = ain._budgetToEffort(thinking);
    ok(got === want, `② ${JSON.stringify(thinking)} → ${want === undefined ? "不派生档位" : want}（实测 ${got}）`);
  }
  // 大小写与空白：type 的读法与 util.injectThinking 同口径（trim + 匹配 disabled）
  ok(ain._budgetToEffort({ type: " DISABLED " }) === "off", "② type 大小写/空白混用仍判成关思考", ain._budgetToEffort({ type: " DISABLED " }));

  const b1 = ain.toInternal({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "x" }], thinking: { type: "enabled", budget_tokens: 20000 } });
  ok(b1.body.reasoning_effort === "high", "② 预算落档写进规范形的 reasoning_effort", b1.body.reasoning_effort);
  const b2 = ain.toInternal({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "x" }], thinking: { type: "disabled" } });
  ok(b2.body.reasoning_effort === "off", "② 关思考落成 off 标记（不是删字段——删了会被适配器补回默认档）", b2.body.reasoning_effort);
  const b3 = ain.toInternal({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "x" }] });
  ok(!("reasoning_effort" in b3.body), "② 没写 thinking 时不凭空造档位", Object.keys(b3.body));

  // 原件必须跟着走：网关有一条 Anthropic 形态的出站（zcode 渠道的 zcodeAnthropic.toAnthropic
  // 直接读 body.thinking 的 type / budget_tokens）。这里不测「我们以为它读」，而是把真函数跑一遍。
  const zcodeAnthropic = require("../electron/backend/proxy/zcodeAnthropic.cjs");
  const exact = ain.toInternal({
    model: "m", max_tokens: 8192, messages: [{ role: "user", content: "x" }],
    thinking: { type: "enabled", budget_tokens: 3000 },
  });
  ok(exact.ok && exact.body.thinking && exact.body.thinking.budget_tokens === 3000,
    "② thinking 原件逐字留在规范形里（预算精确值不是只换算成档位）", exact.body.thinking);
  const zReq = zcodeAnthropic.toAnthropic("glm-5.3-flash", exact.body, {});
  ok(zReq && zReq.thinking && zReq.thinking.type === "enabled" && zReq.thinking.budget_tokens === 3000,
    "② 接上真实出站：Anthropic 形态上游拿到的是客户端给的 3000，而不是出站侧写死的 budgetMap 值", zReq && zReq.thinking);
  ok(zReq.max_tokens === 8192, "② 出站请求的 max_tokens 仍是客户端值（预算与上限不互相顶掉）", zReq.max_tokens);

  // 如实记录一条做不到的事：zcode 那条 GLM 上游对 disabled 必 400（它自己的注释带实测流水），
  // 所以「关思考」在该渠道被折叠成最低预算。这不是本层能修的，也不该假装没发生。
  const zOff = zcodeAnthropic.toAnthropic("glm-5.3-flash", ain.toInternal({
    model: "m", max_tokens: 8192, messages: [{ role: "user", content: "x" }],
    thinking: { type: "disabled" },
  }).body, {});
  ok(zOff.thinking && zOff.thinking.type === "enabled" && zOff.thinking.budget_tokens === 2048,
    "② 已知边界如实钉住：zcode/GLM 侧 disabled 被上游自己折叠成 enabled+2048（该上游关不掉思考）", zOff.thinking);

  // deepseek 那条靠原件里的 type 抑制注入：只发 off 不发原件时，injectThinking 会把
  // 「关思考」翻回 thinking:{type:"enabled"} —— 原件在，它才看得见用户其实关掉了。
  const ds = ain.toInternal({
    model: "deepseek-v3.2", max_tokens: 100, messages: [{ role: "user", content: "x" }],
    thinking: { type: "disabled" },
  }).body;
  util.injectThinking(ds, "high");
  ok(ds.thinking.type === "disabled" && !("reasoning_effort" in ds),
    "② deepseek 通路：原件里的 disabled 让 injectThinking 删档而不是补默认档（否则关思考被翻回开思考）", ds);

  // off 能不能活到上游，取决于档位降级那一层（issue #128 的守卫）。这里把两段的接缝钉住：
  // 协议层产出的 off 交给 util.normalizeReasoningEffort 之后必须还是 off。
  const obj = { model: "m", reasoning_effort: b2.body.reasoning_effort };
  util.normalizeReasoningEffort(obj, { supportedEfforts: ["low", "medium", "high"] });
  ok(obj.reasoning_effort === "off", "② 关思考标记过完档位降级仍是 off（被抬成 low 即 #128 的缺陷复发）", obj.reasoning_effort);
}

// ===== ③ 网关 Key 的两种读法 =====
console.log("\n③ 读网关 Key:");
{
  ok(ain.readKey({ headers: { "x-api-key": "sk-a", authorization: "Bearer sk-a" } }).key === "sk-a", "③ x-api-key 与 Bearer 同值时取 x-api-key");
  ok(ain.readKey({ headers: { authorization: "Bearer sk-b" } }).key === "sk-b", "③ 只有 Bearer 也能读（Anthropic SDK 允许的标准写法）");
  ok(/两把不同/.test(ain.readKey({ headers: { "x-api-key": "sk-a", authorization: "Bearer sk-z" } }).error || ""),
    "③ 两者不等价时明确报错，不静默挑一个（挑哪个记账就会按哪个算）");
  ok(ain.readKey({ headers: {} }).key === "", "③ 两个头都没有时回空 Key（由调用方判 401）");
}

// ===== ④ count_tokens 的估算口径 =====
console.log("\n④ count_tokens:");
{
  const a = ain.countTokens({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "x".repeat(400) }] });
  const b = ain.countTokens({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "x" }] });
  ok(a.input_tokens >= 100 && a.input_tokens > b.input_tokens, "④ 返回 input_tokens 且随文本变长而变大", [a, b]);
  const bad = ain.countTokens({ model: "m" });
  ok(Number.isFinite(bad.input_tokens), "④ 非法请求体也要回一个数（这是可选端点，报 500 会让客户端整个上下文统计崩掉）", bad);
}

// ===== 端到端：真 HTTP 打进真调度核心，只桩掉「上游」与「号池」 =====
const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const server = require("../electron/backend/proxy/server.cjs");

/** 解析 SSE：Messages 协议每个事件都带 event: 行；SSE 注释帧单独标成 comment */
function parseSse(text) {
  const out = [];
  for (const block of String(text).split("\n\n")) {
    if (!block.trim()) continue;
    let event = null, data = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) { try { data = JSON.parse(line.slice(5).trim()); } catch { data = null; } }
      else if (line.startsWith(":")) out.push({ event: "comment", data: { text: line.slice(1).trim() } });
    }
    if (data) out.push({ event, data });
  }
  return out;
}
const types = (frames) => frames.filter((f) => f.event !== "comment").map((f) => f.data.type);

function post(urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const h = { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(headers || {}) };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const req = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method: "POST", headers: h }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text, ctype: res.headers["content-type"] }));
    });
    // 超时是闸自己的基础设施：网关若在某条路径上不再回应，必须让它报错变红，
    // 而不是把整条闸挂在那里等人去 kill（Messages 的非流式用例就是这么被发现的）
    req.setTimeout(15000, () => req.destroy(new Error(`请求 ${urlPath} 15s 无响应`)));
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

const MSG = (extra) => Object.assign({ model: MODEL, max_tokens: 512, stream: true, messages: [{ role: "user", content: "hi" }] }, extra || {});

(async () => {
  store.open();
  const gwKey = store.createKey({ name: "anthropic-e2e", route: "auto", dailyQuota: 0, rateLimit: 0 });
  const secret = gwKey.secret;
  // 日配额 1 次的第二把 Key：配合下面的 TODAY_REQ 造出「鉴权通过但配额已满」的 429
  const quotaKey = store.createKey({ name: "anthropic-quota", route: "auto", dailyQuota: 1, rateLimit: 0 });
  const apiKey = (s) => ({ "x-api-key": s === undefined ? secret : s });
  const bearerOnly = () => ({ "x-api-key": undefined, authorization: "Bearer " + secret });

  const accounts = {
    acc1: { id: "acc1", channel: "trae", name: "一号", status: "online" },
    acc2: { id: "acc2", channel: "trae", name: "二号", status: "online" },
  };
  // 用例之间不共享剧本游标：每个用例开头 resetCase()
  let PICKS = ["acc1"];
  let SCRIPTS = [];
  let EXTRA = null;      // 本用例要覆盖的 settings 字段（disabledModels / modelFallback / enableAnthropic…）
  let TODAY_REQ = 0;     // 今日已用请求数（配合 dailyQuota 造 429）
  let pickIdx = 0;       // 选号次数（pool.pickAccount 每次尝试前调一次，同号退避不再调）
  let callIdx = 0;       // 上游调用次数（决定播第几份剧本）
  const seenBodies = []; // 适配器实际收到的内部规范形 —— 协议层判据的落点
  const resetCase = (c) => {
    PICKS = (c && c.picks) || ["acc1"];
    SCRIPTS = (c && c.scripts) || [];
    EXTRA = (c && c.extraSettings) || null;
    pickIdx = 0; callIdx = 0; seenBodies.length = 0;
  };

  const raw = {
    adaptersGet: adapters.get,
    adaptersRefresh: adapters.refreshTokenLocked,
    adaptersOwners: adapters.modelOwners,
    poolPick: pool.pickAccount,
  };
  // 默认口径：请求 MODEL 即命中 trae（与 dev-sink-golden 一致）；回退用例临时换成「只认 MODEL」
  const defaultOwners = (model) => (String(model) === MODEL ? ["trae"] : raw.adaptersOwners(model));
  adapters.modelOwners = defaultOwners;
  adapters.get = (channel) => {
    const real = raw.adaptersGet(channel);
    if (!real) return real;
    return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      chat: async (ctx) => {
        seenBodies.push(ctx.body);
        const steps = SCRIPTS[Math.min(callIdx, SCRIPTS.length - 1)] || [];
        callIdx += 1;
        for (const s of steps) {
          if (s.throw) { const e = new Error(s.throw.message); Object.assign(e, s.throw); throw e; }
          if (s.emit) ctx.emit(s.emit);
          if (s.return) return s.return;
        }
        return { status: 200, planLimit: false };
      },
    });
  };
  adapters.refreshTokenLocked = async () => ({ ok: false });
  pool.pickAccount = (channel, strategy, exclude) => {
    const want = PICKS[pickIdx];
    pickIdx += 1;
    if (!want) return null;
    if ((exclude || []).includes(want)) return null;
    return accounts[want];
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
  pool.poolSummary = (channel) => ({ channel, onlineCount: 2, totalCredits: 100, accountCount: 2, todayReq: 0, todayTokens: 0, lastCreditsAt: 0, earliestExpire: 0, expiringSoon: false });
  store.getAccount = (id) => ({ id: String(id), channel: "trae", token_enc: "", refresh_enc: "", meta: "", status: "online" });
  store.accountSecrets = () => ({ token: "tok", refreshToken: "ref" });
  store.updateAccount = () => true;
  store.bumpAccountUsage = () => {};
  store.noteError = () => {};
  store.keyTodayReq = () => TODAY_REQ;

  const SETTINGS = () => Object.assign({
    port: PORT, bind: "127.0.0.1", rateLimitPerMin: 0, concurrency: 8,
    routeStrategy: "smart", fixedChannel: "trae", modelOverrides: {}, debugStatus: false,
    humanizeJitter: false, disabledModels: [], modelFallback: {}, modelAliases: {},
    // 渠道降级时长压到 1ms：channelHealth / channelFailStreaks 是 server 的模块私有态，
    // 进程内跨用例残留（dev-sink-golden 因此一场景一子进程）。本闸不测降级行为，
    // 把冷却墙钟缩到即刻过期，用例之间就互不污染、也不依赖用例顺序。
    channelCooldownMs: 1, channelCooldownCapMs: 1,
  }, EXTRA || {});

  /** 跑一个用例：设定剧本 → 发请求 → 响应 + 适配器收到的规范形 */
  async function run(c) {
    resetCase(c);
    const res = await post(c.url || "/v1/messages", c.body, c.headers || apiKey());
    return { res, bodies: seenBodies.slice() };
  }

  // ===== ⑤ 流式：事件序列与块边界 =====
  console.log("\n⑤ 端到端·流式:");
  const SUCCESS = [
    { emit: { type: "delta", delta: { role: "assistant", content: "" } } },
    { emit: { type: "delta", delta: { reasoning_content: "先想想" } } },
    { emit: { type: "delta", delta: { content: "你好" } } },
    { emit: { type: "delta", delta: { content: "，世界" } } },
    { emit: { type: "finish", reason: "stop" } },
    { emit: { type: "usage", usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } } },
    { return: { status: 200, planLimit: false } },
  ];
  {
    const sr = await server.start(SETTINGS);
    ok(sr.ok === true && sr.port === PORT, "端到端：网关在测试端口起来", sr);
  }
  {
    const { res, bodies } = await run({ scripts: [SUCCESS], body: MSG() });
    const f = parseSse(res.text);
    ok(res.status === 200 && /text\/event-stream/.test(res.ctype || ""), "⑤ 流式 200 且 content-type 是 SSE", [res.status, res.ctype]);
    ok(JSON.stringify(types(f)) === JSON.stringify([
      "message_start", "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]), "⑤ 事件顺序：start→思考块→正文块→message_delta→stop", types(f));
    const starts = f.filter((x) => x.data.type === "content_block_start").map((x) => x.data.index);
    ok(starts.join(",") === "0,1", "⑤ 块 index 连续从 0 开始（跳号会让客户端把两块并成一块）", starts);
    ok(f.filter((x) => x.data.type === "content_block_stop").map((x) => x.data.index).join(",") === "0,1", "⑤ 每个开着的块都有关闭事件", f.map((x) => x.data.type));
    const th = f.find((x) => x.data.delta && x.data.delta.type === "thinking_delta");
    const tx = f.filter((x) => x.data.delta && x.data.delta.type === "text_delta");
    ok(th && th.data.delta.thinking.includes("先想想"), "⑤ reasoning_content 独立成 thinking 块", th);
    ok(th && f[f.indexOf(th) - 1].data.type === "content_block_start" && f[f.indexOf(th) - 1].data.content_block.type === "thinking",
      "⑤ thinking 增量之前先发的是 thinking 的 start 帧（顺序反了客户端会报块类型不符）");
    ok(tx.map((x) => x.data.delta.text).join("") === "你好，世界", "⑤ 正文增量按序送达、不丢字", tx.map((x) => x.data.delta.text));
    const start = f[0].data.message;
    ok(/^msg_/.test(start.id) && start.role === "assistant" && start.model === MODEL && start.stop_reason === null,
      "⑤ message_start 带 msg_ 前缀 id、回显请求模型、stop_reason 为 null", start);
    ok(start.usage.input_tokens > 0, "⑤ message_start 的 input_tokens 用网关本地估算（0 会让客户端的上下文占用显示失真）", start.usage);
    const md = f[f.length - 2].data;
    ok(md.delta.stop_reason === "end_turn" && md.usage.output_tokens === 22, "⑤ message_delta 收 stop_reason=end_turn 且带上游真 usage", md);
    ok(f.filter((x) => x.data.type === "message_start").length === 1, "⑤ 全程恰好一个 message_start", types(f));
    ok(bodies.length === 1 && bodies[0].max_tokens === 512 && bodies[0].stream === true && bodies[0].model === MODEL,
      "⑤ 适配器收到的是转换后的规范形（model/max_tokens/stream 落位）", bodies[0] && { model: bodies[0].model, max_tokens: bodies[0].max_tokens, stream: bodies[0].stream });
  }

  // ===== ⑥ 换号：首帧扣在缓冲里，重发零痕迹 =====
  console.log("\n⑥ 端到端·换号重发:");
  {
    const { res } = await run({
      // 无明示重置时间的 429 会先同号退避重试一次（rateRetried，server 里那次 attempt-- 会再
      // 选一次号），所以选号序列是 一号→一号→二号；少列一格会让二号被白白烧掉
      picks: ["acc1", "acc1", "acc2"],
      scripts: [
        [{ throw: { message: "Too Many Requests", status: 429 } }],
        [{ throw: { message: "Too Many Requests", status: 429 } }],
        SUCCESS,
      ],
      body: MSG(),
    });
    const f = parseSse(res.text);
    ok(res.status === 200 && types(f).filter((t) => t === "message_start").length === 1,
      "⑥ 一号连续吃 429、换到二号才成功：流里仍只有一个 message_start（两个必炸）", types(f));
    const tx = f.filter((x) => x.data.delta && x.data.delta.type === "text_delta").map((x) => x.data.delta.text).join("");
    ok(tx === "你好，世界" && types(f)[types(f).length - 1] === "message_stop",
      "⑥ 换号后的正文完整送达，前一次尝试没有留下半截块", [tx, types(f)]);
  }

  // ===== ⑦ 工具调用 =====
  console.log("\n⑦ 端到端·工具调用:");
  {
    const { res } = await run({
      scripts: [[
        { emit: { type: "delta", delta: { role: "assistant" } } },
        { emit: { type: "delta", delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "Read", arguments: "" } }] } } },
        { emit: { type: "delta", delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } } },
        { emit: { type: "delta", delta: { tool_calls: [{ index: 0, function: { arguments: '"/x"}' } }] } } },
        { emit: { type: "finish", reason: "tool_calls" } },
        { return: { status: 200, planLimit: false } },
      ]],
      body: MSG(),
    });
    const f = parseSse(res.text);
    const toolStart = f.find((x) => x.data.content_block && x.data.content_block.type === "tool_use");
    const pj = f.filter((x) => x.data.delta && x.data.delta.type === "input_json_delta").map((x) => x.data.delta.partial_json).join("");
    ok(toolStart && toolStart.data.content_block.id === "call_9" && toolStart.data.content_block.name === "Read",
      "⑦ tool_use 块带 id 与 name（call id 原样透出，客户端才能回填 tool_result）", toolStart);
    ok(pj === '{"path":"/x"}', "⑦ arguments 以 partial_json 增量拼回且逐字相等", pj);
    ok(f.filter((x) => x.data.type === "content_block_start").length === 1 && f.filter((x) => x.data.type === "content_block_stop").length === 1,
      "⑦ 一个 tool_call 恰好一起一止", types(f));
    ok(f[f.length - 2].data.delta.stop_reason === "tool_use", "⑦ finish_reason=tool_calls → stop_reason=tool_use", f[f.length - 2].data);
  }

  // ===== ⑧ finish_reason 映射与认不出的取值 =====
  console.log("\n⑧ 端到端·stop_reason 映射:");
  {
    const { res } = await run({
      scripts: [[
        { emit: { type: "delta", delta: { content: "被截断" } } },
        { emit: { type: "finish", reason: "length" } },
        { return: { status: 200, planLimit: false } },
      ]],
      body: MSG(),
    });
    const f = parseSse(res.text);
    ok(f[f.length - 2].data.delta.stop_reason === "max_tokens", "⑧ finish_reason=length → max_tokens", f[f.length - 2].data);

    const r2 = await run({
      scripts: [[
        { emit: { type: "delta", delta: { content: "怪原因" } } },
        { emit: { type: "finish", reason: "some_upstream_private_reason" } },
        { return: { status: 200, planLimit: false } },
      ]],
      body: MSG(),
    });
    const f2 = parseSse(r2.res.text);
    ok(f2[f2.length - 2].data.delta.stop_reason === "end_turn",
      "⑧ 认不出的 finish_reason 落成 end_turn（回一个非法 stop_reason 会让客户端判整轮失败）", f2[f2.length - 2].data);
  }

  // ===== ⑨ 非流式：一次性 JSON，且绝不中途裸写 =====
  console.log("\n⑨ 端到端·非流式:");
  {
    // 这条单独兜住 socket 异常：非流式路径上一旦中途裸写，res.json 会抛「headers already sent」，
    // 表现是连接被掐/永久挂住。让它报成一条 FAIL，而不是把后面所有用例一起带走。
    let res;
    try {
      res = (await run({ scripts: [SUCCESS], body: MSG({ stream: false }) })).res;
    } catch (e) {
      res = { status: 0, text: `<请求异常 ${String((e && (e.code || e.message)) || e)}>`, ctype: "" };
    }
    let j = null;
    try { j = JSON.parse(res.text); } catch { /* 下面按 j 为空判红 */ }
    ok(!!j, "⑨ 非流式回的是一个完整 JSON 对象（中途裸写会让 res.json 抛错、请求永久挂住）", res.text.slice(0, 200));
    ok(j && j.type === "message" && j.role === "assistant" && Array.isArray(j.content), "⑨ 顶层是 Messages 对象", j && Object.keys(j));
    ok(j && j.content.some((b) => b.type === "text" && b.text === "你好，世界"), "⑨ 正文聚合成一个 text 块", j && j.content);
    ok(j && j.content.some((b) => b.type === "thinking" && b.thinking === "先想想" && "signature" in b),
      "⑨ 思考聚合成 thinking 块（签名伪造不了，但字段位必须在）", j && j.content);
    ok(j && j.stop_reason === "end_turn" && j.usage.output_tokens === 22 && j.usage.input_tokens === 11, "⑨ usage 用上游真值", j && j.usage);
    ok(!/event:/.test(res.text), "⑨ 非流式响应里没有任何 SSE 帧", res.text.slice(0, 120));
  }

  // ===== ⑩ 上游一个 usage 都没发时用调度估算兜底（与落库的数同口径） =====
  console.log("\n⑩ 端到端·usage 兜底:");
  {
    const { res } = await run({
      scripts: [[
        { emit: { type: "delta", delta: { content: "一二三四五六七八九十".repeat(10) } } },
        { emit: { type: "finish", reason: "stop" } },
        { return: { status: 200, planLimit: false } },
      ]],
      body: MSG(),
    });
    const f = parseSse(res.text);
    ok(f[f.length - 2].data.usage.output_tokens > 0,
      "⑩ 上游不发 usage 时 message_delta 的 output_tokens 用调度侧估算（写 0 会让客户端用量页一片空白，且与流水记的数互相打脸）", f[f.length - 2].data);
  }

  // ===== ⑪ 错误形状：全部按 Messages 的外壳回 =====
  console.log("\n⑪ 端到端·错误形状:");
  {
    const bad = await post("/v1/messages", MSG(), apiKey("sk-wrong-key"));
    let j = {};
    try { j = JSON.parse(bad.text); } catch { /* 判红 */ }
    ok(bad.status === 401 && j.type === "error" && j.error.type === "authentication_error",
      "⑪ 鉴权失败回 Anthropic 形状（给 Claude Code 一个 OpenAI 的 401 会被判连接失败）", [bad.status, bad.text.slice(0, 160)]);

    const two = await post("/v1/messages", MSG(), { "x-api-key": secret, authorization: "Bearer sk-other" });
    ok(two.status === 401 && /两把不同/.test(two.text), "⑪ 两把 Key 指向不同值：明确 401 而不是静默挑一个", [two.status, two.text.slice(0, 160)]);

    // 这条要真打到上游才算「过了鉴权」，所以必须走 resetCase：选号游标停在上一条用例的
    // 位置上时 pool.pickAccount 会回 null，表现为一个误导人的 503。
    resetCase({ picks: ["acc1"], scripts: [SUCCESS] });
    const viaBearer = await post("/v1/messages", MSG(), bearerOnly());
    ok(viaBearer.status === 200, "⑪ 只有 Authorization: Bearer 也能过鉴权（Anthropic SDK 的标准写法之一）", viaBearer.status);

    const noMax = await post("/v1/messages", { model: MODEL, messages: [{ role: "user", content: "hi" }] }, apiKey());
    ok(noMax.status === 400 && JSON.parse(noMax.text).error.type === "invalid_request_error",
      "⑪ 归一失败按 Messages 形状回 400（协议自身必填缺失，不进调度）", [noMax.status, noMax.text.slice(0, 160)]);

    const emptyMsg = await post("/v1/messages", { model: MODEL, max_tokens: 10, messages: [] }, apiKey());
    ok(emptyMsg.status === 400 && /messages 不能为空/.test(emptyMsg.text), "⑪ 空 messages 的文案能读到（不是笼统的「参数错误」）", emptyMsg.text.slice(0, 160));

    const unknown = await run({ picks: [], scripts: [[]], body: MSG({ model: "no-such-model-at-all" }) });
    ok(unknown.res.status === 400 && JSON.parse(unknown.res.text).error.type === "invalid_request_error",
      "⑪ 模型不在任何渠道目录：400 且形状是 Messages（这条走的是调度内部，不是归一层）", [unknown.res.status, unknown.res.text.slice(0, 200)]);

    const disabled = await run({ picks: [], scripts: [[]], body: MSG(), extraSettings: { disabledModels: [MODEL] } });
    ok(disabled.res.status === 400 && /已被禁用/.test(disabled.res.text), "⑪ 模型被禁用时也是 Messages 形状", [disabled.res.status, disabled.res.text.slice(0, 160)]);

    // 429 的 error.type：Anthropic 的枚举里有独立的 rate_limit_error，客户端按它决定「退避重试」
    // 还是「报网关故障」。按状态码查表而不是照抄调度侧传来的 OpenAI 形 type 就是为了这个。
    TODAY_REQ = 99;
    const quota = await run({ picks: [], scripts: [[]], body: MSG(), headers: apiKey(quotaKey.secret) });
    TODAY_REQ = 0;
    ok(quota.res.status === 429 && JSON.parse(quota.res.text).error.type === "rate_limit_error",
      "⑪ 配额用尽的 429 回 rate_limit_error（回成 api_error 会把限流说成网关故障）", [quota.res.status, quota.res.text.slice(0, 160)]);

    // 协议不串味：OpenAI 那条面的错误外壳必须还是 OpenAI 的
    const chat = await run({
      url: "/v1/chat/completions", headers: bearerOnly(),
      picks: [], scripts: [[]], body: MSG({ model: "no-such-model-at-all" }),
    });
    ok(chat.res.status === 400 && chat.res.text.includes('"error"') && !/"type":"error"/.test(chat.res.text),
      "⑪ 同一条拒绝打到 /v1/chat/completions 时回 OpenAI 形状（surface 分流不能只看状态码）", chat.res.text.slice(0, 200));
  }

  // ===== ⑫ 流中错误：已出线则塞进流里，且它是这一轮的最后一个事件 =====
  console.log("\n⑫ 端到端·流中错误:");
  {
    const { res } = await run({
      scripts: [[
        { emit: { type: "delta", delta: { content: "前半段" } } },
        { emit: { type: "error", message: "上游中断", status: 502, code: 9 } },
        { return: { status: 200, planLimit: false } },
      ]],
      body: MSG(),
    });
    const f = parseSse(res.text);
    ok(types(f).includes("error"), "⑫ 已出线的流中错误下发成 event: error", types(f));
    ok(!types(f).includes("message_stop") && !types(f).includes("message_delta"),
      "⑫ event: error 之后不再补 message_delta / message_stop：按协议 error 就是这一轮的终点。" +
      "补了等于给客户端一个 stop_reason=end_turn 的正常收尾，而正文其实是截断的",
      types(f));
    ok(f[f.length - 1].data.type === "error", "⑫ 错误帧是这条流的最后一个事件", types(f));
    const errFrame = f.find((x) => x.data.type === "error");
    ok(errFrame && errFrame.data.error.type === "api_error", "⑫ 流内错误的 error.type 落在 api_error", errFrame && errFrame.data);
    ok(/前半段/.test(res.text), "⑫ 出错前已送达的正文不撤（撤不回来的字节就不该假装没发）", res.text.slice(0, 200));
  }

  // ===== ⑬ 模型回退的注释帧不得破坏事件结构 =====
  console.log("\n⑬ 端到端·模型回退注释帧:");
  {
    adapters.modelOwners = (model) => (String(model) === MODEL ? ["trae"] : []);
    const { res } = await run({
      picks: ["acc1"], scripts: [SUCCESS],
      body: MSG({ model: "no-such-model" }),
      extraSettings: { modelFallback: { "no-such-model": MODEL } },
    });
    const f = parseSse(res.text);
    ok(res.status === 200 && types(f)[0] === "message_start", "⑬ 回退后仍正常出 Messages 事件流", [res.status, types(f)[0]]);
    ok(f.some((x) => x.event === "comment" && /fallback/.test(x.data.text)),
      "⑬ 回退明示走 SSE 注释帧：客户端按规范忽略它，抓包看得到", res.text.slice(0, 200));
    const iComment = f.findIndex((x) => x.event === "comment");
    ok(iComment > 0, "⑬ 注释帧排在 message_start 之后（先提交头与首帧，否则按内容类型判流的客户端直接失败）", iComment);
    ok(types(f)[types(f).length - 1] === "message_stop" && types(f).filter((t) => t === "message_start").length === 1,
      "⑬ 注释帧不产生第二个流头，也不打断收尾", types(f));
    adapters.modelOwners = defaultOwners;
  }

  // ===== ⑭ 止血开关：关掉即回到「该端点不存在」 =====
  console.log("\n⑭ 端到端·止血开关:");
  {
    // 开关是每条请求现读的 settings（路由里判 settings().enableAnthropic === false），
    // 不需要重启服务：换 EXTRA 与用户在 config.json 里改完重启等效。
    resetCase({ picks: ["acc1"], scripts: [SUCCESS], extraSettings: { enableAnthropic: false } });
    const off = await post("/v1/messages", MSG(), apiKey());
    ok(off.status === 404 && JSON.parse(off.text).error.type === "not_found_error",
      "⑭ enableAnthropic=false 时端点直接 404（不必回滚代码、不必重新打包）", [off.status, off.text.slice(0, 160)]);

    const chat = await post("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true }, bearerOnly());
    ok(chat.status === 200 && /data:/.test(chat.text), "⑭ 关掉 Messages 不影响 OpenAI 通路（两条面互不牵连）", [chat.status, chat.text.slice(0, 120)]);

    resetCase({ picks: ["acc1"], scripts: [SUCCESS], extraSettings: { enableAnthropic: false } });
    const ct = await post("/v1/messages/count_tokens", { model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "abc" }] }, apiKey());
    ok(ct.status === 200 && JSON.parse(ct.text).input_tokens >= 1,
      "⑭ count_tokens 不受开关影响（它是只读估算，没有要止的风险面）", [ct.status, ct.text.slice(0, 120)]);
  }

  server.stop();

  Object.assign(adapters, { get: raw.adaptersGet, refreshTokenLocked: raw.adaptersRefresh, modelOwners: raw.adaptersOwners });
  pool.pickAccount = raw.poolPick;
  store.close();

  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("\n闸自身异常:", e);
  process.exit(1);
});
