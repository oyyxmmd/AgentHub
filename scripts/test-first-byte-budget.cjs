// 首字节预算「首个 SSE 事件必须解除」的跨渠道守卫：node scripts/test-first-byte-budget.cjs
// 用 AGENTHUB_DATA_DIR 造临时库 + 假上游，不碰真实数据。
//
// 为什么单独一道闸：issue #107 的根因是「fetchStream 的首字节预算计时器只在 finally 清」，
// 计时器在整个流期间一直武装，到点 abort 掉 resp.body，把一条正常的长回答掐成
// 「HTTP 200 + 半截内容」——客户端与请求明细都显示 200，被读成「上游只回了这一点」。
// 该修复当时只落了 autoclaw 一个渠道，同形的 cline 与后来新增的自定义提供商
// （makeOpenaiCompat.chatOpenai）都漏掉了。这道闸守三件事：
//   ① 行为：真 fetchStream + 真 makeOpenaiCompat + 真假上游，首块后延迟 1200ms 的第二块必须到达；
//   ② 对照：同一装置下「不解除预算」必须真的断流（否则 ① 绿得没意义，装置空转）；
//   ③ 接线：全仓 fetchStream 调用点逐个锚点，防止将来又新增一条漏解除的路径。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-firstbyte-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

const adapters = require("../electron/backend/proxy/adapters.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${extra !== undefined ? ` → got ${JSON.stringify(extra)}` : ""}`); }
}
const enc = (o) => `data: ${JSON.stringify(o)}\n\n`;

// 真实值 30s，压到 400ms 让缺陷在毫秒级暴露（与 autoclaw 自测同一手法）
const SHORT_BUDGET_MS = 400;
const SECOND_CHUNK_DELAY_MS = 1200;

/** 假上游：首帧立即、第二帧延迟 1200ms。首帧后计时器若仍武装，400ms 就会掐断整条流 */
function fakeUpstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(enc({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "甲" } }] }));
      setTimeout(() => {
        res.write(enc({ id: "c", choices: [{ index: 0, delta: { content: "乙" }, finish_reason: "stop" }] }));
        res.write("data: [DONE]\n\n");
        res.end();
      }, SECOND_CHUNK_DELAY_MS);
    });
  });
  return server;
}

async function main() {
  const srv = fakeUpstream();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  try {
    // ===== ① 行为：自定义提供商的 chatOpenai 必须收全两段 =====
    console.log("① makeOpenaiCompat：首块后延迟的第二块仍到达（预算已被首事件解除）");
    const ad = adapters.makeOpenaiCompat(
      { id: "rel", kind: "openai_compat", baseUrl: base, models: [{ model: "m", upstream: "m" }], extraHeaders: {}, extraBody: {} },
      { firstByteBudgetMs: () => SHORT_BUDGET_MS }
    );
    const evs = [];
    let chatErr = null;
    let r = null;
    try {
      r = await ad.chat({
        secrets: { token: "sk-test" },
        model: "m",
        body: { model: "m", messages: [{ role: "user", content: "hi" }] },
        emit: (e) => evs.push(e),
      });
    } catch (e) { chatErr = e; }
    const text = evs.filter((e) => e.type === "delta").map((e) => (e.delta && e.delta.content) || "").join("");
    ok(!chatErr, `整条流未被中途掐断（实际错误：${chatErr && chatErr.message}）`);
    ok(r && r.status === 200, "上游 200 如实回传", r && r.status);
    ok(text === "甲乙", `两段正文都到达（预算解除后不该丢第二段，实际 "${text}"）`);
    ok(!evs.some((e) => e.type === "error"), "无流内错误帧");

    // ===== ② 对照：同一装置下不解除预算必须真的断流 =====
    // 没有这一段，① 的绿可能只是「装置压根没触发 abort」，那这道闸就是摆设
    console.log("② 对照：不解除预算的读取必须被掐断（证明装置真的能复现缺陷）");
    const { resp, cancelTimer } = await adapters.fetchStream(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }),
      firstByteMs: SHORT_BUDGET_MS,
    });
    let sawFirst = false;
    let readErr = null;
    let raw = "";
    try {
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += dec.decode(value, { stream: true });
        if (raw.includes("甲")) sawFirst = true;
        // 故意不 cancelTimer()：模拟修复前「只在 finally 清」的写法
      }
    } catch (e) { readErr = e; }
    cancelTimer();
    ok(sawFirst, "对照：首块确实读到了（说明断的是后段，不是一开始就失败）");
    ok(readErr, "对照：计时器到点后读取抛错（首字节预算在整个流期间武装的后果）");
    ok(!raw.includes("乙"), "对照：第二块确实没读到（缺陷现场复现成功）");

    // ===== ③ 接线：全仓 fetchStream 调用点逐个锚点 =====
    // 前两条证明「自定义提供商这条已修」，这条防「将来又新增一条漏解除的路径」。
    // 判据是「调用点所在文件里有首事件解除语句」，不是「文件里出现过 cancelTimer」——
    // 后者在 finally 里也成立，等于没判。计数式断言（而不是「存在即可」）才能让
    // 删掉其中任意一处也变红。
    console.log("③ 接线：每个 fetchStream 调用点都必须在首事件解除预算");
    const proxyDir = path.join(__dirname, "..", "electron", "backend", "proxy");
    const srcCache = new Map();
    const srcOf = (f) => {
      if (!srcCache.has(f)) srcCache.set(f, fs.readFileSync(path.join(proxyDir, f), "utf8"));
      return srcCache.get(f);
    };

    // 各渠道的调用点锚点（切不到即判红，防「整体看着改了」蒙过去）
    const callSites = [
      ["adapters.cjs", "await fetchStream(url, { method: \"POST\", headers, body: payload, firstByteMs: firstByteBudgetMs(payload) })"],
      ["adapters.cjs", "({ resp, cancelTimer } = await fetchStream(c.chatUrl"],
      ["adapters.cjs", "const { resp, cancelTimer } = await fetchStream(c.chatUrl, { method: \"POST\", headers, body: payload, firstByteMs: firstByteBudgetMs(payload) })"],
      ["adapters.cjs", "const { resp, cancelTimer } = await fetchStream(chatUrl, {"],
      ["adapters.cjs", "respPair = await fetchStream(url, { method: \"POST\", headers, body: payloadText, firstByteMs: firstByteBudgetMs(payloadText) });"],
      ["cline/adapter.cjs", "await fetchStream(`${base}/chat/completions`, {"],
      ["qoderAdapter.cjs", "await fetchStream(signed.url, {"],
      ["autoclaw/adapter.cjs", "await fetchStream(url, {"],
    ];
    for (const [file, callAnchor] of callSites) {
      ok(srcOf(file).includes(callAnchor), `${file} 的调用点锚点仍在（${callAnchor.slice(0, 44)}…）`);
    }

    // 首事件解除语句：计数式——删掉任意一处即数量不足
    const adSrc = srcOf("adapters.cjs");
    const settledCount = (adSrc.match(/if \(!settled\) \{/g) || []).length;
    // workbuddy×2（console 路径 / 另一条 chat 路径）+ raccoon + modelscope + lobster = 5
    ok(settledCount >= 5, `adapters.cjs 的 5 处内置渠道都带首事件解除（实际 ${settledCount} 处）`, settledCount);
    ok(adSrc.includes("if (!zcSettled) {"), "zcode 的首事件解除仍在（zcSettled 分支）");
    ok(adSrc.includes("settle();"), "自定义提供商（makeOpenaiCompat）的首事件解除仍在（settle()）");
    for (const f of ["cline/adapter.cjs", "qoderAdapter.cjs", "autoclaw/adapter.cjs"]) {
      ok(srcOf(f).includes("if (!settled) { settled = true; cancelTimer(); }"), `${f} 有首事件解除语句`);
    }

    // 反向：不许有「调用了 fetchStream 却整份文件没有解除语句」的文件（防新增渠道只抄调用不抄解除）
    const files = fs.readdirSync(proxyDir, { recursive: true })
      .filter((f) => String(f).endsWith(".cjs"))
      .map((f) => String(f).replace(/\\/g, "/"));
    for (const f of files) {
      if (f === "adapters.cjs") continue; // 上面已逐点断言过
      const src = srcOf(f);
      if (!src.includes("await fetchStream(")) continue;
      ok(/cancelTimer\(\)/.test(src), `${f} 调用了 fetchStream 且带解除语句`);
    }
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }

  console.log(`\n首字节预算守卫：${pass} 绿 / ${failed} 红`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
