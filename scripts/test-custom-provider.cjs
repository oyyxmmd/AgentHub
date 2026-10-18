// 自定义模型提供商自测：node scripts/test-custom-provider.cjs
// 用 AGENTHUB_DATA_DIR 造临时库 + 假上游 + 测试端口，不碰真实数据、不碰用户自己的 9527。
//
// 这份闸守的是「用户自己加一个上游」这件事里最容易静默错的几条：
//   ① 校验只在写入侧做一次（两处拼接口径迟早漂）；
//   ② 提供商的模型**只以 slug/model 出现在目录里**，绝不出现裸名——否则一条自建条目就能
//      在 /v1/models 里顶掉内置池的同名模型；
//   ③ 裸名兜底必须「内置优先 + 歧义不猜」；
//   ④ 改完配置不必重启（动态适配器实例缓存以 updated_at 为键）；
//   ⑤ 提供商是 API Key 直连：没有余额概念，三条额度刷新入口都得跳过它；
//   ⑥ 探测不动号池状态（不打冷却、不记流水、不动 lastUsed）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-provider-"));
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

const store = require("../electron/backend/proxy/store.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");
const server = require("../electron/backend/proxy/server.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const credits = require("../electron/backend/proxy/credits.cjs");
const provider = require("../electron/backend/proxy/provider.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${extra !== undefined ? ` → got ${JSON.stringify(extra)}` : ""}`); }
}
const GW = 19581;
const UP = 19582;   // 提供商一号假上游
const UP2 = 19583;  // 换地址用的二号假上游（验「不必重启」）

// ===== ① 校验层（纯函数，不出网） =====
console.log("① base_url 归一：写入侧就存成规范值");
{
  const cases = [
    ["https://a.one/api/openai/v1", "https://a.one/api/openai"],
    ["https://a.one/api/openai/v1/", "https://a.one/api/openai"],
    ["https://a.one/v1/chat/completions", "https://a.one"],
    ["https://a.one/api/openai/v1/v1", "https://a.one/api/openai"], // 剥到不动为止
    ["https://a.one/chat/completions", "https://a.one/chat/completions"], // 完整端点形态：不剥
  ];
  for (const [raw, want] of cases) {
    const r = provider.normalizeBaseUrl(raw);
    ok(r.ok && r.url === want, `归一 ${raw} → ${want}`, r);
  }
  ok(provider.normalizeBaseUrl("").ok === false, "空地址直接拒");
  ok(provider.normalizeBaseUrl("a.one/v1").ok === false, "缺协议的写法拒掉（不猜成 https）");
  ok(provider.normalizeBaseUrl("ftp://a.one").ok === false, "只支持 http(s)");
  ok(/Key 栏/.test(provider.normalizeBaseUrl("https://u:p@a.one/v1").message || ""), "带账号信息被拒且指向 Key 栏");
  ok(provider.normalizeBaseUrl("https://a.one/v1?sk=1").ok === false, "带查询串被拒");
  ok(provider.normalizeBaseUrl("https://a.one/v1#x").ok === false, "带锚点被拒");
  ok(provider.normalizeBaseUrl("https://a.one/v1").domain === "a.one", "domain 取 hostname（号池展示要用）");
}

console.log("\n② 模型清单 / 别名 / 档位 / 自定义头与 body");
{
  const r = provider.normalizeModels("gpt-x, gpt-y\ngpt-x");
  ok(r.ok && r.models.length === 2, "逗号与换行都算分隔，重复名按大小写不敏感去重", r.models);
  ok(r.models[0].upstream === "gpt-x", "没写 upstream 的条目 = 客户端名同名透传", r.models[0]);
  ok(provider.normalizeModels([{ model: "a/b" }]).ok === false, "模型名含 / 直接拒：斜杠是 provider/model 的分隔符");

  const al = provider.normalizeModels([{ model: "glm", aliases: ["gpt-5", "gpt-6"] }]);
  ok(al.ok && JSON.stringify(al.models[0].aliases) === '["gpt-5","gpt-6"]', "别名按序收下", al.models[0]);
  ok(provider.normalizeModels([{ model: "a", aliases: ["b", "b"] }]).ok === false, "同一个模型里写两遍同一个别名 → 拒（号池里两条一样的名字说不清该映射到哪个真名）");
  ok(provider.normalizeModels([{ model: "a" }, { model: "b", aliases: ["a"] }]).ok === false, "别名撞本提供商的另一个模型名 → 拒（撞了两个名字说不清映射到哪个真名）");
  ok(provider.normalizeModels([{ model: "a", aliases: ["x/y"] }]).ok === false, "别名同样不许含 /");
  const many = provider.normalizeModels([{ model: "a", aliases: Array.from({ length: 9 }, (_, i) => `k${i}`) }]);
  ok(many.ok === false && /8/.test(many.message || ""), "别名数量有上限（8）", many);

  const rs = provider.normalizeModels([{ model: "a", reasoning: { supportedEfforts: ["low", "bogus", "high"], defaultEffort: "medium" } }]);
  ok(rs.ok && JSON.stringify(rs.models[0].reasoning.supportedEfforts) === '["low","high"]', "非法档位名被滤掉（词表只有 util.EFFORT_LEVELS 一份出处）", rs.models[0].reasoning);
  ok(!("defaultEffort" in rs.models[0].reasoning), "「默认但选不到」的档位丢掉，不留一个界面点不出来的默认值", rs.models[0].reasoning);

  ok(provider.normalizeModels([{ model: "a", unknownField: 1 }]).ok && !("unknownField" in provider.normalizeModels([{ model: "a", unknownField: 1 }]).models[0]), "白名单之外的键一律丢掉：留着只会让人以为生效了");

  // 模型名与别名必须各记一份集合：合成一个时，后一个模型的**名字**恰好等于前一个模型的
  // **别名**会被去重分支静默吃掉（条目消失、没有任何提示），用户只看到「配了却没生效」
  const nameHitsAlias = provider.normalizeModels([{ model: "glm", aliases: ["glm-air"] }, { model: "glm-air" }]);
  ok(nameHitsAlias.ok === false && /别名/.test(nameHitsAlias.message || ""), "模型名撞前面某条目的别名 → 拒（不静默丢条目）", nameHitsAlias);
  ok(provider.normalizeModels([{ model: "glm", aliases: ["glm-air"] }, { model: "GLM" }]).ok === true, "同一个模型写两遍（大小写不同）仍是宽容去重，不是错误");
  ok(provider.normalizeModels([{ model: "glm", aliases: ["glm-air"] }, { model: "glm-air-2" }]).ok === true, "只是前缀相同不算撞车（判据是整体相等，不是包含）");
}
{
  const base = { id: "rel1", baseUrl: `http://127.0.0.1:${UP}/v1`, models: ["gpt-x"] };
  const bad = provider.create({ ...base, extraHeaders: { Authorization: "Bearer sk-evil" } });
  ok(bad.ok === false && /鉴权头/.test(bad.message || ""), "不许自定义鉴权头（那等于绕过 Key 轮转与记账）", bad);
  const bad2 = provider.create({ ...base, extraHeaders: { Host: "elsewhere" } });
  ok(bad2.ok === false, "Host 也在拒列里（否则能把请求挪到别的机器）", bad2);
  const bad3 = provider.create({ ...base, extraBody: { stream: false } });
  ok(bad3.ok === false && /stream/.test(bad3.message || ""), "extra_body 不许覆盖 stream（出站恒流式是网关的口径）", bad3);
  for (const k of ["model", "messages", "prompt"]) {
    ok(provider.create({ ...base, extraBody: { [k]: 1 } }).ok === false, `extra_body 不许覆盖 ${k}`);
  }
  const badKind = provider.create({ ...base, kind: "grpc" });
  ok(badKind.ok === false && /协议形态/.test(badKind.message || ""), "认不出的协议形态被拒（而不是静默按缺省存）", badKind);
  provider.remove("rel1");
}

console.log("\n③ 标识规矩与防遮蔽");
{
  const base = { baseUrl: `http://127.0.0.1:${UP}/v1`, models: ["gpt-x"] };
  for (const id of ["A", "1", "-x", "x".repeat(33), "with space", "a/b"]) {
    ok(provider.create({ ...base, id }).ok === false, `标识 "${id}" 不合法（2~32 位小写字母数字 - _）`);
  }
  ok(provider.create({ ...base, id: "trae" }).ok === false, "内置渠道 id 不许占用");
  ok(provider.create({ ...base, id: "v1" }).ok === false, "保留名 v1 不许占用（会让 /v1/models 解析歧义）");
  ok(provider.create({ ...base, id: "auto" }).ok === false, "保留名 auto 不许占用");

  // 目录里已有 `kimi/k2` 这条内置模型时，slug=kimi 会让它的 id 与提供商前缀无法区分
  const file = path.join(rules.rulesDir(), "catalog.json");
  fs.writeFileSync(file, JSON.stringify({ trae: { syncedAt: 1, models: [{ id: "kimi/k2" }] } }), "utf8");
  rules.reload("catalog.json");
  const clash = provider.create({ ...base, id: "kimi" });
  ok(clash.ok === false && /冲突/.test(clash.message || ""), "slug 撞模型目录里某条 id 的首段 → 拒（否则该提供商的模型一条都列不出来）", clash);
  fs.writeFileSync(file, JSON.stringify({}), "utf8");
  rules.reload("catalog.json");

  const dup = provider.create({ ...base, id: "rel2" });
  ok(dup.ok === true, "合法条目建得起来", dup);
  ok(provider.create({ ...base, id: "rel2" }).ok === false, "同标识二次 create 被拒");
  const upd = provider.update("rel2", { id: "rel3" });
  ok(upd.ok === false && /不可修改/.test(upd.message || ""), "标识创建后不可改（accounts.channel 以它为键）", upd);
  const off = provider.update("rel2", { enabled: false });
  ok(off.ok && off.provider.enabled === false, "停用存得住");
  ok(off.provider.baseUrl === `http://127.0.0.1:${UP}`, "整体覆盖语义：没传的字段沿用已有值（尾 /v1 已被剥掉）", off.provider.baseUrl);
  ok(provider.update("nosuch", {}).ok === false, "改不存在的条目如实回错");
}

console.log("\n④ Key 管理");
{
  const p = provider.create({ id: "relkey", display: "带号的", baseUrl: `http://127.0.0.1:${UP}/v1`, models: ["gpt-x"] });
  ok(p.ok === true, "建提供商", p);
  const k1 = provider.addKey("relkey", { key: "sk-aaa" });
  ok(k1.ok === true, "加一把 Key", k1);
  ok(provider.addKey("relkey", { key: "" }).ok === false, "空 Key 被拒");
  ok(provider.addKey("relkey", { key: "sk-aaa" }).ok === false, "同一把 Key 重复粘贴被拒（号池里两把一样的会让轮转把配额算成两倍）");
  ok(provider.addKey("nosuch", { key: "sk-zzz" }).ok === false, "不存在的提供商不加 Key");
  const row = store.accountRows("relkey").find((r) => r.id === k1.id);
  ok(row && row.name === "Key 1", "没填名字的 Key 自动编号", row && row.name);
  const li = provider.list().find((x) => x.id === "relkey");
  ok(li && li.keyCount === 1 && li.onlineCount === 1, "list() 带 keyCount/onlineCount（管理页要显示）", li);
  ok(
    Array.isArray(li.keys) && li.keys.length === 1 && !("token_enc" in li.keys[0]) && !JSON.stringify(li.keys).includes("sk-aaa"),
    "list() 的 keys 是脱敏视图：既不含密文信封也不含明文 Key（「Key 管理」弹窗只要运行态）",
    li.keys && Object.keys(li.keys[0]).filter((k) => /token|key/i.test(k)),
  );
  ok(provider.removeKey("not-an-account").ok === false, "账号不存在时如实回错");
  const builtinAcc = store.addAccount({ channel: "trae", name: "内置号", token: "sk-builtin" });
  ok(provider.removeKey(builtinAcc).ok === false, "内置渠道的账号不许从提供商入口删（不属于任何提供商）");
  store.removeAccount(builtinAcc); // 立刻清掉：留着它，⑨ 的全量刷新会拿它去打真实上游
  ok(provider.removeKey(k1.id).ok === true, "提供商的 Key 能删");
  provider.remove("relkey");
}

// ===== 假上游 =====
function fakeUpstream(port, opts) {
  const o = opts || {};
  const seen = [];
  const modelsSeen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url || "";
      if (url.endsWith("/models")) {
        modelsSeen.push(String(req.headers.authorization || ""));
        if (o.noModelsEndpoint) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "up-1" }, { id: "up-2" }, { model: "up-3" }] }));
        return;
      }
      const b = JSON.parse(raw || "{}");
      seen.push({ path: url, auth: String(req.headers.authorization || ""), xkey: String(req.headers["x-a"] || ""), model: b.model, stream: b.stream, body: b });
      const ch = (d, f, u) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: b.model, choices: [{ index: 0, delta: d, finish_reason: f || null }], ...(u ? { usage: u } : {}) })}\n\n`;
      // 整包回 JSON 的两种形态（正常应答 / 把欠费写成错误体）：内容类型必须在 writeHead 一次定下，
      // 先 writeHead 再 setHeader 会抛 ERR_HTTP_HEADERS_SENT 把假上游打穿
      if (b.model === "whole" || b.model === "owe") {
        res.writeHead(200, { "content-type": "application/json" });
        if (b.model === "owe") { res.end(JSON.stringify({ error: { message: "余额不足，请充值" } })); return; }
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "整包应答" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (b.model === "nousage") { res.end(ch({ content: "一二三四".repeat(8) }, "stop") + "data: [DONE]\n\n"); return; }
      res.end(ch({ role: "assistant", content: "" }, null) + ch({ content: "你好" }, null) + ch({ content: "，世界" }, "stop", { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }) + "data: [DONE]\n\n");
    });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r({ srv, seen, modelsSeen })));
}

function parseSse(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        const s = line.slice(5).trim();
        if (s === "[DONE]") continue;
        try { out.push(JSON.parse(s)); } catch { /* 非 JSON 帧交给别的断言判 */ }
      }
    }
  }
  return out;
}

let GWKEY = { secret: "" };
// 裸名兜底开关：settings 是每次请求重读的闭包，翻转这个变量即等价于用户在配置里改了一档
let BARE_ON = true;
function chat(body, keyOrNone) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      // agent:false —— 网关重启/换绑后复用同一 host:port 的旧 socket 会直接 ECONNRESET（闸自己的基础设施坑）
      { host: "127.0.0.1", port: GW, path: "/v1/chat/completions", method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + (keyOrNone === undefined ? GWKEY.secret : keyOrNone) }, agent: false },
      (res) => {
        let t = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode, text: t, ctype: res.headers["content-type"] || "" }));
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error("请求 /v1/chat/completions 15s 无响应")));
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}
function listModels() {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: GW, path: "/v1/models", headers: { authorization: "Bearer " + GWKEY.secret }, agent: false }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (t += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(t || "{}") }); } catch (e) { reject(e); } });
    }).on("error", reject).setTimeout(15000, function () { this.destroy(new Error("请求 /v1/models 15s 无响应")); });
  });
}

(async () => {
  const up = await fakeUpstream(UP);
  const up2 = await fakeUpstream(UP2);
  store.open();
  GWKEY = store.createKey({ name: "provider-e2e", route: "auto" });

  // ===== ⑤ 模型名解析（纯函数层） =====
  console.log("\n⑤ 模型名解析：前缀直达 / 裸名兜底");
  {
    provider.create({ id: "p1", baseUrl: `http://127.0.0.1:${UP}/v1`, models: [{ model: "gpt-x", upstream: "glm-4.7", aliases: ["gpt-y"] }], extraHeaders: { "x-a": "relay-tag" } });
    provider.addKey("p1", { key: "sk-aaa" });
    provider.create({ id: "p2", baseUrl: `http://127.0.0.1:${UP}/v1`, models: ["gpt-x"] });
    provider.addKey("p2", { key: "sk-aaa" });
    ok(provider.parseModelRef("p1/gpt-x") === "p1", "slug/model → 该提供商");
    ok(provider.parseModelRef("gpt-x") === null, "裸名不走前缀解析");
    ok(provider.parseModelRef("/gpt-x") === null, "首段为空不算前缀");
    ok(provider.parseModelRef("p1/") === null, "尾段为空不算前缀");
    ok(provider.parseModelRef("google/gemini-3") === null, "内置生态里带斜杠的模型 id 不被误判成提供商（判据是首段命中提供商）");
    ok(provider.parseModelRef("off/gpt-x") === null, "停用中的提供商不接受前缀路由");
    provider.create({ id: "off", baseUrl: `http://127.0.0.1:${UP}/v1`, models: ["z-model"] }).provider;
    provider.update("off", { enabled: false });
    ok(provider.parseModelRef("off/z-model") === null, "停用后前缀彻底失效（不能被选中）");

    // 内置优先：拿目录里真实存在的一条内置裸名当探针（不硬编码模型名——目录改名时这条判据不该跟着漂）
    const builtinName = adapters.mergedModels().map((m) => m.id).find((id) => !id.includes("/") && adapters.modelOwners(id).length);
    ok(!!builtinName, "夹具前提：内置目录里确实有可被认领的裸名", builtinName);
    provider.create({ id: "p3", baseUrl: `http://127.0.0.1:${UP}/v1`, models: [builtinName] });
    ok(provider.findUniqueByBareModel(builtinName) === null, "有内置归属的裸名绝不落到提供商（静默遮蔽就是这么来的）", builtinName);
    ok(provider.findUniqueByBareModel("gpt-x") === null, "两个提供商都有 gpt-x → 歧义不猜");
    ok(provider.findUniqueByBareModel("gpt-y") === "p1", "别名同等参与裸名兜底（唯一命中才给）");
    ok(provider.findUniqueByBareModel("p1/gpt-x") === null, "带前缀的写法不走兜底");
    provider.remove("p3");
  }

  const sr = await server.start(() => ({
    port: GW, bind: "127.0.0.1", rateLimitPerMin: 0, concurrency: 8, routeStrategy: "auto",
    fixedChannel: "trae", modelOverrides: {}, debugStatus: false, humanizeJitter: false,
    allowBareProviderModel: BARE_ON,
  }));
  ok(sr.ok === true && sr.port === GW, "网关在测试端口起来", sr);

  // ===== ⑥ 端到端路由 =====
  console.log("\n⑥ 端到端：前缀请求打到该提供商，并把上游真名换掉");
  {
    up.seen.length = 0;
    const a = await chat({ model: "p1/gpt-x", messages: [{ role: "user", content: "hi" }], stream: true });
    const frames = parseSse(a.text);
    ok(a.status === 200 && frames.map((f) => (f.choices && f.choices[0].delta.content) || "").join("") === "你好，世界", "前缀请求拿到完整正文", [a.status, a.text.slice(0, 160)]);
    ok(up.seen[up.seen.length - 1].model === "glm-4.7", "上游收到的是条目里配的**真名**（不是客户端名）", up.seen[up.seen.length - 1]);
    ok(up.seen[up.seen.length - 1].auth === "Bearer sk-aaa", "鉴权头由网关按号池的 Key 生成", up.seen[up.seen.length - 1].auth);
    ok(up.seen[up.seen.length - 1].xkey === "relay-tag", "提供商自定义的额外请求头真的落到上游（丢了它就只是界面上一行字）", up.seen[up.seen.length - 1].xkey);
    ok(up.seen[up.seen.length - 1].body.stream === true && up.seen[up.seen.length - 1].body.stream_options.include_usage === true, "出站恒流式并索取 usage");
    ok(!("extraBody" in up.seen[up.seen.length - 1].body), "内部载体不外泄：上游收到的请求里没有字面 extraBody 键", Object.keys(up.seen[up.seen.length - 1].body));

    const al = await chat({ model: "p1/gpt-y", messages: [{ role: "user", content: "hi" }], stream: true });
    ok(al.status === 200 && up.seen[up.seen.length - 1].model === "glm-4.7", "别名入口同样映射到真名", up.seen[up.seen.length - 1]);

    const out = await chat({ model: "p1/not-in-list", messages: [{ role: "user", content: "hi" }], stream: true });
    ok(out.status === 200 && up.seen[up.seen.length - 1].model === "not-in-list", "目录外模型原样透传（用户显式点名了提供商，中转站能力常领先于清单）", up.seen[up.seen.length - 1]);

    const nonstream = await chat({ model: "p1/gpt-x", messages: [{ role: "user", content: "hi" }] });
    const j = JSON.parse(nonstream.text || "{}");
    ok(nonstream.status === 200 && j.choices[0].message.content === "你好，世界" && j.usage.total_tokens === 33, "非流式由本地聚合出同一条回答", [nonstream.status, nonstream.text.slice(0, 200)]);

    const whole = await chat({ model: "p1/whole", messages: [{ role: "user", content: "hi" }], stream: true });
    ok(whole.status === 200 && /整包应答/.test(whole.text) && /"completion_tokens":4/.test(whole.text), "上游无视 stream:true 整包回 JSON 时不静默变空", [whole.status, whole.text.slice(0, 200)]);

    const nu = await chat({ model: "p1/nousage", messages: [{ role: "user", content: "hi" }], stream: true });
    const nuRow = store.recentRequests(5).find((x) => /nousage/.test(String(x.model)));
    ok(nu.status === 200 && /一二三四/.test(nu.text), "上游不发 usage 时正文照送", [nu.status, nu.text.slice(-160)]);
    ok(nuRow && nuRow.completionTokens > 0, "上游不发 usage 时流水里是估算值而不是 0", nuRow && nuRow.completionTokens);
  }

  console.log("\n⑦ /v1/models：只列 slug/model，不列裸名与别名");
  {
    const m = await listModels();
    const ids = (m.body.data || []).map((x) => x.id);
    ok(m.status === 200 && ids.includes("p1/gpt-x"), "提供商模型以前缀名出现在目录里", ids.slice(0, 8));
    ok(!ids.includes("gpt-x"), "绝不列出裸名（一条自建条目不能顶掉内置池的同名模型）", ids.filter((x) => x === "gpt-x"));
    ok(!ids.includes("p1/gpt-y"), "别名不进目录（它只是多一个入口，不是新模型）");
    const e = (m.body.data || []).find((x) => x.id === "p1/gpt-x");
    ok(e && e.owned_by === "p1", "条目归属该提供商", e);
  }

  console.log("\n⑧ 换地址不必重启：动态适配器实例缓存以 updated_at 为键");
  {
    provider.update("p1", { baseUrl: `http://127.0.0.1:${UP2}/v1` });
    up2.seen.length = 0;
    const b = await chat({ model: "p1/gpt-x", messages: [{ role: "user", content: "hi" }], stream: true });
    ok(b.status === 200 && up2.seen.length >= 1, "改完 base_url 立刻打到新地址（旧实例不回收就还在打旧端口）", [b.status, up2.seen.length]);
  }

  console.log("\n⑨ 提供商没有余额概念：三条额度刷新入口都跳过它");
  {
    const accId = store.accountRows("p1")[0].id;
    let threw = "";
    try { await credits.refreshAccount(accId); } catch (e) { threw = String(e.message || e); }
    ok(/API Key 直连/.test(threw), "单账号刷新如实拒（不拿第三方 Key 打一个不存在的余额接口）", threw);
    const rc = await credits.refreshChannel("p1");
    ok(rc && rc.ok === false && /API Key 直连/.test(rc.message || ""), "单渠道刷新同样拒", rc);
    const all = await credits.refreshAll();
    ok(all && (all.ok === true || Array.isArray(all.results) || all.message), "定时全量刷新不崩（提供商账号被过滤掉）", all);
  }

  console.log("\n⑩ 探测：走真上游但不动产号池");
  {
    const acc = store.accountRows("p1")[0];
    const beforeCool = acc.cool_until;
    const beforeUsage = store.recentRequests(50).length;
    const p = await provider.probe({ id: "p1", accountId: acc.id, baseUrl: `http://127.0.0.1:${UP2}/v1`, model: "gpt-x" });
    ok(p.ok === true && /你好/.test(p.sample || ""), "从号池挑一把 Key 就能探（明文不过渲染层）", p);
    // 别名也是清单里的入口：探测必须与真实请求共用同一张映射表，
    // 否则"探测失败但真实请求成功"会把用户引向改错方向。判据落在"上游确实收到新一次请求、
    // 且收到的是真名"——只断 ok 或只看最后一条 seen 都可能在"根本没出网"时假绿
    const seenBefore = up2.seen.length;
    await provider.probe({ id: "p1", accountId: acc.id, baseUrl: `http://127.0.0.1:${UP2}/v1`, model: "gpt-y" });
    ok(up2.seen.length === seenBefore + 1 && up2.seen[seenBefore].model === "glm-4.7", "拿别名探测同样命中清单，且上游收到的是条目里配的真名", up2.seen[seenBefore]);
    ok(store.accountRows("p1")[0].cool_until === beforeCool, "探测失败与否都不把号打进冷却", store.accountRows("p1")[0].cool_until);
    ok(store.recentRequests(50).length === beforeUsage, "探测不写流水（它是配置动作，不是用户的一次请求）");
    const badKey = await provider.probe({ baseUrl: `http://127.0.0.1:${UP2}/v1`, model: "gpt-x", key: "" });
    ok(badKey.ok === false && /Key/.test(badKey.message || ""), "没 Key 时说得清缺什么", badKey);
    const noModel = await provider.probe({ baseUrl: `http://127.0.0.1:${UP2}/v1`, key: "sk-aaa" });
    ok(noModel.ok === false && /模型名/.test(noModel.message || ""), "没填模型名时同样是人话", noModel);
    const badBase = await provider.probe({ baseUrl: "not-a-url", key: "sk-aaa", model: "gpt-x" });
    ok(badBase.ok === false, "地址非法时探测直接拒，不出网");
    const unknownKind = await provider.probe({ baseUrl: `http://127.0.0.1:${UP2}/v1`, key: "sk-aaa", model: "gpt-x", kind: "grpc" });
    ok(unknownKind.ok === true, "认不出的 kind 探测按缺省形态试（保存侧的 validate 才是拒人的地方）", unknownKind);
  }

  console.log("\n⑪ 拉模型目录");
  {
    // p1 的地址在 ⑧ 已被改到 UP2，这里断言的自然是那一个新地址收到的头
    up2.modelsSeen.length = 0;
    // p1 的地址在 ⑧ 已被改到 UP2，这里断言的自然是那一个新地址收到的头
    up2.modelsSeen.length = 0;
    const r = await provider.fetchModels("p1");
    ok(r.ok === true && JSON.stringify(r.models) === '["up-1","up-2","up-3"]', "GET /v1/models 的三种字段名都认（id/model/name）", r);
    ok(up2.modelsSeen[up2.modelsSeen.length - 1] === "Bearer sk-aaa", "拉目录用的是号池里那把 Key（空 bearer 会被上游报成鉴权失败，用户看到的是假故障）", up2.modelsSeen);
    const none = await provider.fetchModels("nosuch");
    ok(none.ok === false && /不存在/.test(none.message || ""), "不存在的提供商说得清", none);
    provider.create({ id: "nom", baseUrl: `http://127.0.0.1:${UP}/v1`, models: [] });
    const noKey = await provider.fetchModels("nom");
    ok(noKey.ok === false && /Key/.test(noKey.message || ""), "一把 Key 都没有时说得清要先加 Key", noKey);
    // 上游没开模型目录接口（404）：文案必须指向「手填」，否则用户只会对着一个 HTTP 404 猜下一步
    const four = http.createServer((req, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); });
    await new Promise((r) => four.listen(19584, "127.0.0.1", r));
    provider.create({ id: "nomod", baseUrl: "http://127.0.0.1:19584/v1", models: [] });
    provider.addKey("nomod", { key: "sk-nomod" });
    const noCat = await provider.fetchModels("nomod");
    ok(noCat.ok === false && /手填/.test(noCat.message || ""), "上游没有 /v1/models 时引导手填（不替上游预判并拒掉有能力的那批）", noCat);
    four.close();
    provider.remove("nomod");
  }

  console.log("\n⑫ 402（欠费）走既有的换号链路");
  {
    provider.create({ id: "owep", baseUrl: `http://127.0.0.1:${UP}/v1`, models: ["owe"] });
    provider.addKey("owep", { key: "sk-owe1" });
    const r = await chat({ model: "owep/owe", messages: [{ role: "user", content: "hi" }], stream: true });
    const row = store.recentRequests(10).find((x) => /owe/.test(String(x.model)));
    // 判据落在「流里有 error 对象」而不是上游那句文案：头已提交，状态码改不动，错误只能按流内下发；
    // 文案此刻已被网关换成自己的聚合措辞，钉原文等于钉一条随时会改的字符串
    ok(/"error"\s*:\s*\{/.test(r.text), "欠费错误以流内 error 对象到达客户端（不是静默的空回答）", r.text.slice(-200));
    ok(row && row.status === 402, "流水记的是 402 而不是 200/502：只有 402 会走「切号 + planLimit」这条既有链路", row && [row.model, row.status, row.error]);
    ok(store.accountRows("owep")[0].cool_until > 0, "欠费的那把 Key 进了冷却（不冷却就等于当好 Key 反复打）", store.accountRows("owep")[0].cool_until);
    // 正对照：同一条判据对正常应答必须为假，否则上面那条是恒真断言
    const healthy = await chat({ model: "p1/gpt-x", messages: [{ role: "user", content: "hi" }], stream: true });
    ok(!/"error"\s*:\s*\{/.test(healthy.text), "正常应答的流里没有 error 对象（上一条判据不是恒真）", healthy.text.slice(-120));
    provider.remove("owep");
  }

  console.log("\n⑬ 裸名兜底的端到端：默认放开、歧义不猜、开关真接线");
  {
    provider.create({ id: "bare", baseUrl: `http://127.0.0.1:${UP}/v1`, models: ["solo-x"] });
    provider.addKey("bare", { key: "sk-bare" });
    up.seen.length = 0;
    const b = await chat({ model: "solo-x", messages: [{ role: "user", content: "hi" }], stream: true });
    const btext = parseSse(b.text).map((f) => (f.choices && f.choices[0].delta.content) || "").join("");
    ok(b.status === 200 && btext === "你好，世界" && up.seen[up.seen.length - 1].auth === "Bearer sk-bare",
      "不带前缀的模型名唯一命中某提供商时照样打到它（多数客户端的配置里填不进前缀，这才是默认路径）",
      [b.status, btext, up.seen[up.seen.length - 1] && up.seen[up.seen.length - 1].auth]);

    provider.create({ id: "bare2", baseUrl: `http://127.0.0.1:${UP}/v1`, models: ["solo-x"] });
    provider.addKey("bare2", { key: "sk-bare2" });
    const amb = await chat({ model: "solo-x", messages: [{ role: "user", content: "hi" }], stream: true });
    ok(amb.status === 400, "两个提供商都有同名裸名 → 拒得干脆，不随机挑一个（静默换了供应商比报错难查得多）", [amb.status, amb.text.slice(0, 160)]);
    const pfx = await chat({ model: "bare/solo-x", messages: [{ role: "user", content: "hi" }], stream: true });
    ok(pfx.status === 200, "歧义只关裸名这一条通路：带前缀的写法照常可用", [pfx.status, pfx.text.slice(0, 120)]);
    provider.remove("bare2");

    BARE_ON = false;
    const off = await chat({ model: "solo-x", messages: [{ role: "user", content: "hi" }], stream: true });
    ok(off.status === 400, "配置关掉兜底后裸名不再落到提供商（开关不是摆设）", [off.status, off.text.slice(0, 160)]);
    BARE_ON = true;
    provider.remove("bare");
  }

  provider.remove("p1");
  provider.remove("p2");
  provider.remove("off");
  provider.remove("rel2");
  provider.remove("nom");
  ok(store.listProviders().length === 0, "清理后没有残留提供商", store.listProviders().map((x) => x.id));
  ok(store.channelList().every((c) => c.kind === "builtin"), "提供商删干净后路由视图回到内置集合", store.channelList().map((c) => c.id));

  // ===== 补充·上游错误分类：限流与欠费必须分开 =====
  // 原来只按裸 "quota" 判 402，把 "rate limit quota exceeded" 这类限流也算成欠费 →
  // planLimit → pool.coolAccount("credit") 把账号冷却到次日 04:00。一个只是被限流的好号
  // 被按「没余额」静默跳过一整天，池子可用容量骤降。中转站大量用这种措辞。
  console.log("\n补充·上游错误分类：限流（429）与欠费（402）必须分开");
  {
    const st = adapters.statusFromCompatError;
    ok(st({ message: "Rate limit exceeded, please retry later" }) === 429, "rate limit 措辞 → 429（短退避换号）", st({ message: "Rate limit exceeded" }));
    ok(st({ message: "rate limit quota exceeded" }) === 429, "「rate limit quota exceeded」是限流不是欠费（裸 quota 判据的误伤点）");
    ok(st({ message: "Requests per minute quota exceeded" }) === 429, "RPM 配额用尽也是限流");
    ok(st({ message: "Too many requests" }) === 429, "Too many requests → 429");
    ok(st({ message: "请求过于频繁，请稍后再试" }) === 429, "中文限流措辞 → 429");
    ok(st({ message: "You exceeded your current quota, please check your plan" }) === 402, "OpenAI 官方的 insufficient quota 措辞 → 402（真欠费）");
    ok(st({ message: "Insufficient balance" }) === 402, "余额不足 → 402");
    ok(st({ message: "账户欠费，请充值" }) === 402, "中文欠费 → 402");
    ok(st({ message: "invalid api key" }) === 401, "鉴权类仍判 401（顺序调整没把这条挤掉）");
    ok(st({ message: "something unknown happened" }) === 502, "认不出的仍按 502（可换号）");
  }

  up.srv.close();
  up2.srv.close();
  server.stop();
  store.close();
  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("\n闸自身异常:", e);
  process.exit(1);
});
