// 反代网关 · /v1/responses（OpenAI Responses 入站，Codex CLI 直连）自测
//
// 跑法：node scripts/dev-responses-in-test.cjs
// 隔离：APPDATA 指到 mkdtemp 的临时目录，不碰真实 %APPDATA%；端口 19572，
//       与 dev-sink-golden(19551) / dev-anthropic-in-test(19571) 都错开，可并发。
//
// 三条判据是从 Codex 解析器的行为反推的，不是照着实现写的（改出线之前先复核它们）：
//   1. EOF 之前必须有 response.completed —— 缺了 Codex 报 "stream closed before response.completed"；
//      response.incomplete 被它当失败，所以截断也发 completed，信息放 incomplete_details。
//   2. reasoning item 必须有 encrypted_content 这个 key（值可为 null）—— 缺 key 整个 item
//      解析失败并被静默丢弃。
//   3. function_call item 的 name / arguments / call_id 三键必需，call_id 与入站保真。
// 另外整条流的 sequence_number 必须严格递增且不重号：按它排序的客户端在重号时会错序。
//
// 打桩清单照 dev-anthropic-in-test.cjs（同一套接缝），不写全就会打到真实渠道上变成出网请求。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-responses-"));

const PORT = 19572;
const MODEL = "glm-4.6";

let pass = 0, failed = 0;
function ok(cond, msg, got) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { failed++; console.log("  ✗", msg, got !== undefined ? `→ got ${JSON.stringify(got).slice(0, 320)}` : ""); }
}

const rin = require("../electron/backend/proxy/protocols/responses-in.cjs");

// ===== ① 入站归一：Responses 请求体 → 内部规范形 =====
console.log("① 入站归一（纯函数）:");
{
  ok(rin.toInternal({ input: "hi" }).ok === false, "① 缺 model 被拒");
  ok(rin.toInternal({ model: "m" }).ok === false, "① 缺 input 被拒");
  ok(rin.toInternal({ model: "m", input: [] }).body.messages.length === 0, "① 空 input 数组：不报错，产出空 messages（由调度侧的 validateChatBody 统一拒）");
  ok(rin.toInternal(null).ok === false, "① 请求体不是对象时明确拒绝，不抛异常");
  const prev = rin.toInternal({ model: "m", input: "hi", previous_response_id: "resp_1" });
  ok(prev.ok === false && /完整历史/.test(prev.message), "① previous_response_id 被拒且文案给出怎么办（本期不保存会话）", prev.message);
  ok(rin.toInternal({ model: "m", input: "hi", previous_response_id: "" }).ok === true, "① 空串不算「要续写」（Codex 有些版本会带空字段）");

  let r = rin.toInternal({ model: "gpt-x", input: "你好" });
  ok(r.ok && r.body.messages.length === 1 && r.body.messages[0].content === "你好", "① 字符串 input → 一条 user", r.body);
  ok(r.body.stream === false, "① stream 缺省 false", r.body.stream);
  ok(!("max_tokens" in r.body), "① 没给 max_output_tokens 时不凭空造上限", Object.keys(r.body));

  r = rin.toInternal({
    model: "gpt-x",
    instructions: "你是一个助手",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    max_output_tokens: 512, temperature: 0.3, top_p: 0.9,
  });
  ok(r.body.messages[0].role === "system" && r.body.messages[0].content === "你是一个助手", "① instructions → 首条 system", r.body.messages);
  ok(r.body.max_tokens === 512 && r.body.temperature === 0.3 && r.body.top_p === 0.9, "① max_output_tokens → max_tokens，采样参数透传", [r.body.max_tokens, r.body.temperature]);

  // 客户端发来的 messages 数组（不是 Responses 的写法）：能接就接
  r = rin.toInternal({ model: "gpt-x", messages: [{ role: "user", content: "直接发 chat 形状" }] });
  ok(r.ok && r.body.messages[0].content === "直接发 chat 形状" && r.notes.some((n) => /messages 而非 input/.test(n)),
    "① 混用 chat 的 messages 写法时照收并留痕（不为难用户）", [r.body.messages, r.notes]);

  r = rin.toInternal({ model: "gpt-x", input: "问题", instructions: [{ type: "input_text", text: "A" }, { type: "input_text", text: "B" }] });
  ok(r.body.messages[0].content === "A\nB", "① instructions 的 ContentItem[] 形态按序拼一条", r.body.messages);
  ok(rin.toInternal({ model: "gpt-x", instructions: "只有系统提示" }).ok === false,
    "① 只有 instructions 没有 input 仍算空请求（客户端漏了 user 轮，续写无从谈起）");
}

// ===== ② input item[] 映射 =====
console.log("\n② input item 映射:");
{
  const r = rin.toInternal({
    model: "gpt-x",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "规则" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "看这张图" }, { type: "input_image", image_url: "https://a/b.png" }] },
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "我调用一下" }] },
      { type: "function_call", call_id: "call_7", name: "shell", arguments: '{"cmd":"ls"}' },
      { type: "function_call_output", call_id: "call_7", output: [{ type: "output_text", text: "a.txt" }] },
      { type: "function_call_output", call_id: "call_8", error: "命令失败" },
      { type: "web_search_call", id: "ws_1" },
      { type: "item_reference", id: "ir_1" },
    ],
  });
  const m = r.body.messages;
  ok(r.ok === true, "② 含私有 item 的请求不整体被拒（拒了打死 Codex）", r);
  ok(m[0].role === "system" && m[0].content === "规则", "② developer 归到 system", m[0]);
  ok(m[1].content[0].text === "看这张图" && m[1].content[1].image_url.url === "https://a/b.png", "② input_image → image_url 且文本排在前面", m[1]);
  ok(m[2].role === "assistant" && m[2].content === "我调用一下", "② assistant 的 output_text 归到 content", m[2]);
  ok(m[3].tool_calls[0].id === "call_7" && m[3].tool_calls[0].function.arguments === '{"cmd":"ls"}', "② function_call → tool_calls，call_id 原样保真", m[3]);
  ok(m[4].role === "tool" && m[4].tool_call_id === "call_7" && m[4].content === "a.txt", "② function_call_output → role:tool + tool_call_id", m[4]);
  ok(m[5].content === "[error] 命令失败", "② 工具报错带 [error] 前缀落进 role:tool", m[5]);
  ok(r.notes.some((n) => /reasoning/.test(n)), "② 历史里的 reasoning item 丢弃且留痕（思考不回投）", r.notes);
  ok(r.notes.some((n) => /web_search_call/.test(n)), "② 私有 item 类型丢弃且留痕", r.notes);
  ok(r.notes.some((n) => /item_reference/.test(n)), "② item_reference 丢弃且留痕（网关不保存会话）", r.notes);
  ok(m.length === 6, "② 丢弃项不占位（消息数正好是留下的那 6 条）", m.length);

  const r2 = rin.toInternal({
    model: "gpt-x",
    input: [{ type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: "https://x/y.png" }, { type: "output_text", text: "截图" }] }],
  });
  ok(r2.body.messages[0].content === "[image] https://x/y.png\n截图", "② 工具结果里的图片转可读引用（不静默丢）", r2.body.messages[0].content);
}

// ===== ③ tools / tool_choice / reasoning =====
console.log("\n③ tools 与档位:");
{
  const r = rin.toInternal({
    model: "gpt-x",
    input: "hi",
    tools: [
      { type: "function", name: "shell", description: "d", parameters: { type: "object", properties: {} }, strict: true },
      { type: "namespace", name: "multi", parameters: { type: "object" } },
      { type: "web_search" },
      { type: "function", function: { name: "nested", parameters: { type: "object" } } },
    ],
    tool_choice: { type: "function", name: "shell" },
    reasoning: { effort: "HIGH", summary: "auto" },
  });
  ok(r.body.tools[0].type === "function" && r.body.tools[0].function.name === "shell" && r.body.tools[0].function.strict === true,
    "③ 扁平 function → 嵌套形态（strict 一起带）", r.body.tools[0]);
  ok(r.body.tools.some((t) => t.function.name === "nested"), "③ chat 的嵌套写法也收（两种混用很常见）", r.body.tools.map((t) => t.function.name));
  ok(r.body.tools.some((t) => t.function.name === "multi") && r.notes.some((n) => /降级/.test(n)),
    "③ namespace 这类私有工具类型降级为 function 并留痕", r.notes);
  ok(!r.body.tools.some((t) => t.function.name === "web_search"), "③ 无 name 的托管工具直接丢弃", r.body.tools);
  ok(r.body.tool_choice.type === "function" && r.body.tool_choice.function.name === "shell",
    "③ tool_choice 扁平 → 嵌套（不转下游适配器认不出来）", r.body.tool_choice);
  ok(r.body.reasoning_effort === "high", "③ reasoning.effort 归一小写后走既有档位降级", r.body.reasoning_effort);
  ok(r.notes.some((n) => /reasoning\.summary/.test(n)), "③ reasoning 的其余键留痕（只有 effort 有对应位置）", r.notes);

  // effort:"none" 是 Responses 的「不推理」档（gpt-5.1 起的正式取值，Codex 的
  // model_reasoning_effort = "none" 走的就是它），本仓内部用 "off" 表示同一个意思。
  // 不归一的话 "none" 不是已知档位，会被原样透到上游；落到按家族改写的渠道（GLM 那条
  // 认不出就按「未知值 = 开思考」）反而抬成 high——用户关掉推理却拿到最耗的档。
  const none = rin.toInternal({ model: "m", input: "hi", reasoning: { effort: "none" } });
  ok(none.body.reasoning_effort === "off", "③ effort:none（不推理）归一到内部开关值 off", none.body.reasoning_effort);
  ok(none.notes.some((n) => /none/.test(n) && /off/.test(n)), "③ none→off 的归一留痕（可追溯）", none.notes);
  const noneUpper = rin.toInternal({ model: "m", input: "hi", reasoning: { effort: "NONE" } });
  ok(noneUpper.body.reasoning_effort === "off", "③ 大小写混用同样归一（NONE → off）", noneUpper.body.reasoning_effort);
  ok(rin.toInternal({ model: "m", input: "hi", reasoning: { effort: "minimal" } }).body.reasoning_effort === "minimal",
    "③ 真实档位不受影响（minimal 原样）");

  ok(rin.toInternal({ model: "m", input: "hi", tool_choice: "required" }).body.tool_choice === "required", "③ tool_choice 字符串 required 原样");
  ok(rin.toInternal({ model: "m", input: "hi", tool_choice: "none" }).body.tool_choice === "none", "③ tool_choice 字符串 none 原样");
  const hc = rin.toInternal({ model: "m", input: "hi", tool_choice: { type: "hosted_tool" } });
  ok(hc.body.tool_choice === "auto" && hc.notes.some((n) => /hosted_tool/.test(n)), "③ hosted_tool 退化成 auto 并留痕", [hc.body.tool_choice, hc.notes]);
}

// ===== ④ 收下但忽略 / parallel_tool_calls 的取值集合 =====
console.log("\n④ 忽略项与 parallel_tool_calls:");
{
  const r = rin.toInternal({
    model: "gpt-x", input: "hi",
    store: true, background: false, include: ["reasoning.matched_message_content"], truncation: "auto",
    service_tier: "priority", metadata: { a: 1 }, user: "u-1", top_logprobs: 3,
    text: { format: { type: "json_schema", json_schema: { name: "t" } } },
    parallel_tool_calls: "auto",
  });
  ok(r.ok === true, "④ 一堆网关没能力的字段收下不拒（回 400 会当场打死 Codex）", r);
  for (const f of ["store", "include", "truncation", "service_tier", "metadata", "user", "top_logprobs"]) {
    ok(r.notes.some((n) => n.includes(`字段 ${f} `)), `④ ${f} 有且只有一条「已收下并忽略」留痕`, r.notes);
  }
  ok(r.notes.some((n) => /text（结构化输出）/.test(n)), "④ text 未硬映射成 response_format，留痕", r.notes);
  ok(!("text" in r.body) && !("include" in r.body) && !("store" in r.body) && !("background" in r.body),
    "④ 转不进规范形的字段绝不外泄成未知键", Object.keys(r.body));
  ok(r.notes.some((n) => /parallel_tool_calls/.test(n)), "④ parallel_tool_calls=\"auto\" 留痕", r.notes);

  const on = rin.toInternal({ model: "m", input: "hi", parallel_tool_calls: true });
  ok(on.body.parallel_tool_calls === true, "④ boolean true 原样落进规范形（这是 chat 也认的键）", on.body.parallel_tool_calls);
  ok(on.notes.some((n) => /parallel_tool_calls/.test(n)) === false, "④ 真落地的不谎称已忽略", on.notes);
  const off = rin.toInternal({ model: "m", input: "hi", parallel_tool_calls: false });
  ok(off.body.parallel_tool_calls === false, "④ boolean false 也原样（替用户关掉并行调用是明确意图）", off.body.parallel_tool_calls);
  const auto = rin.toInternal({ model: "m", input: "hi", parallel_tool_calls: "auto" });
  ok(!("parallel_tool_calls" in auto.body),
    "④ \"auto\" 不强转成 true（那等于替用户打开并行调用）；省略该键就是 chat 侧的 auto 语义", Object.keys(auto.body));
  const st = rin.toInternal({ model: "m", input: "hi", store: false });
  ok(st.notes.some((n) => /store/.test(n)) && !("store" in st.body),
    "④ store:false 也只留痕：网关本来就不保存会话，不需要「替用户关掉上游持久化」这个动作", [st.notes, Object.keys(st.body)]);
}

// ===== 端到端：真 HTTP 打进真调度核心，只桩掉「上游」与「号池」 =====
const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const server = require("../electron/backend/proxy/server.cjs");

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
const frameOf = (frames, t) => frames.find((f) => f.data.type === t);

function post(urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const h = { "content-type": "application/json", ...(headers || {}) };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: urlPath, method: "POST", headers: h,
      // agent:false —— Node 19+ 的 globalAgent 带连接池，网关重启后复用同 host:port 的旧
      // socket 会直接 ECONNRESET。这是闸自己的基础设施坑，别让它伪装成被测代码的缺陷
      agent: false,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text, ctype: res.headers["content-type"] }));
    });
    req.setTimeout(15000, () => req.destroy(new Error(`请求 ${urlPath} 15s 无响应`)));
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

const MSG = (extra) => Object.assign({ model: MODEL, input: "你好", stream: true }, extra || {});

(async () => {
  store.open();
  const gwKey = store.createKey({ name: "responses-e2e", route: "auto", dailyQuota: 0, rateLimit: 0 });
  const secret = gwKey.secret;
  const quotaKey = store.createKey({ name: "responses-quota", route: "auto", dailyQuota: 1, rateLimit: 0 });
  const bearer = (s) => ({ authorization: "Bearer " + (s === undefined ? secret : s) });

  const accounts = {
    acc1: { id: "acc1", channel: "trae", name: "一号", status: "online" },
    acc2: { id: "acc2", channel: "trae", name: "二号", status: "online" },
  };
  let PICKS = ["acc1"];
  let SCRIPTS = [];
  let EXTRA = null;
  let TODAY_REQ = 0;
  let pickIdx = 0;
  let callIdx = 0;
  const seenBodies = [];
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
    // 渠道降级时长压到 1ms：module 私有态（channelHealth / channelFailStreaks）跨用例残留
    // 会让后面的用例拿到误导性的 503。本闸不测降级，缩墙钟即可，用例与顺序无关。
    channelCooldownMs: 1, channelCooldownCapMs: 1,
  }, EXTRA || {});

  async function run(c) {
    resetCase(c);
    const res = await post(c.url || "/v1/responses", c.body, c.headers || bearer());
    return { res, bodies: seenBodies.slice() };
  }

  const sr = await server.start(SETTINGS);
  ok(sr.ok === true && sr.port === PORT, "端到端：网关在测试端口起来", sr);

  const SUCCESS = [
    { emit: { type: "delta", delta: { role: "assistant", content: "" } } },
    { emit: { type: "delta", delta: { reasoning_content: "先想想" } } },
    { emit: { type: "delta", delta: { content: "你好" } } },
    { emit: { type: "delta", delta: { content: "，世界" } } },
    { emit: { type: "finish", reason: "stop" } },
    { emit: { type: "usage", usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } } },
    { return: { status: 200, planLimit: false } },
  ];

  // ===== ⑤ 流式事件序列与帧号 =====
  console.log("\n⑤ 端到端·事件序列:");
  {
    const { res, bodies } = await run({ scripts: [SUCCESS], body: MSG() });
    const f = parseSse(res.text);
    ok(res.status === 200 && /text\/event-stream/.test(res.ctype || ""), "⑤ 流式 200 且 content-type 是 SSE", [res.status, res.ctype]);
    ok(f[0].data.type === "response.created" && f[0].data.response.status === "in_progress", "⑤ 首帧是 response.created 且 status=in_progress", types(f).slice(0, 3));
    ok(types(f)[types(f).length - 1] === "response.completed", "⑤ 最后一帧是 response.completed（缺了 Codex 直接报错）", types(f).slice(-2));
    ok(!/\[DONE\]/.test(res.text), "⑤ 本协议没有 [DONE]（那是 chat 的东西，混进来客户端会当正文读）", res.text.slice(-80));
    ok(JSON.stringify(types(f)) === JSON.stringify([
      "response.created",
      "response.output_item.added", "response.reasoning_summary_part.added", "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done", "response.reasoning_summary_part.done", "response.output_item.done",
      "response.output_item.added", "response.content_part.added",
      "response.output_text.delta", "response.output_text.delta",
      "response.output_text.done", "response.content_part.done", "response.output_item.done",
      "response.completed",
    ]), "⑤ 完整事件顺序：思考项与正文项各自成对闭合，最后 completed 收束", types(f));
    const seqs = f.filter((x) => x.event !== "comment").map((x) => x.data.sequence_number);
    ok(seqs.every((n, i) => Number.isInteger(n) && (i === 0 || n > seqs[i - 1])) && seqs[0] === 0,
      "⑤ sequence_number 从 0 起严格递增（重号会让按它排序的客户端错序）", seqs);
    ok(f.filter((x) => x.data.type === "response.output_text.delta").map((x) => x.data.delta).join("") === "你好，世界",
      "⑤ 正文 delta 拼出全文");
    const added = f.filter((x) => x.data.type === "response.output_item.added").map((x) => x.data.item);
    ok(JSON.stringify(added.map((i) => i.type)) === JSON.stringify(["reasoning", "message"]), "⑤ 思考在前、正文在后，各占一个 output_index", added);
    ok(!!added.find((i) => i.type === "reasoning") && Object.prototype.hasOwnProperty.call(added.find((i) => i.type === "reasoning"), "encrypted_content"),
      "⑤ reasoning item 带 encrypted_content 键（缺 key 整个 item 会被 Codex 静默丢弃）", added);
    const doneItem = f.filter((x) => x.data.type === "response.output_item.done").map((x) => x.data.item).find((i) => i.type === "message");
    ok(doneItem && doneItem.status === "completed" && doneItem.content[0].type === "output_text" && doneItem.content[0].text === "你好，世界" && Array.isArray(doneItem.content[0].annotations),
      "⑤ output_item.done 的 item 是可反序列化的完整对象", doneItem);
    const comp = frameOf(f, "response.completed").data.response;
    ok(comp.status === "completed" && comp.output.length === 2 && comp.output[1].content[0].text === "你好，世界",
      "⑤ completed 帧里的 response.output 是两个完整 item", comp.output && comp.output.map((i) => i.type));
    ok(JSON.stringify(comp.usage) === JSON.stringify({ input_tokens: 11, output_tokens: 22, total_tokens: 33 }),
      "⑤ usage 用 Responses 的字段名（input/output/total_tokens），不是 chat 的 prompt/completion", comp.usage);
    ok(bodies.length === 1 && bodies[0].messages[0].content === "你好", "⑤ 适配器收到的是转换后的规范形", bodies[0] && bodies[0].messages);
  }

  // ===== ⑥ 工具调用三键与顺序 =====
  console.log("\n⑥ 端到端·工具调用:");
  {
    const { res } = await run({
      scripts: [[
        { emit: { type: "delta", delta: { role: "assistant" } } },
        { emit: { type: "delta", delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "shell", arguments: "" } }] } } },
        { emit: { type: "delta", delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] } } },
        { emit: { type: "delta", delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } } },
        { emit: { type: "finish", reason: "tool_calls" } },
        { return: { status: 200, planLimit: false } },
      ]],
      body: MSG(),
    });
    const f = parseSse(res.text);
    const fc = f.filter((x) => x.data.type === "response.output_item.added").map((x) => x.data.item)[0];
    ok(fc && fc.type === "function_call" && fc.name === "shell" && typeof fc.arguments === "string" && !!fc.call_id,
      "⑥ function_call item 三键齐备（name/arguments/call_id 缺一 Codex 就丢整个 item）", fc);
    ok(fc.call_id === "call_9", "⑥ call_id 与上游一致（下一轮靠它关联，改了就是断链）", fc.call_id);
    const argDeltas = f.filter((x) => x.data.type === "response.function_call_arguments.delta").map((x) => x.data.delta).join("");
    ok(argDeltas === '{"cmd":"ls"}', "⑥ 参数增量拼回完整 JSON", argDeltas);
    const t = types(f);
    ok(t.indexOf("response.function_call_arguments.done") < t.indexOf("response.output_item.done") && t[t.length - 1] === "response.completed",
      "⑥ 收尾序：arguments.done → item.done → completed（乱序时客户端会拿到空 arguments 的 item）", t);
    ok(frameOf(f, "response.output_item.done").data.item.arguments === '{"cmd":"ls"}', "⑥ item.done 的 arguments 是全量字符串");
    ok(frameOf(f, "response.completed").data.response.status === "completed", "⑥ finish_reason=tool_calls 仍收 completed（不是 failed）");
  }

  // ===== ⑦ 截断：不能发 response.incomplete =====
  console.log("\n⑦ 端到端·截断:");
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
    // 不假设 completed 帧一定在：缺帧要让断言变红，而不是让闸自己抛异常——
    // 崩掉的闸只给一句「闸自身异常」，看不出是哪条保护没了
    const compFrame = frameOf(f, "response.completed");
    ok(f[f.length - 1].data.type === "response.completed" && !types(f).includes("response.incomplete"),
      "⑦ max_tokens 截断也发 completed：Codex 把 response.incomplete 当失败", types(f));
    ok(compFrame && compFrame.data.response.incomplete_details && compFrame.data.response.incomplete_details.reason === "max_output_tokens",
      "⑦ 截断信息放在 incomplete_details 里（status 只有 completed/failed 两种）", compFrame && compFrame.data.response.incomplete_details);
  }

  // ===== ⑧ 换号：只有一个 response.created =====
  console.log("\n⑧ 端到端·换号重发:");
  {
    const { res } = await run({
      picks: ["acc1", "acc1", "acc2"],
      scripts: [
        [{ throw: { message: "Too Many Requests", status: 429 } }],
        [{ throw: { message: "Too Many Requests", status: 429 } }],
        SUCCESS,
      ],
      body: MSG(),
    });
    const f = parseSse(res.text);
    ok(res.status === 200 && types(f).filter((t) => t === "response.created").length === 1,
      "⑧ 一号连续吃 429、换到二号才成功：只有一个 response.created（deferredOpen 生效）", types(f));
    ok(frameOf(f, "response.completed").data.response.usage.total_tokens === 33,
      "⑧ 换号对客户端无痕：正文与 usage 仍是完整一轮");
    const seqs = f.filter((x) => x.event !== "comment").map((x) => x.data.sequence_number);
    ok(seqs.every((n, i) => i === 0 || n > seqs[i - 1]), "⑧ 换号后帧号仍不重号", seqs);
  }

  // ===== ⑨ 非流式 =====
  console.log("\n⑨ 端到端·非流式:");
  {
    let res;
    try { res = (await run({ scripts: [SUCCESS], body: MSG({ stream: false }) })).res; }
    catch (e) { res = { status: 0, text: `<请求异常 ${String((e && (e.code || e.message)) || e)}>`, ctype: "" }; }
    let j = null;
    try { j = JSON.parse(res.text); } catch { /* 判红 */ }
    ok(!!j && j.object === "response" && j.status === "completed" && /application\/json/.test(res.ctype || ""),
      "⑨ 非流式回一条 Response 对象而不是 SSE（中途裸写会让 res.json 抛错、请求永久挂住）", [res.status, res.ctype, res.text.slice(0, 160)]);
    ok(j && j.output[1] && j.output[1].content[0].text === "你好，世界" && j.output[0].type === "reasoning",
      "⑨ 非流式 output 与流式同一套 item 形状", j && j.output);
    ok(j && j.usage.output_tokens === 22 && j.incomplete_details === null, "⑨ 非流式 usage/收尾字段齐备", j && j.usage);
    ok(!/event:/.test(res.text), "⑨ 非流式响应里没有 SSE 帧", res.text.slice(0, 100));
  }

  // ===== ⑩ usage 兜底（上游一个 usage 都没发） =====
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
    const u = frameOf(parseSse(res.text), "response.completed").data.response.usage;
    ok(u.output_tokens > 0 && u.input_tokens > 0 && u.total_tokens === u.input_tokens + u.output_tokens,
      "⑩ 上游不发 usage 时用调度侧估算兜底，且三个数自洽（写 0 会让 Codex 的上下文统计失真）", u);
  }

  // ===== ⑪ 错误外壳 =====
  console.log("\n⑪ 端到端·错误外壳:");
  {
    const badKey = await post("/v1/responses", MSG(), bearer("sk-not-a-gateway-key"));
    let j = {};
    try { j = JSON.parse(badKey.text); } catch { /* 判红 */ }
    ok(badKey.status === 401 && j.error && j.error.message && j.error.type && "code" in j.error && "param" in j.error,
      "⑪ 鉴权失败回 OpenAI/Responses 的 error 外壳（四键齐备，Codex 按 error.type 分类）", [badKey.status, badKey.text.slice(0, 200)]);
    ok(j.error.code === "invalid_api_key", "⑪ 拒绝原因落在 error.code 里（只有一句话文案时用户无法自查）", j.error);

    const noInput = await post("/v1/responses", { model: MODEL }, bearer());
    ok(noInput.status === 400 && /input 不能为空/.test(noInput.text), "⑪ 归一失败按本协议外壳回 400", [noInput.status, noInput.text.slice(0, 160)]);

    const prev = await post("/v1/responses", MSG({ previous_response_id: "resp_9" }), bearer());
    ok(prev.status === 400 && /完整历史/.test(prev.text), "⑪ previous_response_id 的 400 说清怎么办", prev.text.slice(0, 160));

    TODAY_REQ = 99;
    const quota = await run({ picks: [], scripts: [[]], body: MSG(), headers: bearer(quotaKey.secret) });
    TODAY_REQ = 0;
    ok(quota.res.status === 429 && JSON.parse(quota.res.text).error.type === "rate_limit_exceeded",
      "⑪ 配额 429 的 type/code 落到 Responses 外壳里", [quota.res.status, quota.res.text.slice(0, 200)]);

    const unknown = await run({ picks: [], scripts: [[]], body: MSG({ model: "no-such-model-at-all" }) });
    ok(unknown.res.status === 400 && /不在任何渠道目录/.test(unknown.res.text), "⑪ 未知模型 400 且带可用模型提示", unknown.res.text.slice(0, 160));

    const chat = await run({
      url: "/v1/chat/completions", headers: bearer(), picks: [], scripts: [[]],
      body: { model: "no-such-model-at-all", messages: [{ role: "user", content: "hi" }] },
    });
    ok(chat.res.status === 400 && JSON.parse(chat.res.text).error.code === "model_not_found",
      "⑪ 打到 chat 端点的同一类拒绝仍是 chat 的 code（三条面互不串味）", chat.res.text.slice(0, 200));
  }

  // ===== ⑫ 流中失败：必须是一个 response.failed 帧 =====
  console.log("\n⑫ 端到端·流中失败:");
  {
    const { res } = await run({
      scripts: [[
        { emit: { type: "delta", delta: { content: "前半段" } }, },
        { emit: { type: "error", message: "上游中断", status: 502, code: 9 } },
        { return: { status: 200, planLimit: false } },
      ]],
      body: MSG(),
    });
    const f = parseSse(res.text);
    const failed = frameOf(f, "response.failed");
    ok(!!failed, "⑫ 已出线的流中失败下发成 response.failed（Codex 要看到终止事件才收流）", types(f));
    ok(failed && failed.data.response.status === "failed" && /前半段/.test(failed.data.response.output_text),
      "⑫ failed 帧里带上已产出的正文与 status=failed", failed && { status: failed.data.response.status, text: failed.data.response.output_text });
    ok(failed && !types(f).includes("response.completed"), "⑫ 失败轮不再补 completed（两个终止事件客户端会错乱）", types(f));
  }

  // ===== ⑬ 模型回退：注释帧之后不产生第二个 created，帧号不重号 =====
  console.log("\n⑬ 端到端·模型回退:");
  {
    adapters.modelOwners = (model) => (String(model) === MODEL ? ["trae"] : []);
    const { res } = await run({
      picks: ["acc1"], scripts: [SUCCESS],
      body: MSG({ model: "no-such-model" }),
      extraSettings: { modelFallback: { "no-such-model": MODEL } },
    });
    const f = parseSse(res.text);
    ok(res.status === 200 && types(f)[0] === "response.created", "⑬ 回退后仍正常出 Responses 事件流", [res.status, types(f)[0]]);
    ok(f.some((x) => x.event === "comment" && /fallback/.test(x.data.text)), "⑬ 回退明示走 SSE 注释帧，客户端忽略它", res.text.slice(0, 160));
    ok(types(f).filter((t) => t === "response.created").length === 1,
      "⑬ 注释帧把 response.created 提交到线上之后，重发尝试不再产生第二个 created（客户端必炸）", types(f));
    const seqs = f.map((x) => x.data.sequence_number).filter((n) => Number.isInteger(n));
    ok(seqs.every((n, i) => i === 0 || n > seqs[i - 1]), "⑬ 全程帧号不重号（resetAttempt 不能回收已发出的号）", seqs);
    ok(types(f)[types(f).length - 1] === "response.completed", "⑬ 回退轮照常以 completed 收束", types(f).slice(-1));
    adapters.modelOwners = defaultOwners;
  }

  // ===== ⑭ 止血开关 =====
  console.log("\n⑭ 端到端·止血开关:");
  {
    resetCase({ picks: ["acc1"], scripts: [SUCCESS], extraSettings: { enableResponses: false } });
    const off = await post("/v1/responses", MSG(), bearer());
    ok(off.status === 404 && JSON.parse(off.text).error.type === "not_found_error",
      "⑭ enableResponses=false 时端点直接 404（不必回滚代码、不必重新打包）", [off.status, off.text.slice(0, 160)]);

    const chat = await post("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true }, bearer());
    ok(chat.status === 200 && /data:/.test(chat.text), "⑭ 关掉 Responses 不影响 OpenAI 通路", [chat.status, chat.text.slice(0, 100)]);
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
