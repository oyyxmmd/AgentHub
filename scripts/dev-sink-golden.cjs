// 网关调度核心的「黄金字节等值」闸：node scripts/dev-sink-golden.cjs
//
// 用途：server.cjs 的 handleChat 即将拆成「调度核心 + 协议 sink」（零语义改动）。
// 这种搬家只靠"看着没改"是守不住的——它内部有四个共享闭包变量的耦合点
// （sentDelta ↔ resetAttemptState ↔ planLimit 出线后短路 ↔ catch 的 sentDelta||ttftMs 禁令），
// 挪错一处的表现是「非流式换号把两个账号的正文拼成一条」或「流中错误被误判成已出线而废掉换号」，
// 都很难靠读代码发现。所以先把重构前的逐字节输出与冷却决策录成基线，重构后必须逐字相等。
//
// 用法：
//   node scripts/dev-sink-golden.cjs --write   # 重构前录基线（写 scripts/fixtures/gateway-sink-baseline.json）
//   node scripts/dev-sink-golden.cjs           # 之后每次都比对
//
// 每个场景单独起一个子进程跑：渠道级退避（channelBackoff）与软限流 streak 是模块内的内存态，
// 同进程连跑多个场景会互相污染，那样基线就不可复现了。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const FIXTURE = path.join(__dirname, "fixtures", "gateway-sink-baseline.json");
const PORT = 19551;
const UP = 19552;

// ===== 场景表（父进程与子进程共用一份） =====
// steps 是假适配器的剧本：emit 一个事件 / throw 一个上游错误 / return 一个结果，按顺序走
// （同一场景被换号重发时会再走一遍剧本，所以剧本按"第 N 次调用"分桶）
const SCENARIOS = {
  "stream-ok": {
    desc: "流式正常：role→正文→usage→finish→[DONE]",
    model: "glm-4.6", channel: "trae", stream: true,
    picks: ["acc1"],
    scripts: [[
      { emit: { type: "delta", delta: { role: "assistant", content: "" } } },
      { emit: { type: "delta", delta: { content: "你好" } } },
      { emit: { type: "delta", delta: { reasoning_content: "想想" } } },
      { emit: { type: "delta", delta: { content: "，世界" } } },
      { emit: { type: "usage", usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } } },
      { emit: { type: "finish", reason: "stop" } },
      { return: { status: 200, planLimit: false } },
    ]],
  },
  "nonstream-ok": {
    desc: "非流式正常：同一批事件由 Aggregator 聚成一条 message",
    model: "glm-4.6", channel: "trae", stream: false,
    picks: ["acc1"],
    scripts: [[
      { emit: { type: "delta", delta: { role: "assistant", content: "你好" } } },
      { emit: { type: "delta", delta: { content: "，世界" } } },
      { emit: { type: "delta", delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"p":1}' } }] } } },
      { emit: { type: "usage", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } },
      { emit: { type: "finish", reason: "tool_calls" } },
      { return: { status: 200, planLimit: false } },
    ]],
  },
  "refresh-401": {
    desc: "401 → single-flight 刷新成功 → 同账号重发",
    model: "glm-4.6", channel: "trae", stream: true,
    picks: ["acc1", "acc1"],
    refresh: { ok: true, token: "tok-new", refreshToken: "ref-new" },
    scripts: [
      [{ throw: { message: "凭证失效", status: 401 } }],
      [
        { emit: { type: "delta", delta: { content: "刷新后的回答" } } },
        { emit: { type: "finish", reason: "stop" } },
        { return: { status: 200, planLimit: false } },
      ],
    ],
  },
  "rate-429-rotate": {
    desc: "第一把 Key 吃 429（无明示重置时间）→ 退避重试同号 → 仍失败则换第二把",
    model: "glm-4.6", channel: "trae", stream: true,
    picks: ["acc1", "acc1", "acc2"],
    scripts: [
      [{ throw: { message: "Too Many Requests", status: 429 } }],
      [{ throw: { message: "Too Many Requests", status: 429 } }],
      [
        { emit: { type: "delta", delta: { content: "换号后成功" } } },
        { emit: { type: "finish", reason: "stop" } },
        { return: { status: 200, planLimit: false } },
      ],
    ],
  },
  "model-rate-6004": {
    desc: "6004 模型级限流（带『将在 … 重置』墙钟）→ 罚账号×模型而非整号，换号继续",
    model: "glm-4.6", channel: "trae", stream: true,
    picks: ["acc1", "acc2"],
    scripts: [
      [{ throw: { message: "上游返回 6004，将在 2030-01-01 04:00 重置", status: 429, code: 6004 } }],
      [
        { emit: { type: "delta", delta: { content: "另一个号答了" } } },
        { emit: { type: "finish", reason: "stop" } },
        { return: { status: 200, planLimit: false } },
      ],
    ],
  },
  "plan-limit-after-delta": {
    desc: "积分耗尽但以流中 error 到达且正文已出线 → 绝不换号重发（否则正文拼接），就地收尾",
    model: "glm-4.6", channel: "trae", stream: true,
    picks: ["acc1"],
    scripts: [[
      { emit: { type: "delta", delta: { content: "半截" } } },
      { emit: { type: "error", message: "credits insufficient", status: 402 } },
      { return: { status: 200, planLimit: true } },
    ]],
  },
  "plan-limit-cold": {
    desc: "积分耗尽且一条内容都没出 → 换号，客户端完全无感",
    model: "glm-4.6", channel: "trae", stream: true,
    picks: ["acc1", "acc2"],
    scripts: [
      [{ return: { status: 200, planLimit: true } }],
      [
        { emit: { type: "delta", delta: { content: "好号答的" } } },
        { emit: { type: "finish", reason: "stop" } },
        { return: { status: 200, planLimit: false } },
      ],
    ],
  },
  "waf-channel-block": {
    desc: "WAF Block Page 是渠道级故障：短退避整个渠道，不逐个冷却账号（followup 验退避真的生效）",
    model: "glm-4.6", channel: "trae", stream: true, followups: 1,
    picks: ["acc1"],
    scripts: [[
      { throw: { message: "上游返回 HTML", status: 405, body: "<html>WAF Block Page</html>" } },
    ]],
  },
  "stream-error-inflight": {
    desc: "流中出现 error 事件且已出线 → 把 OpenAI 错误对象注入流并照常 [DONE]",
    model: "glm-4.6", channel: "trae", stream: true,
    picks: ["acc1"],
    scripts: [[
      { emit: { type: "delta", delta: { content: "前半段" } } },
      { emit: { type: "error", message: "上游中断", status: 502, code: 9 } },
      { return: { status: 200, planLimit: false } },
    ]],
  },
  "noise-only-frames": {
    desc: "全是空噪声帧后吃流中 error：噪声不得算已出线——必须静默换号，客户端看不到错误帧",
    model: "glm-4.6", channel: "trae", stream: true,
    picks: ["acc1", "acc2"],
    scripts: [
      [
        { emit: { type: "delta", delta: { role: "assistant", function_call: null, refusal: "", tool_calls: [] } } },
        { emit: { type: "error", message: "上游空响应", status: 502 } },
        { return: { status: 200, planLimit: false } },
      ],
      [
        { emit: { type: "delta", delta: { content: "真内容" } } },
        { emit: { type: "finish", reason: "stop" } },
        { return: { status: 200, planLimit: false } },
      ],
    ],
  },
  "nonstream-plan-limit-rotate": {
    desc: "非流式 + 第一个号吐出半截正文后判积分耗尽 → 换号重发：Aggregator 必须重建，"
      + "否则两号正文拼进同一条 content（这条场景是变异测出来的：没有它，删掉 resetAttemptState 全绿）",
    model: "glm-4.6", channel: "trae", stream: false,
    picks: ["acc1", "acc2"],
    scripts: [
      [
        { emit: { type: "delta", delta: { role: "assistant", content: "上一号的半截" } } },
        { return: { status: 200, planLimit: true } },
      ],
      [
        { emit: { type: "delta", delta: { content: "换号后的正文" } } },
        { emit: { type: "usage", usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } } },
        { emit: { type: "finish", reason: "stop" } },
        { return: { status: 200, planLimit: false } },
      ],
    ],
  },
  "fallback-comment-stream": {
    desc: "模型回退明示（流式）：头已冲刷，改发 SSE 注释帧，客户端可见但不进正文",
    model: "no-such-model", owners: ["glm-4.6"], channel: "trae", stream: true,
    fallback: { "no-such-model": "glm-4.6" },
    picks: ["acc1"],
    scripts: [[
      { emit: { type: "delta", delta: { content: "回退后答" } } },
      { emit: { type: "finish", reason: "stop" } },
      { return: { status: 200, planLimit: false } },
    ]],
  },
  "fallback-json-nonstream": {
    desc: "模型回退明示（非流式）：只挂响应头，绝不得往 JSON 正文里塞注释帧",
    model: "no-such-model", owners: ["glm-4.6"], channel: "trae", stream: false,
    fallback: { "no-such-model": "glm-4.6" },
    picks: ["acc1"],
    scripts: [[
      { emit: { type: "delta", delta: { content: "回退后答" } } },
      { emit: { type: "finish", reason: "stop" } },
      { return: { status: 200, planLimit: false } },
    ]],
  },
  "reasoning-tail-no-finish": {
    desc: "思考链两段且第二段落在合批时间窗内、上游没发 finish 就结束：尾段必须靠收尾冲刷才出得来",
    model: "glm-4.6", channel: "trae", stream: true,
    picks: ["acc1"],
    scripts: [[
      { emit: { type: "delta", delta: { reasoning_content: "第一段思考" } } },
      { emit: { type: "delta", delta: { reasoning_content: "尾段" } } },
      { return: { status: 200, planLimit: false } },
    ]],
  },
  "finish-without-reason": {
    desc: "finish 事件不带 reason：非流式的 finish_reason 必须沿用累加值（默认 stop），不能被本帧的 undefined 覆盖",
    model: "glm-4.6", channel: "trae", stream: false,
    picks: ["acc1"],
    scripts: [[
      { emit: { type: "delta", delta: { content: "正文" } } },
      { emit: { type: "finish" } },
      { return: { status: 200, planLimit: false } },
    ]],
  },
  "unknown-model": {
    desc: "模型无人拥有且没配有回退 → 400 并在提示里列出可用模型",
    model: "no-such-model", channel: null, stream: true,
    picks: [],
    scripts: [],
  },
};

// 客户端刻意用 node:http 而不是 fetch：undici 的全局连接池在 Windows 上退出时会踩
// libuv 的 `!(handle->flags & UV_HANDLE_CLOSING)` 断言（实测把子进程打成 0xC0000409 崩溃，
// 而崩溃发生在 stdout 已经写完之后——基线反而落不了盘）。自建 Agent 可以显式销毁干净。
/** 冷却时长只记量级，不记精确秒数：6004 那类墙钟冷却的目标时刻是固定的，
 *  但 `until - Date.now()` 每次跑都漂几秒，逐字比对会把闸自己跑成随机失败。
 *  真正要守的语义是「罚的是账号还是账号×模型」，不是还剩多少秒。 */
function coolBucket(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (n >= 86400) return "1d+";
  if (n >= 3600) return "1h+";
  if (n >= 600) return "10m+";
  return String(Math.round(n / 10) * 10);
}

function makeClient(secret, model, stream) {
  const http = require("node:http");
  const agent = new http.Agent({ keepAlive: false });
  const req = () =>
    new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: "127.0.0.1", port: PORT, path: "/v1/chat/completions", method: "POST", agent,
          headers: { "content-type": "application/json", authorization: "Bearer " + secret },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, body: normalize(text) }));
        }
      );
      r.on("error", reject);
      r.write(JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream }));
      r.end();
    });
  return { req, close: () => agent.destroy() };
}
function normalize(text) {
  return String(text)
    .replace(/chatcmpl-[0-9a-f]{24}/g, "chatcmpl-REQID")
    .replace(/"created":\d+/g, '"created":CREATED')
    .replace(/"id":"[0-9a-f-]{36}"/g, '"id":"UUID"')
    // 上游 v1.50.2 给失败响应加了 [ah:xxxxxxxx] 请求 id 前缀（= 每次请求随机的 24 位 id 取前 8 位）。
    // 不抹掉的话基线会把一次运行的随机值钉死，下必红——它承载的是取证信息，不是调度语义。
    .replace(/\[ah:[0-9a-f]{8}\]/g, "[ah:REQID]")
    // 渠道退避倒计时按墙钟算秒数，逐次运行会跳一两个字：抹成常数，
    // 但保留「有没有这句话」——那才是"走了渠道级退避而不是罚账号"的判据
    .replace(/，\s*\d+\s*s?\s*后重试/g, "，Ns 后重试");
}

function runScenario(id) {
  const sc = SCENARIOS[id];
  process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-golden-"));
  const store = require("../electron/backend/proxy/store.cjs");
  const pool = require("../electron/backend/proxy/pool.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const server = require("../electron/backend/proxy/server.cjs");

  store.open();
  const gwKey = store.createKey({ name: "golden", route: "auto", dailyQuota: 0, rateLimit: 0 });

  // 观测记录：冷却决策与选号顺序，和字节流同等重要（重构最容易悄悄改掉的就是这两条）
  const coolLog = [];
  const pickLog = [];
  const usageRows = [];

  const accounts = {
    acc1: { id: "acc1", channel: sc.channel || "trae", name: "一号", status: "online" },
    acc2: { id: "acc2", channel: sc.channel || "trae", name: "二号", status: "online" },
  };

  // —— 打桩：把调度核心与外界的所有接缝接管，场景剧本因此完全确定 ——
  const raw = {
    adaptersGet: adapters.get,
    adaptersRefresh: adapters.refreshTokenLocked,
    adaptersOwners: adapters.modelOwners,
    poolPick: pool.pickAccount,
  };
  // 给了 owners 就只认 owners（回退场景要的就是「请求模型无人拥有、回退模型有人拥有」）；
  // 没给则沿用「请求模型即命中渠道」的旧口径，不影响既有场景。
  adapters.modelOwners = (model) => (sc.channel && (sc.owners ? sc.owners.includes(String(model)) : String(model) === sc.model) ? [sc.channel] : raw.adaptersOwners(model));
  // 游标必须在 get() 外面：attemptChat 每次尝试都会重新 adapters.get(channel)，
  // 计数跟着归零就会让"第二次尝试"重播第一份剧本 —— 多账号场景于是全部失真。
  let call = 0;
  adapters.get = (channel) => {
    const real = raw.adaptersGet(channel);
    if (!real) return real;
    return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      chat: async (ctx) => {
        const steps = sc.scripts[Math.min(call, sc.scripts.length - 1)] || [];
        call += 1;
        for (const s of steps) {
          if (s.throw) {
            const e = new Error(s.throw.message);
            Object.assign(e, s.throw);
            throw e;
          }
          if (s.emit) ctx.emit(s.emit);
          if (s.return) return s.return;
        }
        return { status: 200, planLimit: false };
      },
    });
  };
  adapters.refreshTokenLocked = async () => sc.refresh || { ok: false };

  pool.pickAccount = (channel, strategy, exclude) => {
    const idx = pickLog.length;
    const want = sc.picks[idx];
    pickLog.push({ channel, strategy, excluded: [...(exclude || [])].join(",") });
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
  pool.coolAccount = (id, kind, detail) => coolLog.push({ fn: "coolAccount", id, kind, detail: String(detail || "").slice(0, 40) });
  pool.coolAccountModel = (id, model, until, reason) => coolLog.push({ fn: "coolAccountModel", id, model, bucket: coolBucket((until - Date.now()) / 1000), reason: String(reason || "").slice(0, 40) });
  pool.coolAccountMs = (id, until, detail) => coolLog.push({ fn: "coolAccountMs", id, bucket: coolBucket((until - Date.now()) / 1000), detail: String(detail || "").slice(0, 40) });
  pool.poolSummary = (channel) => ({ channel, onlineCount: 1, totalCredits: 100, accountCount: 1, todayReq: 0, todayTokens: 0, lastCreditsAt: 0, earliestExpire: 0, expiringSoon: false });

  store.insertUsage = (row) => usageRows.push({
    channel: row.channel, accountName: row.accountName, model: row.model, status: row.status,
    promptTokens: row.promptTokens, completionTokens: row.completionTokens, error: normalize(row.error),
  });
  store.getAccount = (id) => ({ id: String(id), channel: sc.channel || "trae", token_enc: "", refresh_enc: "", meta: "", status: "online" });
  store.accountSecrets = () => ({ token: "tok-old", refreshToken: "ref-old" });
  store.updateAccount = () => true;
  store.bumpAccountUsage = () => {};
  store.noteError = () => {};
  store.keyTodayReq = () => 0;

  return server
    .start(() => ({
      port: PORT, bind: "127.0.0.1", rateLimitPerMin: 0, concurrency: 8,
      routeStrategy: "smart", fixedChannel: "trae", modelOverrides: {}, debugStatus: false,
      humanizeJitter: false, disabledModels: [], modelFallback: sc.fallback || {}, modelAliases: {},
    }))
    .then(async (sr) => {
      if (!sr.ok) throw new Error("网关起不来：" + sr.message);
      const client = makeClient(gwKey.secret, sc.model, sc.stream);
      const doRequest = () => client.req();

      const first = await doRequest();
      // followups：渠道级退避（channelBackoff）是 server 的模块私有态，桩打不进去。
      // 唯一的可观测证据是"紧接着再发一次：应当直接 503 且一个号都不选"——
      // 所以 WAF 场景必须带 followups:1，否则这条闸只是在自我宣布成功。
      const follow = [];
      for (let i = 0; i < (sc.followups || 0); i++) {
        const picksFrom = pickLog.length;
        const r = await doRequest();
        follow.push({ ...r, picks: pickLog.slice(picksFrom).map((p) => p.channel + ":" + (p.excluded || "-")) });
      }
      client.close();
      server.stop();
      store.close();
      return { id, desc: sc.desc, status: first.status, body: first.body, followups: follow, coolLog, pickLog, usageRows };
    })
    .finally(() => {
      Object.assign(adapters, { get: raw.adaptersGet, refreshTokenLocked: raw.adaptersRefresh, modelOwners: raw.adaptersOwners });
      pool.pickAccount = raw.poolPick;
    });
}

const MARK = "@@GOLDEN@@"; // 子进程结果的前缀标记：产品代码偶尔会往 stdout 打日志，靠它把 JSON 择出来

function main() {
  const arg = process.argv[2] || "";
  if (arg.startsWith("--only=")) {
    return runScenario(arg.slice(7)).then(
      (r) => {
        process.stdout.write(MARK + JSON.stringify(r));
        process.exit(0);
      },
      (e) => {
        console.error("场景执行失败:", e);
        process.exit(1);
      }
    );
  }
  const write = arg === "--write";
  const ids = Object.keys(SCENARIOS);
  const out = {};
  for (const id of ids) {
    const rawOut = execFileSync(process.execPath, [__filename, "--only=" + id], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const at = rawOut.lastIndexOf(MARK);
    if (at < 0) throw new Error(`场景 ${id} 的子进程没吐出结果（多半是退出前就崩了）\n${rawOut.slice(0, 500)}`);
    out[id] = JSON.parse(rawOut.slice(at + MARK.length));
    console.log(`  · ${id} → HTTP ${out[id].status} · 冷却 ${out[id].coolLog.length} 条 · 流水 ${out[id].usageRows.length} 行`);
  }
  if (write) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(out, null, 2) + "\n");
    console.log(`\n基线已写入 ${path.relative(process.cwd(), FIXTURE)}（${ids.length} 个场景）`);
    return;
  }
  if (!fs.existsSync(FIXTURE)) {
    console.error(`缺基线文件 ${path.relative(process.cwd(), FIXTURE)}；先跑 --write（必须在重构前的代码上录）`);
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  let fail = 0;
  for (const id of ids) {
    for (const key of ["status", "body", "followups", "coolLog", "pickLog", "usageRows"]) {
      const a = JSON.stringify(base[id] && base[id][key]);
      const b = JSON.stringify(out[id][key]);
      if (a !== b) {
        fail += 1;
        console.log(`  ✗ ${id} 的 ${key} 变了\n     基线: ${a}\n     现在: ${b}`);
      }
    }
  }
  if (fail) {
    console.error(`\n黄金字节等值 FAIL：${fail} 处差异（调度核心的语义被改动了）`);
    process.exit(1);
  }
  console.log(`\n黄金字节等值 OK：${ids.length} 个场景的响应字节 / 冷却决策 / 选号顺序 / 流水全部与基线逐字相等`);
}

main();
