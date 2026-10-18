// 入站协议转换的边界自测：node scripts/test-inbound-convert.cjs
// 纯函数，不出网、不碰数据库（两个 toInternal 都只吃请求体）。
//
// 这两层把 Claude Code / Codex CLI 的请求体翻译成网关的内部规范形（OpenAI chat body），
// 转换中「丢块」是设计里认下的语义损失，但**丢掉整条消息却留个空壳**不是：
// 上游对 {role:"user",content:""} 的容忍度不一致（部分直接 400），而空壳本来就不带信息。
// 另一类是顺序：Codex 并行工具调用会连续发多个 function_call，逐个成条会让 role:tool 的
// 消息夹在两条 assistant 之间，部分上游要求 tool 紧跟**同一条** assistant 的 tool_calls。
"use strict";

const anthropicIn = require("../electron/backend/proxy/protocols/anthropic-in.cjs");
const responsesIn = require("../electron/backend/proxy/protocols/responses-in.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${extra !== undefined ? ` → got ${JSON.stringify(extra).slice(0, 240)}` : ""}`); }
}
const roles = (msgs) => msgs.map((m) => m.role).join(",");

console.log("① /v1/messages：丢块之后不许留下空壳消息");
{
  // 纯 thinking 的 assistant 消息：signature 伪造不了，内容不回投 → 整条没有信息量
  const r1 = anthropicIn.toInternal({
    model: "m", max_tokens: 100,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "想一下", signature: "sig" }] },
      { role: "user", content: "继续" },
    ],
  });
  ok(r1.ok && roles(r1.body.messages) === "user,user", "纯 thinking 的 assistant 消息被跳过（不产出空消息）", r1.body.messages);
  ok(r1.notes.some((n) => /thinking\.signature/.test(n)), "同时留下「signature 不回投」的转换损失记录");

  // 纯 document 的 user 消息：无 OpenAI chat 对应物
  const r2 = anthropicIn.toInternal({
    model: "m", max_tokens: 100,
    messages: [
      { role: "user", content: [{ type: "document", source: { type: "base64", data: "x" } }] },
      { role: "user", content: "真正的问题" },
    ],
  });
  ok(r2.ok && roles(r2.body.messages) === "user", "纯 document 的 user 消息被跳过", r2.body.messages);

  // 空串 / 非字符串 content
  const r3 = anthropicIn.toInternal({
    model: "m", max_tokens: 100,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "assistant", content: null },
      { role: "user", content: "again" },
    ],
  });
  ok(r3.ok && roles(r3.body.messages) === "user,user", "空串 / null content 的消息被跳过", r3.body.messages);

  // 只有 tool_use 的 assistant 消息必须保留：tool_calls 是实质内容
  const r4 = anthropicIn.toInternal({
    model: "m", max_tokens: 100,
    messages: [
      { role: "user", content: "天气" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "get_weather", input: { city: "SH" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "晴" }] },
    ],
  });
  const asst4 = r4.body.messages.find((m) => m.role === "assistant");
  ok(!!asst4 && asst4.tool_calls.length === 1, "只有 tool_use 的 assistant 消息照常保留（不是空壳）", r4.body.messages);
  ok(asst4.tool_calls[0].function.arguments === '{"city":"SH"}', "input 序列化成 arguments JSON 串", asst4.tool_calls[0]);
  ok(r4.body.messages.some((m) => m.role === "tool" && m.tool_call_id === "tu1"), "tool_result 落成 role:tool 且带上 tool_call_id");

  // 正文与 tool_use 并存时正文不丢
  const r5 = anthropicIn.toInternal({
    model: "m", max_tokens: 100,
    messages: [{ role: "assistant", content: [{ type: "text", text: "我去查" }, { type: "tool_use", id: "tu2", name: "f", input: {} }] }],
  });
  const asst5 = r5.body.messages[0];
  ok(asst5.content === "我去查" && asst5.tool_calls.length === 1, "正文与 tool_use 并存时两者都留", asst5);

  // count_tokens：协议上不带 max_tokens，转换链不能因此整条跳过
  const ct1 = anthropicIn.countTokens({ model: "m", messages: [{ role: "user", content: "hello world" }] });
  const ct2 = anthropicIn.countTokens({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "hello world" }] });
  ok(ct1.input_tokens > 0, "count_tokens 给正数", ct1);
  ok(ct1.input_tokens === ct2.input_tokens, "缺 max_tokens 与带 max_tokens 走同一条转换链（口径一致）", [ct1, ct2]);
}

console.log("\n② /v1/responses：并行 function_call 必须合并到同一条 assistant");
{
  const r1 = responsesIn.toInternal({
    model: "m",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "两件事" }] },
      { type: "function_call", call_id: "c1", name: "f1", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "f2", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "r1" },
      { type: "function_call_output", call_id: "c2", output: "r2" },
    ],
  });
  const asst = r1.body.messages.filter((m) => m.role === "assistant");
  ok(asst.length === 1, "两个连续的 function_call 合成一条 assistant 消息（不是两条）", asst);
  ok(asst[0] && asst[0].tool_calls.length === 2, "两条 tool_calls 都在同一条消息上", asst[0]);
  ok(asst[0].tool_calls.map((t) => t.id).join(",") === "c1,c2", "call_id 保真且保持顺序（下一轮靠它关联 output）", asst[0] && asst[0].tool_calls);
  ok(roles(r1.body.messages) === "user,assistant,tool,tool", "合并后 tool 消息紧跟那一条 assistant", roles(r1.body.messages));

  // 交替形态（一次调用一次结果）：本来就不相邻，不许被合并
  const r2 = responsesIn.toInternal({
    model: "m",
    input: [
      { type: "function_call", call_id: "c1", name: "f1", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "r1" },
      { type: "function_call", call_id: "c2", name: "f2", arguments: "{}" },
      { type: "function_call_output", call_id: "c2", output: "r2" },
    ],
  });
  ok(r2.body.messages.filter((m) => m.role === "assistant").length === 2, "交替的 call/output 形态保持两条（tool 各自紧跟）", roles(r2.body.messages));

  // 带正文的 assistant 消息不许被合并：那是实质输出，合并会改语义
  const r3 = responsesIn.toInternal({
    model: "m",
    input: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "我先说" }] },
      { type: "function_call", call_id: "c1", name: "f1", arguments: "{}" },
    ],
  });
  ok(r3.body.messages.filter((m) => m.role === "assistant").length === 2, "带正文的 assistant 消息不被合并（合并会改语义）", r3.body.messages);

  // 历史里的 reasoning item 丢弃（思考不回投），且不留空壳
  const r4 = responsesIn.toInternal({
    model: "m",
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "reasoning", id: "rs1", summary: [] },
    ],
  });
  ok(r4.ok && roles(r4.body.messages) === "user", "历史里的 reasoning item 丢弃且不留空壳", r4.body.messages);
  ok(r4.notes.some((n) => /reasoning item 已丢弃/.test(n)), "同时留下转换损失记录");

  // 端到端：合并后的 body 必须能过网关的请求体校验
  const util = require("../electron/backend/proxy/util.cjs");
  ok(!util.validateChatBody(r1.body), "合并后的 body 通过网关请求体校验", util.validateChatBody(r1.body));
}

console.log(`\n入站转换边界自测：${pass} 绿 / ${failed} 红`);
process.exit(failed ? 1 : 0);
