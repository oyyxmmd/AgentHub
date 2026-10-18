// 反代网关 · HTTP 服务（方案 §4/§6.1）：Express @ 127.0.0.1:9527（可配置）
// 端点：POST /v1/chat/completions、POST /v1/messages、POST /v1/responses（各 SSE 双态）
//       / POST /v1/messages/count_tokens / GET /v1/models / GET /healthz / GET /status（调试，默认关）
// 错误语义按**入站协议**回：OpenAI 侧 401 invalid_api_key / 429 配额或限流 / 400 参数 / 502 上游 /
// 503 渠道不可用；Anthropic 侧同样这些状态码，但外壳是 { type:"error", error:{ type, message } }
// ——Claude Code 只认这个形状，给它一个 OpenAI 的 401 会被直接判成连接失败。
// Responses 侧沿用 OpenAI 的 { error:{ message, type, param, code } } 外壳，但流内失败必须做成
// 一个 response.failed 帧——Codex 要看到终止事件才收流。
// 转发不用现成反代中间件：Dispatch(Key→渠道) → PoolService(号池选号) → Adapter(渠道改写) → SSE 转换输出
"use strict";
const crypto = require("node:crypto");
const store = require("./store.cjs");
const pool = require("./pool.cjs");
const adapters = require("./adapters.cjs");
const provider = require("./provider.cjs");
const util = require("./util.cjs");
const openaiOut = require("./protocols/openai-out.cjs");
const anthropicIn = require("./protocols/anthropic-in.cjs");
const anthropicOut = require("./protocols/anthropic-out.cjs");
const responsesIn = require("./protocols/responses-in.cjs");
const responsesOut = require("./protocols/responses-out.cjs");
const events = require("./events.cjs");
const oplog = require("./oplog.cjs");

let runtime = null; // { server, startedAt, port, bind, active }

// 单 Key 令牌桶（内存态，默认 120 次/分钟，Key 上可单独配置覆盖）
const buckets = new Map();

function rateLimitOk(key, defaultPerMin) {
  const perMin = key.rateLimit > 0 ? key.rateLimit : defaultPerMin;
  if (!perMin) return true;
  if (buckets.size > 5000) buckets.clear(); // 已删 Key 的桶定期清，防内存缓慢增长
  const now = Date.now();
  let b = buckets.get(key.id);
  if (!b) {
    b = { tokens: perMin, ts: now };
    buckets.set(key.id, b);
  }
  b.tokens = Math.min(perMin, b.tokens + ((now - b.ts) / 60000) * perMin);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function sendError(res, status, message, type, code) {
  if (res.headersSent) return;
  res.status(status).json(util.openaiError(message, type, code));
}

/**
 * 账号名脱敏：失败轨迹会返回给 API 客户端并落请求日志，而号池账号名常是邮箱
 * （chiheng.zhu@gmail.com 这类）——原样透出等于把账号标识传播到下游工具/IDE 的报错弹窗。
 * 保留「能认出是哪个号」的最小信息量：
 *   · 邮箱 → 本地部分前 2 字符 + 域名（ch····@gmail.com）
 *   · 其它 → 前 4 字符 + 省略号
 * 单字符名不脱敏（脱了反而认不出）。
 */
function maskAccountName(name) {
  const s = String(name || "").trim();
  if (s.length <= 1) return s;
  const at = s.indexOf("@");
  if (at > 0) {
    const local = s.slice(0, at);
    const domain = s.slice(at);
    const keep = local.length <= 2 ? 1 : 2;
    return local.slice(0, keep) + "····" + domain;
  }
  return s.length <= 4 ? s : s.slice(0, 4) + "…";
}

/** request 事件节流：每条代理请求完成都会调用，高流量时逐条广播只烧 IPC，
    合并为每 2 秒至多一条（带合并条数），渲染层本就以 5s 轮询展示实时流 */
let reqEvt = { count: 0, timer: null };
function emitRequestThrottled() {
  reqEvt.count++;
  if (reqEvt.timer) return;
  reqEvt.timer = setTimeout(() => {
    const n = reqEvt.count;
    reqEvt = { count: 0, timer: null };
    events.emit({ type: "request", count: n });
  }, 2000);
}

/** 渠道选择（方案 §6.2）：提供商前缀直达 → 单源强制 → per-model 覆盖 → 打分（健康度×余额）/ 指定渠道优先。
 *  关闭的渠道（上游启闭）不参与：modelOwners 已过滤（单源 → 空 → 400），
 *  key.route 指到关闭渠道按 auto 走（钉死的渠道被关后不能把请求带进死胡同） */
function resolveChannel(key, model, settings) {
  // `slug/model` 前缀直达提供商。这里只交出渠道，不改模型名——上游真名由适配器的 upstreamFor
  // 剥前缀再映射，与内置适配器「收到客户端模型名、自己改写」的契约一致，调度层不需要第二套命名口径。
  const slug = provider.parseModelRef(model);
  if (slug) return { channel: slug };
  const owners = adapters.modelOwners(model, settings);
  if (owners.length === 1) return { channel: owners[0] }; // 模型仅存在于单渠道目录 → 强制
  if (key.route !== "auto" && adapters.channelOn(key.route, settings)) {
    // 虚拟统一名不能透传给未配置映射的渠道；非虚拟模型保留「指定渠道透传试错」的既有语义。
    if (adapters.resolveModelTarget(model, key.route, settings)) return { channel: key.route };
    if (!adapters.reverseAliasEntry(model, settings)) return { channel: key.route };
  }
  if (owners.length > 1) {
    const ov = (settings.modelOverrides || {})[model];
    if (ov && owners.includes(ov)) return { channel: ov };
    if (settings.routeStrategy === "fixed" && owners.includes(settings.fixedChannel)) return { channel: settings.fixedChannel };
    return { channel: pickByOrder(routeOrderOf(key, settings), owners, tierGroups()) };
  }
  // 模型不在任何目录：auto 且固定渠道策略时放行指定渠道（透传试错），否则 400 给可用模型提示。
  // 指定渠道已被「上游启闭」关闭时不再透传试错（issue #90）：打向已关闭渠道只会拿到
  // 上游透传错误，直接给明确的 channel_disabled 业务码
  if (settings.routeStrategy === "fixed") {
    if (adapters.channelOn(settings.fixedChannel, settings)) return { channel: settings.fixedChannel };
    return { channel: null, disabledChannel: settings.fixedChannel };
  }
  // 裸名兜底（提供商通路的可选项）：没有任何内置渠道拥有该模型时，才允许它唯一命中某个提供商，
  // 两个提供商都有 gpt-4o 时不猜（见 provider.findUniqueByBareModel）。开关关掉即回到
  // 「提供商的模型必须写 slug/model」这一种形态；默认放开，因为多数客户端的配置里不带前缀。
  const sole = settings.allowBareProviderModel === false ? null : provider.findUniqueByBareModel(model);
  if (sole) return { channel: sole };
  return { channel: null, unknownModel: true };
}

/** 渠道综合分：可用账号数 × 号池总余额（方案 §6.2 auto）；降级中的渠道记 0 分——
 *  熔断让位备选，到期半开自动恢复资格（成功一次清零，见 noteChannelSuccess）。
 *  关闭的渠道同样记 0 分（上游启闭：打分排不上去，路由不落） */
function channelScore(channel) {
  if (channelCooling(channel) || !adapters.channelOn(channel)) return 0;
  const s = pool.poolSummary(channel);
  return (s.onlineCount > 0 ? 1 : 0) * (1 + s.totalCredits);
}

// ===== 渠道成本感知排序（cost-first 档） =====
// 成本档 = 渠道级的离散标注（agents.cost_tier：free=免费额度 / low=签到白送 / normal=普通），
// 解决「跨渠道余额单位不可比」：不折算余额数值（智谱 Tokens ≠ 魔搭魔粒，无可靠换算依据），
// 只用档位表达相对成本，档内仍按健康×余额打分。
const COST_GROUPS = { free: 0, low: 1, normal: 2 };
const COST_TIER_LABELS = { free: "免费", low: "低成本" }; // normal 不拼标签（轨迹降噪）

/** 全渠道成本档一次取全（比较器内逐个查库是 O(n log n) 次 SELECT，提前物化成 Map） */
function tierGroups() {
  const m = new Map();
  for (const a of store.listAgents()) m.set(a.id, COST_GROUPS[a.costTier || "normal"] ?? 2);
  return m;
}

/** cost-first 组内排序分：同 channelScore，但池内含 -1 无限账号的渠道按超大余额参与。
 *  totalCredits 不含 -1 哨兵，现状按 1+0 计分会把全无限账号的渠道垫到最底 */
function costFirstScore(channel) {
  const s = pool.poolSummary(channel);
  if (channelCooling(channel) || !adapters.channelOn(channel)) return 0;
  const base = (s.onlineCount > 0 ? 1 : 0) * (1 + s.totalCredits);
  return s.unlimited ? base + 1e12 : base;
}

/** 渠道此刻是否真的出得了请求：**与 pickAccount 的静态判据同口径**（不写库、每请求实时派生）。
 *  后两条必须一起算——「已知余额为 0」「余额已到期」的号在池视图里仍是 online
 *  （把号标 exhausted 的是 pickAccount 自己），只看 onlineCount 会把它们当可用渠道继续占预算。
 *  settings 可选：/v1/models 过滤等调用方持有当前请求的 settings 对象，传入避免 channelOn
 *  回落到默认配置、漏判「上游启闭」刚做出的关闭（issue #90 自测抓到的口径偏差） */
function routeUsable(channel, settings) {
  if (channelCooling(channel) || !adapters.channelOn(channel, settings)) return false;
  const now = Date.now();
  return pool.poolAccounts(channel).some((a) =>
    a.status === "online" && a.hasToken &&
    // 与 pickAccount 同口径（issue #86 教训）：余额 0 的排除对声明 zeroBalanceUsable 的
    // 渠道（Cline）同样豁免——余额 0 不是它的硬门禁，两处判据必须一起改
    !((a.creditsAt > 0 && a.credits === 0) && !pool.zeroBalanceUsable(channel)) &&
    !(a.expiresAt > 0 && a.expiresAt <= now));
}

/** 渠道排序比较器（按生效档）：
 *  score = 现状（健康×余额打分，行为与旧 bestByScore 逐字节等同）；
 *  cost-first = **能出请求的渠道优先**，其内再按成本档升序（免费额度优先消耗的产品语义不变）。
 *  可用性必须当第一键：原实现只按成本档排，空池/熔断的便宜渠道会抢占主渠道位并吃掉
 *  channelFailoverMax 预算，把唯一可用的渠道挤出队列 → 明明有账号却 503，轨迹里连它都不出现（issue #86）。
 *  可用性表按比较器实例惰性记忆化：比较器里逐个查库是 O(n log n) 次（与 score 档现状同量级，不额外放大）；
 *  调用方已有物化表可直接传入。
 *  恢复回切零新状态：可用性每请求实时派生、不做缓存，打光/熔断自然让位，恢复后自然排回最前 */
function cmpByOrder(order, groups, usableTable) {
  if (order !== "cost-first") return (a, b) => channelScore(b) - channelScore(a);
  const memo = usableTable || new Map();
  const usableOf = (ch) => {
    if (!memo.has(ch)) memo.set(ch, routeUsable(ch));
    return memo.get(ch);
  };
  return (a, b) => {
    const ua = usableOf(a);
    const ub = usableOf(b);
    if (ua !== ub) return ua ? -1 : 1;
    const ga = groups.get(a) ?? 2;
    const gb = groups.get(b) ?? 2;
    if (ga !== gb) return ga - gb;
    return costFirstScore(b) - costFirstScore(a);
  };
}

/** 生效档：per-key 覆盖 → 全局默认（缺省 score = 现状） */
function routeOrderOf(key, settings) {
  return key.routeOrder || settings.routeOrder || "score";
}

// ===== 跨渠道故障转移规模（纯函数；每模型尝试预算与候选队列上限共用同一口径，导出供自测断言）=====
const CHANNEL_FAILOVER_MAX_CAP = 10; // 单请求最多尝试渠道数上限（与配置页输入框 max=10 同步）
const UPSTREAM_TRIES_FLOOR = 6;      // 存量固定预算：1~5 档与关闭 failover 一律回到它（零行为变化）

/** 渠道数上限归一化：与旧运行时 Math.max(1, Number(v) || 3) 逐值一致（0/空/NaN → 3），
 *  另收敛两处旧代码缺失：Math.round 整数化（旧代码把小数赋给 queue.length 会抛 RangeError）
 *  与服务端上界（config.json 可手改/被同步写入，上限无界会把下游每模型预算一起无界放大） */
function normalizeChannelFailoverMax(v) {
  const n = Number(v) || 3;
  return Math.min(CHANNEL_FAILOVER_MAX_CAP, Math.max(1, Math.round(n)));
}

// ===== 瞬时错误原地重发（同账号重试，参考 agent2api retry_api 语义）=====
// 5xx/网络/超时这类瞬时错误，同一账号先原地重发 N 次吸收抖动，用尽再换号。
// 与 401 刷新重试、429 退避重试并列的第三档重试。
const RETRY_SAME_MAX_COUNT = 5;          // 同账号原地重发次数上限（配置可覆盖）
const RETRY_SAME_DEFAULT_COUNT = 1;      // 默认重发 1 次
const RETRY_SAME_DEFAULT_INTERVAL_MS = 1000; // 默认退避间隔 1s
const RETRY_SAME_MIN_INTERVAL_MS = 200;  // 间隔下限（防 0ms 忙等）
const RETRY_SAME_MAX_INTERVAL_MS = 10000; // 间隔上限

/** 同账号原地重发次数：settings.retrySameAccountCount 显式配置（含 0 = 关闭）时按配置
 * （封顶 RETRY_SAME_MAX_COUNT），缺省/非法回退 RETRY_SAME_DEFAULT_COUNT。
 *  Math.round 整数化（与 normalizeChannelFailoverMax 同口径） */
function retrySameAccountCount(settings) {
  const raw = settings && settings.retrySameAccountCount;
  if (raw == null) return RETRY_SAME_DEFAULT_COUNT; // 缺省 = 默认 1 次
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return RETRY_SAME_DEFAULT_COUNT; // 脏值回默认
  return Math.min(RETRY_SAME_MAX_COUNT, Math.round(n)); // 0 = 显式关闭原地重发
}

/** 同账号原地重发退避间隔（毫秒）：settings.retrySameAccountIntervalMs，默认 1000ms */
function retrySameAccountIntervalMs(settings) {
  const n = Number(settings && settings.retrySameAccountIntervalMs);
  if (!Number.isFinite(n) || n <= 0) return RETRY_SAME_DEFAULT_INTERVAL_MS;
  return Math.min(RETRY_SAME_MAX_INTERVAL_MS, Math.max(RETRY_SAME_MIN_INTERVAL_MS, Math.round(n)));
}

/** 每模型上游尝试预算：failover 关 → 固定 6；否则 max(6, 上限 + 1)。
 *  +1 沿用旧配比（5 渠道 + 1 = 6）：预算恰等于候选数时，末个渠道会被预算收尾排除在轨迹外，
 *  报错条数将比设置值少 1——用户会再次怀疑「设置没生效」 */
function perModelUpstreamBudget(failoverEnabled, failoverMax) {
  if (failoverEnabled === false) return UPSTREAM_TRIES_FLOOR;
  return Math.max(UPSTREAM_TRIES_FLOOR, normalizeChannelFailoverMax(failoverMax) + 1);
}

/**
 * 候选队列是否**全部**因「在途并发已满」被跳过（issue #106）。
 * 是 → 返回聚合文案；否则返回空串（调用方照旧走通用包装）。
 *
 * 为什么单独判：队列耗尽时的 msg 取 lastErr，而 lastErr 是「首错保留」写法的产物——
 * 谁先撞上并发墙谁就成了最终文案，用户看到的是「渠道 A 在途并发已满（8/8）」，
 * 但请求其实把 B、C 也试了、也满了。观感上就像「B 明明刚开始用却也报这个」，
 * 第一反应是怀疑错误串号了。全部满就该明说「都满」。
 *
 * 判据两道：① 一次上游都没发出去（upstreamTries=0，否则说明至少有一个渠道真跑过）；
 * ② triedChannels 里每一条的 note 都以「在途并发已满」开头（含 null 项则不成立）。
 */
function concurrencyBlockedMessage(triedChannels, upstreamTries) {
  const list = triedChannels || [];
  if (upstreamTries || !list.length) return "";
  const notes = list.filter((t) => t && t.note && /^在途并发已满/.test(t.note));
  if (notes.length !== list.length) return "";
  const detail = [...new Set(notes.map((t) => `${t.chan} ${t.note}`))].join("、");
  return `所有候选渠道均在途并发已满（${detail}），请稍后重试或降低并发`;
}

/**
 * 与请求名「形近」的目录模型，最多 3 个（issue #117）。
 * 归一化：小写 + 去掉 - _ . 分隔符；判据是双向包含（漏后缀、写简写、少一段都能命中）。
 *
 * 为什么需要：模型名记错是最常见的误用——把 `deepseek-v4.1-flash` 写成 `deepseek4.1`、
 * 把 `claude-sonnet-4.5` 写成 `claude-sonnet`。此时 400 只回一长串可用模型，
 * 人眼在那串里对不上，用户的第一反应是「网关不支持这个模型」，而不是「我名字写错了」。
 * 先给最接近的几个，省一轮试错。
 */
function nearModelIds(model, all) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[-_.]/g, "");
  const key = norm(model);
  if (!key) return [];
  // 归一后太短（<4）时不做「包含」判定：一个 "a" 会命中目录里所有含 a 的模型，三个名额
  // 瞬间被毫无关系的名字占满，提示本身变成噪音（比不提示更误导）。这一档只留「归一后
  // 完全相同」——那正是「只差分隔符」的误用（gpt5 vs gpt-5），且请求一定走到了这里
  // （说明按原文查不到），提示它恰恰是对的
  const loose = key.length >= 4;
  const hits = [];
  for (const m of all || []) {
    const k = norm(m && m.id);
    if (!k) continue;
    if (k === key) hits.push({ id: m.id, d: 0 });
    else if (loose && (k.includes(key) || key.includes(k))) hits.push({ id: m.id, d: Math.abs(k.length - key.length) });
  }
  // 越接近的排前面（长度差小者优先）：目录顺序是随机的，不排序时更接近的名字可能被挤在
  // 三个名额之外，用户拿到的仍是没用的三条
  hits.sort((a, b) => a.d - b.d);
  return hits.slice(0, 3).map((h) => h.id);
}

/** 按生效档取最优渠道（resolveChannel 智能分支）；sort 稳定，同分保持 modelOwners 返回序 */
function pickByOrder(order, candidates, groups) {
  return [...candidates].sort(cmpByOrder(order, groups))[0];
}

/** 单账号尝试：401 就地刷新凭证、同渠道重试一次（方案 §6.3 WB 实证，Trae 同理）。
 *  刷新走 single-flight（并发 401 共享同一次刷新，防 refreshToken 轮换互相践踏）；
 *  刷新失败不立即判废——连续 3 次才 relogin（参考项目语义），中间短冷却重试 */
async function attemptChat(channel, acc, model, body, emit, meta) {
  const adapter = adapters.get(channel);
  let secrets = store.accountSecrets(store.getAccount(acc.id));
  // 会话式转发扩展点（契约见 adapters.cjs 顶部注释块）：适配器声明 stateful() 时改走
  // chatSession——装得下「一次客户端请求 = 多个上游请求 + 协议翻译」的上游；
  // 现有 9 家都不声明 stateful，一律走单发 chat，行为零变化
  const send = (secrets) =>
    typeof adapter.stateful === "function" && adapter.stateful() && typeof adapter.chatSession === "function"
      ? adapter.chatSession({ account: acc, secrets, model, body, emit, meta })
      : adapter.chat({ account: acc, secrets, model, body, emit, meta });
  try {
    return await send(secrets);
  } catch (e) {
    if (e && e.status === 401) {
      const r = await adapters.refreshTokenLocked(channel, acc, secrets).catch(() => ({ ok: false }));
      if (r.ok) {
        // noPersist 渠道（AutoClaw，方案 §7）：刷新结果只进适配器进程缓存，
        // 不落库——服务端轮换 refresh_token，落库会与桌面端自己的刷新互相顶掉
        store.updateAccount(acc.id, r.noPersist
          ? { status: "online", coolUntil: 0, coolReason: "" }
          : { token: r.token, refreshToken: r.refreshToken, status: "online", coolUntil: 0, coolReason: "" });
        return await send({ token: r.token, refreshToken: r.refreshToken });
      }
      // 触发计数与冷却交给 catch 侧的 applyCool 统一处理（classifyUpstream → relogin），
      // 这里只如实抛出：是短冷却重试还是判废由计数决定
      throw Object.assign(new Error("凭证失效且自动刷新失败"), { status: 401 });
    }
    throw e;
  }
}

/** 从错误文本解析上游明示的限流重置时间（参考项目实证：「将在 2026-09-17 04:00 重置」）。
 *  对齐墙钟冷却比固定 60s 盲猜准确——重置前换哪个号打这个模型都是白费。
 *  文案固定按 UTC+8 解释（参考项目 ParseRateReset 口径，与本机时区无关） */
function parseRateResetMs(text) {
  const m = /将在\s*([0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}[ T][0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)\s*重置/.exec(String(text || ""));
  if (!m) return 0;
  const t = Date.parse(m[1].replace(/\//g, "-").replace(" ", "T") + "+08:00");
  return Number.isFinite(t) && t > Date.now() ? t : 0;
}

/** 错误分类（对齐参考项目 handler.applyErrorPolicy 全表 + 参考项目 SOLO 专项）：
 *  决定冷却档位与是否换号。6004 = 模型级限流（罚账号×模型，切模型豁免）；
 *  11102 = 该账号不支持此模型（6h 指数负缓存）；4008 = 模型/账号级限流；4001 = 模型配置问题
 * （不罚号）；11115 prompt 过长（零动作透传）；11101 参数错误（换号不罚号——不同账号模型权限不同）。
 *  渠道私有业务码走扩展点 classifyError（契约见 adapters.cjs）：入参 channel 优先问适配器，
 *  返回非空即走渠道级分类。通用层保留的 4008/6004/11102/11115/11101 等码是**跨渠道共用**的
 * （trae/workbuddy/qoder 都会回同一族码），不能搬进单个渠道——搬走即改变其它渠道的分类结果 */
function classifyUpstream(e, planLimit, channel) {
  if (channel) {
    const ad = adapters.get(channel);
    if (ad && typeof ad.classifyError === "function") {
      const r = ad.classifyError(e);
      if (r) return r;
    }
  }
  if (planLimit || (e && e.status === 402)) return { kind: "credit", switchable: true, status: 402 };
  const msg = String((e && e.message) || "");
  const code = Number(e && e.code) || 0;
  if (code === 4001 || /model config is empty|config.*is empty/i.test(msg)) {
    return { kind: "model_config", switchable: true, status: 502 }; // 模型/配置问题：不罚号
  }
  if (code === 4008 || /\b4008\b/.test(msg)) return { kind: "rate", switchable: true, status: 429 };
  // 6004 模型级限流：code 字段与消息文本双通道判定——WB 流内 6004 的文案
  // （「您的使用量已超出频率限制，将在 XXX 重置」）不含数字码，只测文本会漏
  if (code === 6004 || /\b6004\b/.test(msg)) {
    return { kind: "model_rate", switchable: true, status: 429, resetMs: parseRateResetMs(msg) };
  }
  if (/\b11102\b/.test(msg) || /service info not found/i.test(msg)) return { kind: "model_blocked", switchable: true, status: 404 };
  if (/\b11115\b/.test(msg) || /prompt is too long|prompt_too_long/i.test(msg)) {
    return { kind: "prompt_too_long", switchable: false, status: 400 }; // 请求本身超限：零动作透传
  }
  if (/\b11101\b/.test(msg)) return { kind: "bad_params", switchable: true, status: 400 };
  if (e && e.status === 429) {
    // resetMs 统一为绝对时刻：parseRateResetMs 本就返回墙钟；retryAfterMs 是剩余时长，必须换算。
    // 二者混装会让 coolAccountMs 把时长当时刻，Retry-After: 7200 被 Math.max(now+1s) 兜成 1s 冷却（墙钟对齐失效）
    return { kind: "rate", switchable: true, status: 429, resetMs: parseRateResetMs(msg) || (e.retryAfterMs ? Date.now() + e.retryAfterMs : 0) };
  }
  if (e && e.status === 401) return { kind: "relogin", switchable: true, status: 401 };
  if (e && e.status === 404) return { kind: "not_found", switchable: true, status: 404 }; // 短冷却不累计，防雪崩
  if (e && e.status === 400) return { kind: "fatal", switchable: false, status: 400 };
  // 首字节超时（上游迟迟不吐第一个 token）：多为"这次 prompt 太大 / 上游这一刻忙"，
  // 不是账号故障——单独分类，只换号不冷却、也不计入 5xx/网络熔断
  if (e && e.firstByteTimeout) return { kind: "slow", switchable: true, status: 504 };
  return { kind: "server", switchable: true, status: 502 }; // 5xx / 网络 / 超时
}

/** 账号级风控拦截（WB 403 code 11140）回给调用方的本地说法。
 *  上游把它的 displayMsg 写成「内容未通过安全审核，请调整后重试」，实测与提问内容、请求头、
 *  UA、x-domain 全无关（同 body 换号即 200，同号换任何 body 仍 403，同号目录/计费端点 200）——
 *  原样透传只会把用户推去改提问，而改提问永远不会好。改写成本机能执行的两条路：
 *  换号，或在客户端重新登录该账号换一个会话。上游 code/request_id 仍留在记账里（走 e.body） */
const ACCOUNT_BLOCKED_MSG =
  "账号被上游风控拦截（403 request illegal / code 11140）：该账号的模型调用已被上游整体拒绝，" +
  "与提问内容无关（改提问无效）。请改用其它账号，或在客户端重新登录该账号以更换会话";
function humanizeAccountBlocked(e, cls) {
  if (e && cls && cls.kind === "account_blocked") e.message = ACCOUNT_BLOCKED_MSG;
  return e;
}

/** WAF/渠道级故障识别：WAF Block Page（HTML）与渠道白名单 11128 都不是账号问题——
 *  拦的是 IP/指纹/渠道，换号照拦。正确反应是渠道级短退避 + 如实报错，绝不能逐个冷却账号 */
function isWafBlock(e) {
  return /WAF Block Page/i.test(String((e && e.body) || (e && e.message) || ""));
}

function isChannelBlock(e) {
  // 11128 双通道判定：HTTP 400 路径靠 body 文本命中 isClientGate；流内 error 事件的
  // message（"Illegal API invocation from an unapproved channel"）不含数字码，
  // 只测文本会漏 code 字段——渠道级拦截被误记账号错误并计熔断
  return isWafBlock(e) || Number(e && e.code) === 11128 || /\b11128\b/.test(String((e && e.message) || ""));
}

/** 上游按「客户端/渠道资格」在渠道校验阶段拒绝（渠道级，与账号、提问内容都无关）：issue #78。
 *  这类 400 的正文会点名校验阶段与客户端身份（channel-verification / rejected this client /
 *  client fingerprint / unapproved channel|client / not a supported client）。
 *  ⚠ 锚点必须长且专有：真参数类 400（如「不支持关闭思考」）常常只带 Custom_raccoonException，
 *  绝不能靠「有 400 就跳备选」——那会把用户的参数错误变成白绕一圈。 */
function isClientGate(e) {
  if (!e || e.status !== 400) return false;
  const s = String(e.body || e.message || "");
  return /channel.?verification|rejected this client|client fingerprint|unapproved (channel|client)|not a supported client/i.test(s);
}

/** 上游错误体里的 code / request_id → 一行可引用的取证信息（issue #78）。
 *  客户端消息按 200 字截断，request_id 这类长标识常被切掉，用户想按上游要求「报 request id」也拿不到。 */
function upstreamRef(e) {
  const s = String((e && (e.body || e.message)) || "");
  const id = /request[_-]?id["'\s:：]*([A-Za-z0-9._:-]{6,})/i.exec(s);
  const code = /\bcode["'\s:：]*["']?([A-Za-z0-9._-]{2,20})/i.exec(s);
  return [code ? `code=${code[1]}` : "", id ? `request_id=${id[1]}` : ""].filter(Boolean).join(" ");
}

/** 可触发渠道降级的错误类别：上游/余额/限流/凭证类。400 参数 / 11101 参数 / 11115 超长 /
 *  4001 模型配置类不降级——换渠道也救不了，罚渠道是冤枉 */
const DEGRADABLE = new Set(["credit", "rate", "server", "relogin", "model_rate", "model_blocked", "not_found"]);

// ===== 渠道健康状态机：normal → degraded（降级，流量走备选）→ 半开（到期重获资格）→ 正常/再降级 =====
// 内存态不落库（本机流量调度状态；重启后首请求撞一次墙即自愈重建）。streak 驱动指数退避防震荡
const channelHealth = new Map(); // channel → { until, reason, streak, lastHit }

// 渠道连续失败计数：连续 2 次「真实打过上游仍打光」才降级——单次失败只做请求内跳备选
//（客户端已无感），保留账号侧「单次 5xx 不罚号」的防雪崩节奏（历史 issue #2：一次抖动
// 罚满冷却会把号池打空）；间隔超 60s 的失败不算连续。成功清零（noteChannelSuccess）
const channelFailStreaks = new Map(); // channel → { n, last }

/** 渠道连续失败计数（≥2 触发降级）；WAF/11128 渠道级拦截不走此计数（一锤定音直接降级） */
function noteChannelFail(channel) {
  const now = Date.now();
  const cur = channelFailStreaks.get(channel);
  const n = cur && now - cur.last < 60000 ? cur.n + 1 : 1;
  channelFailStreaks.set(channel, { n, last: now });
  return n;
}

/** 渠道降级时长：base × 2^streak 封顶 cap（settings 可调；cap 至少不低于 base） */
function degradeDuration(streak, settings) {
  const base = Number(settings && settings.channelCooldownMs) > 0 ? Number(settings.channelCooldownMs) : 120000;
  const cap = Number(settings && settings.channelCooldownCapMs) > 0 ? Number(settings.channelCooldownCapMs) : base * 8;
  return Math.min(base * Math.pow(2, Math.min(streak, 10)), Math.max(cap, base));
}

/** 渠道降级（半开 + 指数退避）：渠道耗尽 / 上游边缘拦截 / 全模型负缓存时整体让位备选渠道。
 *  streak 语义：同一波（并发请求同时打光，间隔 < 基础时长一半，产品默认 120s 下即 10s 内）
 *  只延不升级；30 分钟内的再次触发（半开探测再失败）streak+1 时长翻倍；超过 30 分钟重开。
 *  请求成功清零。until 与现存条目取 max——并发触发不能互相缩短冷却 */
function degradeChannel(channel, reason, settings) {
  const now = Date.now();
  const cur = channelHealth.get(channel);
  const wave = cur ? Math.min(10000, degradeDuration(0, settings) / 2) : 0;
  const gap = cur ? now - (cur.lastHit || 0) : Infinity;
  const streak = cur ? (gap < wave ? (cur.streak || 0) : gap < 30 * 60000 ? (cur.streak || 0) + 1 : 0) : 0;
  const until = Math.max((cur && cur.until) || 0, now + degradeDuration(streak, settings));
  const why = reason || (cur && cur.reason) || "";
  channelHealth.set(channel, { until, reason: why, streak, lastHit: now });
  events.emit({ type: "channel-health", channel, state: "degraded", until, reason: why, streak });
}

/** 渠道降级状态查询：到期只判过期不删条目（半开后 streak 还要用来翻倍），
 *  条目由 noteChannelSuccess（成功清零）覆盖更新；渠道数固定，无内存膨胀 */
function channelCooling(channel) {
  const hit = channelHealth.get(channel);
  if (!hit || hit.until <= Date.now()) return null;
  return hit;
}

/** 请求在该渠道真实成功 → 渠道恢复完全体（streak 一并清零，下次降级从基础时长重新开始） */
function noteChannelSuccess(channel) {
  if (!channel) return;
  channelFailStreaks.delete(channel);
  if (channelHealth.has(channel)) {
    channelHealth.delete(channel);
    events.emit({ type: "channel-health", channel, state: "ok" });
  }
}

/** 渠道健康快照（号池 IPC 与 /status 端点展示降级状态、原因与回切倒计时） */
function channelHealthSnapshot() {
  const now = Date.now();
  const out = {};
  for (const [ch, v] of channelHealth) {
    if (v.until > now) out[ch] = { until: v.until, reason: v.reason || "", streak: v.streak || 0 };
  }
  return out;
}

/** 按分类落冷却（账号级或账号×模型级）；429 优先对齐上游明示时间（墙钟/Retry-After），
 *  都没有时走有界指数退避；模型配置/参数/超长错误零动作不罚号 */
function applyCool(accId, model, cls, message) {
  if (!accId) return;
  // 参数/模型配置类错误与账号无关，不罚号也不记错；其余落冷却的错误都记入账号最近错误（号池气泡展示）
  // slow（首字节超时）同样不记错：它是"这次请求太大/上游这一刻慢"，记在账号上只会留下误导性的
  // 长期错误气泡（实测一次 54 万 token 请求超时，账号卡片挂了两天的"上游首字节超时"）
  // model_denied 默认也不记错：账号本身是好的，错的是「账号×模型」组合或模型名，用户从客户端
  // 就能看到该模型的拒绝原因，记到卡片只会误导。**但渠道级 model_denied 必须记**——Cline 403
  // 产品面校验失败（多为伪装头 X-CLIENT-TYPE 配置错）是配置故障，它不冷却账号，就只有靠
  // noteError 才看得见（与 11128/WAF 同理），否则「整池静默失效」而用户完全无感
  const silent =
    cls.kind === "model_config" ||
    cls.kind === "bad_params" ||
    cls.kind === "prompt_too_long" ||
    cls.kind === "slow" ||
    (cls.kind === "model_denied" && !cls.channelLevel);
  if (!silent && message) {
    store.noteError(accId, message);
  }
  switch (cls.kind) {
    case "model_config": // 4001 模型配置为空：模型问题不是账号问题，不罚号
    case "fatal": // HTTP 400 参数类：同一 body 换任何号都同错，冷却账号毫无意义（classifyUpstream 已置 switchable:false，链在调用侧终止）
    case "bad_params": // 11101：参数问题不罚号（换号仍会发生，由外层轮转决定）
    case "prompt_too_long": // 11115：同一 body 换任何号都超限，零动作
    case "slow": // 首字节超时：请求/上游侧的慢，账号本身没问题，零冷却（外层仍会换号重试）
    case "model_denied": // Cline 403（未订阅该模型/产品面校验）与 404（模型名不对）：
      // 确定性拒绝，冷却账号会把"换一个模型就能用"的账号无意义地静默跳过——
      // 零动作、如实透传（classifyError 已置 switchable:false，链在此终止不再换号）
      return;
    case "model_rate":
      pool.coolAccountModel(accId, model, cls.resetMs || Date.now() + 600000, message); // 6004：对齐墙钟优先，缺省 10min
      return;
    case "model_blocked":
      pool.coolAccountModel(accId, model, 6 * 3600000, message, { backoff: true, baseMs: 6 * 3600000, capMs: 24 * 3600000 }); // 11102：6h 起指数封顶 24h
      return;
    case "rate": {
      const until = cls.resetMs || (cls.retryAfterMs || 0) || (Date.now() + pool.softBackoffMs(accId));
      pool.coolAccountMs(accId, until, message);
      return;
    }
    case "not_found":
      pool.coolAccountMs(accId, Date.now() + 60000, message); // 404 短冷却不累计，防雪崩
      return;
    case "relogin":
      // 连续 3 次凭证失效才判废（参考项目 sessionDeadThreshold）；否则 60s 短冷却给重试机会
      if (pool.noteSessionDead(accId)) pool.coolAccount(accId, "relogin", `${message || "凭证失效"}（连续 3 次，请重新登录）`);
      else pool.coolAccountMs(accId, Date.now() + 60000, `${message || "凭证失效"}（短冷却重试）`);
      return;
    case "server": {
      // 5xx/网络：单次失败不冷却（只由外层轮转换号），连续 3 次才熔断（30m 指数封顶 6h）。
      // 参考项目语义（note_error 的 err_count 分支）：网络抖动/上游偶发 5xx 立即罚 10 分钟
      // 会把号池一次打空（实测：一次首字节超时 → 全渠道 503 直到手动解冷却）
      const until = pool.noteServerError(accId);
      if (until) pool.coolAccountMs(accId, until, message);
      return; // 未达熔断阈值：不罚号
    }
    default:
      pool.coolAccount(accId, cls.kind, message);
  }
}

/** 入站协议面：同一套调度核心，按端点换「怎么读网关 Key / 写成什么字节」。
 *  readKey 与 createSink 成对出现——鉴权失败的错误形状也必须按本协议回，
 *  否则 Claude Code 收到一个 OpenAI 形状的 401 会直接判连接失败。 */
const OPENAI_SURFACE = {
  name: "openai",
  createSink: openaiOut.create,
  readKey: (req) => ({ key: String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() }),
};
const ANTHROPIC_SURFACE = { name: "anthropic", createSink: anthropicOut.create, readKey: anthropicIn.readKey };
// Responses 入站的鉴权读法与 OpenAI 通路一致（Codex 走 Authorization: Bearer），复用同一个 readKey
const RESPONSES_SURFACE = { name: "responses", createSink: responsesOut.create, readKey: OPENAI_SURFACE.readKey };

/** chat/completions 主流程（stream 双态共用一套 emit → 出线或聚合）
 *  surface 只决定「这一串事件写成什么字节」：OpenAI / Anthropic / Responses 各一个工厂。
 *  下面的鉴权、别名、回退链、号池换号、冷却决策对所有协议共用同一份代码——
 *  这是当初定下「内部规范形 = OpenAI chat + emit 词汇不扩」的全部回报。 */
async function handleChat(req, res, settings, surface, convNotes) {
  const startedAt = Date.now();
  const reqId = util.uuid().replace(/-/g, "").slice(0, 24);
  const body = req.body || {};
  // wantStream 提前算：sink 要在鉴权之前建（鉴权失败也得按本协议的形状回错）。
  // body.stream 在此之前不会被改，所以与原先"晚算"完全等价。
  const wantStream = !!body.stream;
  // 出线侧（响应头 / SSE 帧 / 聚合器 / 思考链合批）整体交给协议 sink，本函数只留调度状态。
  // OpenAI 通路的逐字节等值由 scripts/dev-sink-golden.cjs 的场景表守着（响应字节 / 冷却决策 /
  // 选号顺序 / 流水），Anthropic 通路由 scripts/dev-anthropic-in-test.cjs 逐事件核验。
  // 入站 tokens 只能本地估（真分词在上游手里），只在拿不到 usage 时兜底。
  // 传函数而不是数值：只有 Messages 协议的 message_start 要用它，OpenAI 通路一次都不该
  // stringify 整个 messages（多模态请求上限 32MB，白算一次是看得见的开销）
  let estInputCache = null;
  const estInputTokens = () => {
    if (estInputCache == null) estInputCache = util.estimateTokens(JSON.stringify(body.messages || ""));
    return estInputCache;
  };
  const sink = surface.createSink({ res, reqId, requestedModel: String(body.model || ""), wantStream, estInputTokens });
  // convNotes：入站协议转换时的语义损失（thinking.signature 不回投、document 块丢弃、
  // hosted_tool 退化为 auto 等），由路由层从 toInternal() 取到后传进来。
  // 只进操作日志的 detail，**不落 usage_requests**——加列要走 DB 迁移，而这条信息的用途是
  // 「这次请求丢了什么」的排查线索，日志页本来就能查（issue #126 作者给的三个选项里选 op_logs）
  const usageRow = { ts: startedAt, reqId, keyId: "", keyName: "", channel: "", accountId: "", accountName: "", model: String(body.model || ""), status: 0, convNotes: Array.isArray(convNotes) ? convNotes.join(" | ").slice(0, 300) : "" };

  const record = (extra) => {
    usageRow.latencyMs = Date.now() - startedAt;
    Object.assign(usageRow, extra || {});
    store.insertUsage(usageRow);
    if (usageRow.accountId) store.bumpAccountUsage(usageRow.accountId, (usageRow.promptTokens || 0) + (usageRow.completionTokens || 0));
    emitRequestThrottled();
    // 操作日志：每条代理请求一条（成功 info / 4xx warn / 5xx+网络 error）；
    // detail 带上游错误轨迹，message 带模型与耗时——日志页直接看，不必翻 usage_requests
    // 转换损失（convNotes）一并挂进 detail：成功请求的 error 是空的，不拼在这里就无处可查，
    // 而「同样的对话官方能跑、走网关差一点」正是靠它归因（issue #126）
    const st = Number(usageRow.status) || 0;
    oplog.log(st >= 500 || st === 0 ? "error" : st >= 400 ? "warn" : "info", "代理请求",
      `${usageRow.model || "-"} · HTTP ${st || "-"} · ${usageRow.latencyMs}ms${usageRow.error ? " · " + String(usageRow.error).slice(0, 120) : ""}`,
      { channel: usageRow.channel, target: [usageRow.keyName, usageRow.accountName].filter(Boolean).join(" / "), detail: [usageRow.error, usageRow.convNotes].filter(Boolean).join(" · ") });
  };

  // ===== 鉴权：库中只存哈希，实时查表（启停/删除即时生效）。Key 从哪个头读由协议面定 =====
  const keyed = surface.readKey(req) || {};
  if (keyed.error) {
    record({ status: 401, error: "ambiguous_api_key" });
    return sink.endErr(401, keyed.error, "invalid_request_error", "invalid_api_key");
  }
  const key = keyed.key ? store.findKeyBySecret(keyed.key) : null;
  if (!key) {
    record({ status: 401, error: "invalid_api_key" });
    return sink.endErr(401, "无效的 API Key", "invalid_request_error", "invalid_api_key");
  }
  usageRow.keyId = key.id;
  usageRow.keyName = key.name;
  if (!key.enabled) {
    record({ status: 401, error: "key disabled" });
    return sink.endErr(401, "API Key 已停用", "invalid_request_error", "invalid_api_key");
  }
  // Key 级渠道/模型白名单（参考 agent2api apiKeys allowedProviders/allowedModels，空数组 = 不限制）：
  // 泄露影响面收敛的最小权限化措施。模型名按请求的对外模型名（body.model）判定，渠道判定在路由后。
  const keyAllowedModels = Array.isArray(key.allowedModels) ? key.allowedModels : [];
  const keyAllowedChannels = Array.isArray(key.allowedChannels) ? key.allowedChannels : [];
  if (keyAllowedModels.length && !keyAllowedModels.includes(String(body.model || "").toLowerCase())) {
    record({ status: 403, error: "model not allowed by key" });
    return sink.endErr(403, `该 API Key 不允许请求模型 "${body.model}"（allowedModels 白名单）`, "invalid_request_error", "model_not_allowed");
  }
  // 日配额（0=不限，次日 00:00 重置）
  if (key.dailyQuota > 0 && store.keyTodayReq(key.id) >= key.dailyQuota) {
    record({ status: 429, error: "daily quota exceeded" });
    return sink.endErr(429, "该 Key 今日配额已用尽（次日 00:00 重置）", "rate_limit_exceeded", "quota_exceeded");
  }
  // 单 Key 令牌桶限速
  if (!rateLimitOk(key, settings.rateLimitPerMin)) {
    record({ status: 429, error: "rate limited" });
    return sink.endErr(429, "请求过于频繁（单 Key 限速）", "rate_limit_exceeded", "rate_limited");
  }
  // 参数校验（本协议同构 400）；请求体上限 32MB 由 express.json 把关
  const bad = util.validateChatBody(body);
  if (bad) {
    record({ status: 400, error: bad });
    return sink.endErr(400, bad, "invalid_request_error", "invalid_params");
  }
  // 角色归一（issue #47）：各渠道上游 role 白名单互相冲突（workbuddy 拒 developer、
  // raccoon 拒 function），而 400 会触发渠道回退，导致同一条请求能否成功取决于命中
  // 哪个渠道。入口处统一收敛到所有渠道都接受的交集角色，避免逐渠道维护白名单表。
  util.normalizeRoles(body.messages);
  // 单渠道在途并发上限（settings.concurrency，默认 8）：只作**选路过滤器**用——满的渠道在
  // 候选队列里跳过先试备选，绝不在此对请求直接 429。旧实现是「runtime.active 全渠道共享一个
  // 计数」的全局闸门：渠道 A 打满会连带 429 渠道 B（哪怕 B 刚加、一个请求都没发过），且文案
  // 写成「上游并发已满」把责任推给上游——issue #106 的全部症状即来源于此，已改为按渠道计数
  const maxConc = Number(settings.concurrency) > 0 ? Math.floor(Number(settings.concurrency)) : 8;

  // ===== Dispatch：Key → 渠道（别名解析 → 模型禁用 → 回退链） =====
  const requestedModel = String(body.model);
  // 自定义模型映射（别名）：请求的模型名先过别名表得实际模型，路由/转发都用实际模型；
  // 客户端响应的 model 字段保持请求值（契约不变），记账备注标 alias→actual
  const aliased = (settings.modelAliases || {})[requestedModel];
  const actualModel = aliased && aliased !== requestedModel ? String(aliased) : requestedModel;
  // 禁用判定与 /v1/models 出口同口径（大小写不敏感）：出口过滤用 toLowerCase，
  // 入口若用大小写敏感的 includes，目录页登记小写名、客户端用变体大小写请求时会绕过入口直通上游
  const disabledSet = new Set((settings.disabledModels || []).map((s) => String(s).toLowerCase()));
  if (disabledSet.has(actualModel.toLowerCase())) {
    record({ status: 400, error: "model disabled" });
    return sink.endErr(400, `模型 "${actualModel}" 已被禁用（模型目录页可恢复）`, "invalid_request_error", "model_disabled");
  }
  // 模型回退链（多模型自动切换）：请求模型 → 回退模型（单跳防循环）。
  // 触发时机：① 模型不在任何渠道目录（unknown）；② 渠道号池全部不可用（耗尽/冷却）。
  // per-model 覆盖（旧配置兼容）优先，否则用全局统一回退模型（autoFallbackEnabled !== false 且已配置）。
  // 上游用实际命中模型转发，客户端响应的 model 字段保持请求值（契约不变）
  const modelChain = [actualModel];
  const perModel = (settings.modelFallback || {})[actualModel];
  const globalFb = settings.autoFallbackEnabled === false ? "" : String(settings.fallbackModel || "");
  const fallback = perModel || globalFb;
  // 回退模型自身被禁用时不入链（切过去也是 400，白费一跳），口径同上（大小写不敏感）
  if (fallback && fallback !== actualModel && fallback !== requestedModel && !disabledSet.has(fallback.toLowerCase())) {
    modelChain.push(fallback);
  }

  const resolvedMain = resolveChannel(key, actualModel, settings);
  if (!resolvedMain.channel && !fallback) {
    const hint = adapters.listableModels(settings).map((m) => m.id).join(", ");
    // 文案区分「渠道被上游启闭关闭」与「模型真不存在」（issue #90）：
    // 前者在合并目录里查得到、只是所有归属渠道都被关/空池，给出可操作指引
    const cat = adapters.mergedModels(settings).find((m) => String(m.id).toLowerCase() === actualModel.toLowerCase());
    if (resolvedMain.disabledChannel || cat) {
      const owners = (resolvedMain.disabledChannel ? [resolvedMain.disabledChannel] : (cat.sources || []))
        .filter((c, i, arr) => arr.indexOf(c) === i);
      record({ status: 400, error: "channel disabled" });
      return sink.endErr(
        400,
        `模型 "${actualModel}" 由渠道 ${owners.map((c) => `「${store.channelDisplay(c)}」`).join("、")}提供，` +
        `当前该渠道已被关闭或号池不可用，请在上游启闭中开启、补充号池，或改用其它模型。可用模型：${hint}`,
        "invalid_request_error", "channel_disabled"
      );
    }
    record({ status: 400, error: "unknown model" });
    // 名字记错（漏后缀/写简写）是最常见的误用：先给最接近的几个，再给全量列表。
    // 直接甩全量列表时用户对不上，会误判成「网关不支持这个模型」（issue #117）
    const similar = nearModelIds(actualModel, adapters.mergedModels(settings));
    return sink.endErr(
      400,
      `模型 "${actualModel}" 不在任何渠道目录中。` +
        (similar.length ? `相近的模型有：${similar.join("、")}。` : "") +
        `可用模型：${hint}`,
      "invalid_request_error", "model_not_found"
    );
  }

  // ===== 出线准备 =====
  // 会话元数据：轮内稳定（参考项目 ChatMeta——一次 user send 内的重试/换号复用同一
  // X-Conversation-Request-ID，上游后台按它聚合）；会话键按前 3 条消息指纹派生
  const chatMeta = {
    conversationRequestId: crypto.randomBytes(16).toString("hex"),
    conversationId: util.stableConvId(body.messages) || "",
    // 客户端原始请求头（只读引用）：部分渠道按头透传会话标识（AutoClaw 的 X-Session-Id 三头族），
    // 适配器按白名单取用，未列出的头一律不透传
    clientHeaders: req.headers,
  };
  const rt = runtime; // 捕获引用：stop() 会把 runtime 置 null，后续一律走 rt，finally 里直接碰 runtime 会 TypeError
  let keepAliveTimer = null;
  let ttftMs = 0;
  let lastUsage = null;
  let finishReason = "stop";
  let sentDelta = false; // 是否已向客户端出过内容（决定流中错误要不要写进 SSE）
  let streamErr = null;  // 流中 error 事件：出过内容时下发作罢；一条内容都没出过时按失败换号

  /**
   * 每次真实上游请求前重置「单轮尝试独占」的状态。
   * 这些变量都声明在换号循环与模型回退链之外，不重置就会让上一次尝试的输出混进本次：
   *  - agg（在 sink 里）：非流式换号重发时两个账号的正文拼进同一条 content（planLimit 分支曾在
   *    无条件 continue，完全不查出线状态，是最容易触发的一条路）；
   *  - reasoningBuf（在 sink 里）：尾段思考链跨尝试残留，客户端看到上一号的半截思考；
   *  - sentDelta / ttftMs：残留会让下一次尝试的"是否已出线"判定失真；
   *  - finishReason / lastUsage：残留会让本次以错误的 stop_reason 或上一号的 usage 收尾。
   * 流式已出线时不允许走到重发（见 planLimit 分支的 wantStream && sentDelta 短路），
   * 因为已 write 给客户端的半截正文无法撤回，重置也救不回拼接问题。
   */
  const resetAttemptState = () => {
    sink.resetAttempt();
    sentDelta = false;
    streamErr = null;
    finishReason = "stop";
    lastUsage = null;
    ttftMs = 0;
  };

  const emit = (ev) => {
    if (ev.type === "delta") {
      // sink 返回「客户端真正可消费的实质内容有没有出现过」：ttftMs 与 sentDelta 只能由它置位。
      // 噪声帧不计——既让统计页 TTFT 虚低，又会短路 catch 分支的 `sentDelta || ttftMs` 禁令、
      // 废掉换号自救的机会（判据在 protocols/openai-out.cjs 的 onDelta 里，与搬家前同一份）
      if (sink.onDelta(ev.delta)) {
        if (!ttftMs) ttftMs = Date.now() - startedAt;
        sentDelta = true;
      }
    } else if (ev.type === "usage") {
      lastUsage = ev.usage;
      sink.onUsage(ev.usage);
    } else if (ev.type === "finish") {
      if (ev.reason) finishReason = ev.reason;
      sink.onFinish(finishReason);
    } else if (ev.type === "error") {
      // 流中错误：注入 OpenAI 错误对象后仍发 [DONE]（幂等兜底，方案 §6.3）。
      // 但内容尚未开始时错误不下发——交给换号逻辑，换号成功客户端完全无感（防监测：不暴露多账号切换痕迹）。
      // 无论下没下发都要记账：没出过内容的 error 意味着本次尝试实质失败，不能伪装成 200 空响应
      streamErr = ev;
      sink.onStreamError(ev, { sent: sentDelta });
    }
  };

  try {
    // 在途计数在 try 内起算（issue #106 加固）：从起算到 finally 扣回之间任何一处抛错都有
    // finally 兜底，绝无「抛一次漏一个名额」——旧写法把 += 1 放在 try 之外 109 行处，那段
    // 一旦有人加了会抛的代码，泄漏满上限后网关就会对所有请求恒 429，只能重启
    rt.active += 1;
    sink.writeHead();
    // 15s keep-alive 注释行（防中间层回收，方案 §2.2 联调坑）；有真实输出时静默。
    // 清理放在外层 finally：循环体异常（DB 故障等）直接跳走时定时器也必须清，
    // 不然每 5 秒空转一次还阻止进程退出，随失败请求数累积
    let lastWrite = Date.now();
    keepAliveTimer = setInterval(() => {
      if (wantStream && Date.now() - lastWrite >= 15000) sink.keepAlive();
    }, 5000);
    const emitTimed = (ev) => {
      lastWrite = Date.now();
      emit(ev);
    };

    // ===== PoolService：号池选号，单请求最多换号 2 次（402/429/401 触发）；模型回退链外层 =====
    let done = false;
    let lastErr = null;
    let fatalErr = null;
    let usedModel = actualModel;
    // 成功收尾的 record() 在模型回退链之外，读不到链内声明的 targetModel；这里在链外承接
    // 「真正发给上游的模型名」供 record 记 rev→ 归因。链路一漏，每个成功请求都会在记账时抛
    // ReferenceError，被外层 catch 落成 502/0 token 的假流水（v1.30.0 起曾如此）。
    let usedTargetModel = actualModel;
    // 适配器内部改写后的「实际转发名」（Cline 短名补本池前缀）：**仅**用于记账 rev→ 归因。
    // 不能覆盖 usedTargetModel——后者还喂 pool.noteSuccess，其键须与 applyCool 的 targetModel
    // 同口径，否则「成功清负缓存」与「失败落冷却」会键不一致、负缓存残留
    let usedForwardModel = "";
    // 跨渠道故障转移的请求级状态：全局上游尝试预算 / 渠道轨迹 / failover 归因
    const maxTries = perModelUpstreamBudget(settings.channelFailover, settings.channelFailoverMax) * modelChain.length;
    // 每模型上游尝试预算（跨渠道共享；429 就地重试、401 刷新重试各计 1）：上限 ≤5 时恒为 6（与旧实现逐字节一致）；
    // 上限 6~10 时抬到「上限+1」——预算不随上限放大，设 10 也只有前 6 个渠道真被打到，新上限形同虚设。
    // 按模型链长度放大：预算按请求计但逐模型消耗，避免主模型耗尽预算后饿死回退模型
    let upstreamTries = 0;
    const triedChannels = []; // 本请求跳过或耗尽的渠道轨迹（最终错误消息用）：{ chan, accounts: string[], note?: string }
    // 轨迹同时记「渠道名」与该渠道实际用过的「账号名」（渲染时脱敏）。只报渠道名会让用户
    // 误判「我已经停用了这个账号怎么还在用」——渠道名 ≠ 账号名（issue #74 的困惑来源）
    let failoverFrom = "";    // 成功渠道 ≠ 主渠道时记录 failover:主→实（记账轨迹）
    let planLimitEnd = false; // planLimit（402）流中已出线的就地收尾：不是真成功，不清渠道降级态
    for (const chainModel of modelChain) {
      if (done || fatalErr) break;
      if (upstreamTries >= maxTries) break; // 上游尝试预算用尽：不再开新渠道/新模型
      const resolved = resolveChannel(key, chainModel, settings);
      if (!resolved.channel) {
        lastErr = Object.assign(new Error(`模型 "${chainModel}" 不在任何渠道目录中`), { status: 400 });
        continue; // 未知模型 → 尝试回退模型
      }
      usedModel = chainModel;
      if (chainModel !== actualModel) {
        // 明示模型回退（issue #90）：非流式用响应头；流式头已冲刷，改发 SSE 注释帧
        //（冒号开头，客户端按规范忽略，抓包/代理可见），不再完全静默
        try { res.setHeader("x-agenthub-fallback", `${actualModel} -> ${chainModel}`); } catch { /* 头已发出时忽略 */ }
        sink.comment(`fallback ${actualModel} -> ${chainModel}`);
      }
      // ===== 渠道候选队列（跨渠道故障转移）：主渠道尊重全部现有路由语义（单源强制 /
      // key.route / per-model 覆盖 / fixed / 生效档排序），备选 = 拥有该模型的其余渠道按
      // 生效档排序（score=综合分降序 / cost-first=成本档升序组内按分）。主渠道降级或耗尽时
      // 请求内直接跳备选（客户端无感），全部候选走完才报错。单渠道模型无备选可跳
      //（模型目录的物理边界，靠回退模型兜底）
      const owners = adapters.modelOwners(chainModel, settings).filter((c) => c !== resolved.channel);
      owners.sort(cmpByOrder(routeOrderOf(key, settings), tierGroups()));
      // Key 白名单过滤：allowedChannels 非空时，候选队列只留白名单内的渠道（主渠道 + 备选一起过）
      let queue = [resolved.channel, ...owners];
      if (keyAllowedChannels.length) {
        queue = queue.filter((c) => keyAllowedChannels.includes(String(c).toLowerCase()));
        if (!queue.length) {
          lastErr = Object.assign(
            new Error(`该 API Key 的 allowedChannels 白名单不含任何承载模型 "${chainModel}" 的渠道`),
            { status: 403 }
          );
          continue; // 尝试回退模型（白名单可能放行别的模型）
        }
      }
      queue.length = Math.min(
        queue.length,
        settings.channelFailover === false ? 1 : normalizeChannelFailoverMax(settings.channelFailoverMax)
      );
      const primaryChannel = queue[0];
      for (const chan of queue) {
        if (done || fatalErr) break;
        if (upstreamTries >= maxTries) break;
        // 渠道降级中（熔断窗口）：跳过不撞墙；每轮重查——备选可能在排队期间刚被并发请求打光降级
        const chCool = channelCooling(chan);
        if (chCool) {
          if (!lastErr) {
            lastErr = Object.assign(new Error(`渠道 ${chan} 降级中（${chCool.reason || "渠道级退避"}），${Math.ceil((chCool.until - Date.now()) / 1000)}s 后回切重试`), { status: 503 });
          }
          // 渠道级降级：根本没进号池，无账号可记。note 区分「降级中」与「号池空」——
          // 两者都不带账号名，但原因不同：把熔断报成「无可用账号」是同类歧义（issue #74）
          triedChannels.push({ chan, accounts: [], note: "渠道降级中" });
          continue;
        }
        // 单渠道在途已满：跳过先试备选（选路过滤，参考实现 routing::at_concurrency_limit 的语义）。
        // 全部候选都满时由链尾的 lastErr 汇总成 429 如实上报——绝不能像旧全局闸门那样在进入
        // 渠道解析之前就把请求 429 掉（issue #106：一个渠道打满连带拒绝所有其它渠道）
        const chanInflight = rt.activeByChannel.get(chan) || 0;
        if (chanInflight >= maxConc) {
          if (!lastErr) {
            lastErr = Object.assign(new Error(`渠道 ${chan} 在途并发已满（${chanInflight}/${maxConc}），请稍后重试`), { status: 429 });
          }
          triedChannels.push({ chan, accounts: [], note: `在途并发已满（${chanInflight}/${maxConc}）` });
          continue;
        }
        usageRow.channel = chan;
        // 反向映射：统一请求模型名 → 该渠道的实际模型名。没有可转发目标时跳过该渠道，
        // 绝不能把虚拟统一名原样发给上游（CatPaw 曾因此收到 AgentHub-1.0）。
        const revEntry = adapters.reverseAliasEntry(chainModel, settings);
        const mappedTarget = adapters.resolveModelTarget(chainModel, chan, settings);
        if (!mappedTarget && revEntry) {
          // 首错保留：前面渠道的真实上游错误比这里的映射提示更有价值（与其余跳过路径同口径）
          if (!lastErr) {
            lastErr = Object.assign(new Error(`渠道 ${chan} 未配置模型 "${chainModel}" 的反向映射`), { status: 400 });
          }
          triedChannels.push({ chan, accounts: [], note: "未配置反向映射" });
          continue;
        }
        // 非反向映射模型保留原有“指定渠道透传试错”语义（例如 fixed 路由下的未知模型）。
        const targetModel = mappedTarget || chainModel;
        usedTargetModel = targetModel; // 承接给链外 record()，见上面的声明注释
        const strategy = (store.listAgents().find((a) => a.id === chan) || {}).poolStrategy || "expire_first";
        const tried = new Set();
        const triedAccountNames = []; // 本渠道实际选中的账号名（最终错误文案用；去重保序）
        const rateRetried = new Set(); // 无明示时间的 429 同号退避重试标记（每号限一次）
        const transientRetried = new Map(); // 瞬时错误（5xx/网络/超时）同账号原地重发计数：accId → 已重发次数
        // 每账号并发租约：expire_first 排序与并发无关，同窗口并发会话否则全打同一账号（参考项目租约语义）
        const perAccountLimit = Number(settings.concurrencyPerAccount) > 0 ? Number(settings.concurrencyPerAccount) : 3;
        let poolEmpty = false; // 号池无可用账号（全冷却/耗尽/负缓存打光）
        let realTries = 0;     // 本渠道真实上游尝试次数（区分「打过但失败」与「没打就打光」）
        let modelCooledSkips = 0; // 负缓存跳过次数（6004/11102 是账号×模型粒度，不是渠道的错）
        let degradedHere = ""; // 本渠道已就地降级过（WAF/11128），耗尽判定不再重复降级
        let budgetOut = false; // 上游尝试预算用尽跳出（不是渠道的错，不降级）
        for (let attempt = 0; attempt <= 2 && !done; attempt++) {
          if (upstreamTries >= maxTries) { budgetOut = true; break; }
          const acc = pool.pickAccount(chan, strategy, [...tried], perAccountLimit, (settings.pinnedAccount || {})[chan]);
          if (!acc) { poolEmpty = true; break; }
          tried.add(acc.id);
          // 模型级负缓存（6004 模型级限流 / 11102 该号不支持此模型）：直接换号，不浪费一次上游请求。
          // 不计入换号次数（attempt--）：已 tried 集合单调增长，全 cooled 时 pickAccount 返回 null 自然 break，不会死循环。
          // 注意：负缓存跳过分支绝不能提前占用租约，否则未进请求 try/finally 导致在途计数永久泄漏死锁
          if (pool.isModelCooled(acc.id, targetModel)) {
            lastErr = Object.assign(new Error(`模型 "${targetModel}" 在该账号冷却中`), { status: 429 });
            modelCooledSkips++;
            attempt--;
            continue;
          }
          // 账号名进轨迹（去重）：用户据此确认「用的到底是哪个号」，不再被渠道名误导。
          // 必须在负缓存跳过之后收集——被模型级负缓存跳过的账号根本没发请求，
          // 记进「实际用过的账号」会让轨迹失真（用户以为它在跑，实际它在冷却）
          if (!triedAccountNames.includes(acc.name)) triedAccountNames.push(acc.name);
          pool.acquireAccount(acc.id);
          // 单渠道在途计数：从拿到租约到释放为止（与 finally 的 releaseAccount 同一生命周期，
          // 泄漏面与租约一致——release 不漏它就不漏）
          rt.activeByChannel.set(chan, (rt.activeByChannel.get(chan) || 0) + 1);
          upstreamTries++; // 全局上游尝试预算（负缓存跳过不计；429 就地重试走下一轮自然再计）
          realTries++;
          usageRow.accountId = acc.id;
          usageRow.accountName = acc.name;
          try {
            // 拟人抖动（方案 §9：不超单人使用强度的限速与随机抖动）：每次上游请求前随机停 40~220ms，
            // 把机器式的瞬时连发抹成真实客户端节奏，降低被上游风控识别为反代的概率
            if (settings.humanizeJitter !== false) {
              await new Promise((r) => setTimeout(r, 40 + Math.random() * 180));
            }
            let r = null;
            resetAttemptState(); // 上一次尝试的输出不得带进本轮（详见函数注释）
            // 自定义模型参数覆盖（modelCustom：上下文长度 / 最大输出 Token / 思考强度）
            const custom = (settings.modelCustom || {})[chainModel] || (settings.modelCustom || {})[targetModel] || null;
            let effectiveBody = body;
            if (custom && typeof custom === "object") {
              effectiveBody = { ...body };
              if (typeof custom.maxOutputTokens === "number" && custom.maxOutputTokens > 0) {
                effectiveBody.max_tokens = custom.maxOutputTokens;
                effectiveBody.max_completion_tokens = custom.maxOutputTokens;
              }
              if (typeof custom.contextLength === "number" && custom.contextLength > 0) {
                effectiveBody.prompt_max_tokens = custom.contextLength;
                effectiveBody.context_length = custom.contextLength;
              }
              if (custom.reasoningEffort) {
                if (custom.reasoningEffort === "off") {
                  effectiveBody.reasoning_effort = "off";
                  effectiveBody.thinking = { type: "disabled" };
                } else {
                  effectiveBody.reasoning_effort = custom.reasoningEffort;
                  effectiveBody.thinking = { type: "enabled" };
                }
              }
            }
            r = await attemptChat(chan, acc, targetModel, effectiveBody, emitTimed, chatMeta);
            // 适配器可能改写实际转发的模型名（Cline 短名补池前缀）：记入 usedForwardModel 供链外
            // record() 以 rev→ 呈现「请求 X 实际发 Y」（否则只有适配器内部知道，属静默改写）。
            // ⚠ 不能写 usedTargetModel——它同时喂 pool.noteSuccess，键须与冷却同口径
            if (r && r.model) usedForwardModel = r.model;
            if (r && r.planLimit) {
              pool.coolAccount(acc.id, "credit");
              lastErr = Object.assign(new Error("积分不足"), { status: 402 });
              // 积分耗尽常以流中 error 事件返回（trae 1005 / workbuddy 402），此时正文可能已出线。
              // 流式下换号重发会让客户端收到「半截旧答 + 完整新答」，就地收尾不再换号；
              // 非流式可以换，下一轮 attemptChat 前的 resetAttemptState 会重建 agg 防拼接
              if (wantStream && sentDelta) { done = true; planLimitEnd = true; break; }
              continue; // 换号
            }
            // 一条内容都没产出却收到过流中 error：本次尝试实质失败（上游业务错误），
            // 冷却换号重试，绝不能记 200 空响应
            if (!sentDelta && streamErr) {
              // 流内的渠道级拦截同样按渠道级降级处理（WAF 也可能在流中返回拦截页）
              if (isChannelBlock(streamErr)) {
                degradeChannel(chan, isWafBlock(streamErr) ? "WAF Block" : "渠道白名单 11128", settings);
                store.noteError(acc.id, String(streamErr.message || "渠道被上游边缘拦截"));
                lastErr = Object.assign(new Error(`渠道 ${chan} 被上游边缘拦截，已降级跳备选渠道`), { status: 503 });
                degradedHere = "block";
                streamErr = null;
                break;
              }
              lastErr = Object.assign(new Error(String(streamErr.message || "上游返回错误")), {
                status: streamErr.status || 502,
                code: streamErr.code || 0,
              });
              // 与 catch 路径（下方 classifyUpstream 后的 switchable 检查）同口径：
              // 确定性拒绝（prompt_too_long / fatal / model_denied）换号必白撞，
              // 流中路径也必须终止，否则客户端参数错误会逐个冷却全池账号
              const cls = classifyUpstream(lastErr, false, chan);
              humanizeAccountBlocked(lastErr, cls);
              applyCool(acc.id, targetModel, cls, lastErr.message);
              if (!cls.switchable) {
                fatalErr = lastErr;
                streamErr = null;
                break;
              }
              streamErr = null;
              continue;
            }
            done = true;
            if (chan !== primaryChannel) failoverFrom = primaryChannel; // 记账轨迹：实际走的是备选渠道
          } catch (e) {
            lastErr = e;
            // 已向客户端输出过内容：绝不能换号重发（客户端会收到「半截旧回答 + 完整新回答」拼接）。
            // 就地收尾，本轮以错误结束，由客户端下一次请求自然重试
            if (sentDelta || ttftMs) {
              fatalErr = Object.assign(new Error(`上游流已输出后中断：${String((e && e.message) || "未知错误").slice(0, 200)}`), { status: 502 });
              break;
            }
            // WAF Block / 渠道白名单 11128：渠道级故障——降级整个渠道（指数退避），不换号不罚号，跳备选继续
            if (isChannelBlock(e)) {
              degradeChannel(chan, isWafBlock(e) ? "WAF Block" : "渠道白名单 11128", settings);
              store.noteError(acc.id, String(e.message || "渠道被上游边缘拦截"));
              lastErr = Object.assign(
                new Error(`渠道 ${chan} 被上游边缘拦截（${isWafBlock(e) ? "WAF Block Page" : "渠道白名单 11128"}）：与账号无关，已跳备选渠道`),
                { status: 503 }
              );
              degradedHere = "block";
              break;
            }
            // 上游按客户端/渠道资格拒绝（渠道级，与账号无关）→ 跳备选渠道、不罚号、不同渠道换号重撞。
            // 三条落点都不能走：① 不是 fatal——fatal 会终止整条模型链，等于放弃自救；② 不能套
            // isChannelBlock——那是整渠道拉黑 120s 起，而这类拒绝按「模型×provider」发生，会误伤
            // 未被拒的模型；③ 不能只把 classifyUpstream 改成 switchable——那会在同渠道换号重撞同一扇门。
            // 也不罚号、不写账号错误气泡：账号与这次拒绝毫无关系。直接 break 出账号循环跳下一个候选。
            if (isClientGate(e)) {
              lastErr = Object.assign(
                new Error(`渠道 ${chan} 按客户端身份在渠道校验阶段被拒（与账号、提问内容无关，勿原样重发）：${String(e.message || "").slice(0, 120)}`),
                { status: 400 }
              );
              noteChannelFail(chan); // 计入既有「连续 2 次才降级」节奏，但不立刻拉黑整个渠道
              break;
            }
            if (e && e.fatal) {
              fatalErr = e; // 400 参数类等直接透传，不再换号也不回退
              break;
            }
            const cls = classifyUpstream(e, false, chan);
            humanizeAccountBlocked(e, cls);
            // 瞬时错误（5xx/网络/超时）同账号原地重发：先在这个账号上按配置次数重发吸收抖动，
            // 用尽才走换号。首字节超时（firstByteTimeout）虽是"慢"不是"账号故障"，
            // 但原地重发同一份 body 结果不会变（上游这一刻就是慢），故不重发、只换号（agent2api 同口径）。
            // 429 与 401 有专属动作（429 短退避重试 / 401 刷新凭证重试），不走本档（见下方各自分支）。
            if (cls.kind === "server" && !e.firstByteTimeout) {
              const maxSame = retrySameAccountCount(settings);
              const usedSame = transientRetried.get(acc.id) || 0;
              if (usedSame < maxSame) {
                transientRetried.set(acc.id, usedSame + 1);
                tried.delete(acc.id); // 允许重新选中本号
                attempt--; // 不消耗换号次数
                const delayMs = retrySameAccountIntervalMs(settings);
                oplog.log("warn", "代理重试",
                  `上游瞬时错误（${String((e && e.message) || "").slice(0, 80)}），${delayMs}ms 后同账号重发（第 ${usedSame + 1}/${maxSame} 次）`,
                  { channel: chan, target: acc.name });
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
              }
            }
            // 无明示重置时间的 429：上游多为 1~3s 短窗限流，退避 1s 重试一次再落冷却换号
            // （参考项目 RetrySame 语义）；有墙钟/Retry-After 的 429 重试必白费，直接冷却。
            // 单号池场景下这一跳决定 429 是就地消化还是直接抛给客户端
            if (cls.kind === "rate" && !cls.resetMs && !rateRetried.has(acc.id)) {
              rateRetried.add(acc.id);
              tried.delete(acc.id); // 允许重新选中本号（多号池防惊群可能让位别的号，同样不罚号）
              attempt--;
              await new Promise((r) => setTimeout(r, 1000));
              continue;
            }
            applyCool(acc.id, targetModel, cls, e.message);
            if (!cls.switchable) {
              fatalErr = e;
              break;
            }
          } finally {
            pool.releaseAccount(acc.id);
            rt.activeByChannel.set(chan, Math.max(0, (rt.activeByChannel.get(chan) || 0) - 1));
          }
        }
        // 渠道尝试结束仍未成功：连续 2 次「真实打过上游仍打光」才降级渠道（后续请求直接走
        // 备选）；单次失败只做了请求内跳备选（客户端已无感），不降级——保留账号侧「单次 5xx
        // 不罚号」的防雪崩节奏。纯本地打光（全冷却/耗尽/负缓存跳过）也不降级：号池状态是
        // 实时派生的（cooling 到期自动复活、新账号入池立即可用、负缓存只罚账号×模型），
        // 渠道级再缓存一份反而会把「已恢复」的渠道错误地挡在门外。
        // 预算用尽跳出与 WAF/11128 已就地降级的不重复处理
        if (!done && !fatalErr && !budgetOut) {
          triedChannels.push({ chan, accounts: triedAccountNames });
          if (!degradedHere && realTries > 0 && lastErr) {
            const cls = classifyUpstream(lastErr, false, chan);
            if (DEGRADABLE.has(cls.kind) && noteChannelFail(chan) >= 2) {
              degradeChannel(chan, String(lastErr.message || cls.kind).slice(0, 120), settings);
            }
          }
        }
      }
      // 当前模型渠道队列走完（含备选）→ 链到下一模型（lastErr 保留为最终错误）
    }

    if (done) {
      // 收尾：末 chunk 附 usage + [DONE]；无 done 事件也兜底结束（方案 §6.3）
      const usage = lastUsage || {
        prompt_tokens: util.estimateTokens(JSON.stringify(body.messages)),
        completion_tokens: util.estimateTokens(sink.aggregated().content),
        total_tokens: 0,
      };
      if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      sink.endOk(finishReason, usage);
      // 成功收尾：清软限流 streak / 凭证失效计数 / 该账号该模型的负缓存（键用 targetModel，
      // 与 applyCool/isModelCooled 同键）；渠道侧一并恢复完全体——planLimit 就地收尾（402 半截）
      // 不算真成功，不清渠道降级态（并发场景下会把别人刚熔断的渠道误放回来）
      pool.noteSuccess(usageRow.accountId, usedTargetModel);
      if (!planLimitEnd) noteChannelSuccess(usageRow.channel);
      // 上游 usage.credit 实际扣减余额（参考项目 NoteModelCost）：两次定时刷新之间
      // 余额不再虚高，「余额不足自动切换」更实时；无限额度哨兵(-1)与估算 usage 不扣
      const creditUsed = Number(usage.credit ?? usage.total_credit ?? 0) || 0;
      if (usageRow.accountId && creditUsed > 0) {
        const cur = store.getAccount(usageRow.accountId);
        if (cur && typeof cur.credits === "number" && cur.credits > 0) {
          store.updateAccount(usageRow.accountId, { credits: Math.max(0, cur.credits - creditUsed), creditsAt: Date.now() });
        }
      }
      // 记账轨迹：别名 / 跨渠道 failover / 模型回退 / 反向映射可同时发生，改为拼接而非互斥三目
      const errParts = [];
      if (actualModel !== requestedModel) errParts.push("alias→" + actualModel);
      if (failoverFrom) errParts.push(`failover:${failoverFrom}→${usageRow.channel}`);
      if (usedModel !== actualModel) errParts.push("fallback→" + usedModel);
      else if ((usedForwardModel || usedTargetModel) !== actualModel) errParts.push("rev→" + (usedForwardModel || usedTargetModel));
      // 已出线但流中报过错（截断 / 上游业务错误）：客户端拿到的是半截内容，必须在明细里留痕，
      // 否则这一行是一条看不出任何问题的绿 200（issue #107 正是被读成「上游只回 1 token」）
      if (streamErr) errParts.push(`notice:truncated:${String(streamErr.message || "流中错误").slice(0, 120)}`);
      // 上游 200 但一个 token 都没产出：只标注、不改判成功/失败（本机真实流水 id=63 就是这种行，
      // 用户与维护者都容易把它读成「正常回答」）——issue #78 的诊断增强
      if (Number(usage.completion_tokens) === 0) errParts.push("notice:empty-completion");
      record({
        status: 200, ttftMs, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
        // 缓存 token：OpenAI 语义取 prompt_tokens_details.cached_tokens，Anthropic 上游取 cache_read_input_tokens
        cacheReadTokens: (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) ?? usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? 0,
        error: errParts.join(" "),
      });
      return;
    }

    // 全部渠道/账号用尽：如实报错并带渠道轨迹（单请求尝试预算用尽时由 lastErr 消息如实说明）。
    // 轨迹形如 `qoder(账号A) → qoder_intl(无可用账号)`：渠道名后括号内是该渠道实际用过的账号名，
    // 空括号说明该渠道压根没进号池（降级中/无可用账号）——用户据此区分「停用的账号是否真被用了」
    const st = (lastErr && lastErr.status) || 503;
    // 并发满专用口径（issue #106）：全部候选都在途满时给聚合文案，而不是甩第一个渠道的 429。
    // 判据与文案见 concurrencyBlockedMessage()（纯函数，scripts/test-concurrency-message.cjs 守）
    const concMsg = concurrencyBlockedMessage(triedChannels, upstreamTries);
    const allConcBlocked = !!concMsg;
    let msg = st === 402 ? "该渠道号池积分全部耗尽" : (lastErr && lastErr.message) || "渠道暂不可用（号池无可用账号）";
    if (concMsg) msg = concMsg;
    const seenChan = new Map(); // chan → 轨迹项（同一渠道可能在多个模型上被尝试，账号名取并集）
    for (const t of triedChannels) {
      if (!t) continue;
      const prev = seenChan.get(t.chan);
      if (prev) {
        // 合并而非丢弃：模型链上有多个模型时，同一渠道的第二轮可能用了别的账号——
        // 只保留首次会让轨迹漏掉实际用过的号
        for (const a of t.accounts || []) if (a && !prev.accounts.includes(a)) prev.accounts.push(a);
        if (!prev.note && t.note) prev.note = t.note;
        continue;
      }
      seenChan.set(t.chan, { chan: t.chan, accounts: [...(t.accounts || [])], note: t.note });
    }
    const triedUnique = [...seenChan.values()].map((t) => {
      const accs = t.accounts.filter(Boolean).map(maskAccountName);
      // 空括号的含义由 note 区分：降级中（熔断，账号可能在线）vs 号池无可用账号。
      // 账号名一律脱敏——消息会回到 API 客户端并落日志，原样带邮箱等于外泄账号标识
      const label = accs.length ? accs.join(",") : t.note || "无可用账号";
      // cost-first 档给渠道名拼成本档后缀，一眼看出「为什么先试它」：
      // modelscope(免费·账*,*) → zcode(账*)；score 档不拼（用户没开成本感知，拼了反而困惑）
      const tierLabel = routeOrderOf(key, settings) === "cost-first"
        ? COST_TIER_LABELS[store.listAgents().find((a) => a.id === t.chan)?.costTier || "normal"] || ""
        : "";
      const parts = [tierLabel, label].filter(Boolean);
      return `${t.chan}(${parts.join("·")})`;
    });
    // 一个候选就失败时也要报渠道名与原因：只说「渠道暂不可用（号池无可用账号）」的话，
    // 用户只能去明细表里猜到底试了谁、为什么失败（issue #86）
    // 并发满的情况上面已给出专用文案（含逐渠道明细），不再套通用包装——「号池为空或降级中」
    // 这个措辞对「号池不空、也没降级，单纯在途打满」是不准确的，套上反而误导
    if (!allConcBlocked && triedUnique.length) msg = `已尝试 ${triedUnique.length} 个渠道（${triedUnique.join(" → ")}）均不可用：${msg}`;
    // 一次上游都没发过（号池空/降级被跳过）：明说——失败行的「渠道」列取的是最后到达的候选，
    // 不点明的话会被读成「用这个渠道发过请求」。判定用 upstreamTries 而不是轨迹里的账号名：
    // fatal（上游 400 透传）那条路径刻意不往轨迹里 push，用轨迹会误报「没发过请求」
    if (!allConcBlocked && !upstreamTries) msg = `未发起任何上游请求（候选渠道号池为空或降级中）：${msg}`;
    // AgentHub 请求 id 前缀：用户报障时直接引用它，就能在明细里定位到同一行（issue #78）。
    // 同时把上游的 code / request_id 落进记账（客户端消息会截断，长标识常被切掉）
    msg = `[ah:${String(reqId).slice(0, 8)}] ${msg}`;
    if (!wantStream || !ttftMs) {
      // 还没出过内容：流式且头已落地时仍要塞错误帧，否则回标准 JSON 错误状态
      if (wantStream && res.headersSent) sink.endErr(st, msg);
      else sink.endErr(st === 401 ? 502 : st, msg, st === 402 || st === 429 ? "rate_limit_exceeded" : "server_error");
    } else {
      sink.endErr(st, msg);
    }
    record({ status: st, ttftMs, error: [msg, upstreamRef(lastErr)].filter(Boolean).join(" · ").slice(0, 600) });
  } catch (e) {
    const msg = String((e && e.message) || e);
    sink.endErr(502, msg, "server_error");
    record({ status: 502, error: msg.slice(0, 200) });
  } finally {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (rt) rt.active -= 1; // rt 已随起算移入 try：起算前就抛错（如 stop 竞态）时无事可扣
  }
}

// ===== 服务生命周期 =====

function buildApp(settings) {
  const express = require("express");
  const app = express();
  // runtime 判空放在最前：服务停止期间到达的连接一律 503，绝不能打进 handler 碰空 runtime
  app.use((req, res, next) => {
    if (runtime) return next();
    sendError(res, 503, "网关服务已停止", "server_error", "service_stopped");
  });
  app.use(express.json({ limit: "32mb" })); // 方案 §6.9：单请求体上限 32MB（多模态 base64）

  app.post("/v1/chat/completions", (req, res) => handleChat(req, res, settings(), OPENAI_SURFACE).catch((e) => {
    if (!res.headersSent) sendError(res, 500, String((e && e.message) || e), "server_error");
  }));

  // Anthropic Messages 入口：入站归一成内部规范形后，与 chat 通路共用同一个 handleChat。
  // 归一失败按 Messages 的错误形状回（Claude Code 只认这个形状），而不是 OpenAI 的 400。
  // enableAnthropic 是紧急止血开关（默认开，只在 config.json 里给）：新协议面一旦把某个
  // 客户端卡住，关掉即回到「该端点不存在」，不必回滚代码也不必重新打包。
  app.post("/v1/messages", (req, res) => {
    if (settings().enableAnthropic === false) {
      res.status(404).json({ type: "error", error: { type: "not_found_error", message: "该网关未启用 /v1/messages" } });
      return undefined;
    }
    const r = anthropicIn.toInternal(req.body || {});
    if (!r.ok) {
      res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: r.message } });
      return undefined;
    }
    if (r.notes && r.notes.length) {
      // 转换中的语义损失（thinking.signature 不回投、document/图片 file 源丢弃等）必须留痕：
      // 用户看到的是"同样的对话在 Anthropic 官方能跑、走网关差一点"，无线索就无法归因。
      // 落两处：终端（本地调试直接看）+ 该请求的操作日志行 detail（界面可查，见 handleChat 的 record）
      console.warn(`[gateway] /v1/messages 转换损失: ${r.notes.join(" | ")}`);
    }
    req.body = r.body;
    return handleChat(req, res, settings(), ANTHROPIC_SURFACE, r.notes).catch((e) => {
      if (!res.headersSent) res.status(500).json({ type: "error", error: { type: "api_error", message: String((e && e.message) || e) } });
    });
  });

  // 官方文档把 count_tokens 列为可选（缺了客户端退化成字符估算）。这里用网关自己的
  // length/4 口径实现——与客户端兜底同量级，胜在 /status 与统计页能看到同一个数。
  app.post("/v1/messages/count_tokens", (req, res) => res.json(anthropicIn.countTokens(req.body || {})));

  // Responses 入口（Codex CLI）：Codex 已删除 wire_api="chat"，没有这一层就只能靠 CC Switch 翻译。
  // enableResponses 与 enableAnthropic 同性质——默认开的紧急止血开关，关掉即回到「该端点不存在」。
  app.post("/v1/responses", (req, res) => {
    if (settings().enableResponses === false) {
      res.status(404).json({ error: { message: "该网关未启用 /v1/responses", type: "not_found_error", param: null, code: null } });
      return undefined;
    }
    const r = responsesIn.toInternal(req.body || {});
    if (!r.ok) {
      res.status(400).json({ error: { message: r.message, type: "invalid_request_error", param: null, code: null } });
      return undefined;
    }
    if (r.notes && r.notes.length) {
      // 同 /v1/messages：终端与操作日志行 detail 各留一份
      console.warn(`[gateway] /v1/responses 转换损失: ${r.notes.join(" | ")}`);
    }
    req.body = r.body;
    return handleChat(req, res, settings(), RESPONSES_SURFACE, r.notes).catch((e) => {
      if (!res.headersSent) res.status(500).json({ error: { message: String((e && e.message) || e), type: "api_error", param: null, code: null } });
    });
  });

  // 模型目录：三渠道合并视图，鉴权可选（方案 §6.1）；停用模型不对外列出（调不通就不给看，省下游翻找）。
  // 「没有号池」的渠道（渠道被关 / 一个账号都没有）不对外列（issue #90）；
  // 有账号的渠道一律列出——cooling/额度耗尽/账号停用都只是暂时或主动不可用，
  // 模型保留展示、请求时拿到 503/402 明确文案，避免客户端模型列表整体闪没
  app.get("/v1/models", (_req, res) => {
    const st = settings();
    const aliveCache = new Map();
    // 「有没有号池」判定（issue #90）：只看渠道是否开启 + 池里是否有账号条目，
    // **刻意不判账号此刻能否出请求**（冷却 / 额度耗尽 / 过期 / 停用都仍算「有号池」）——
    // 这类暂时不可用保留展示，请求时给 503/402 明确文案，避免客户端模型列表整体闪没。
    // 注意与 routeUsable() 判据不同（后者服务于路由，要求「此刻真的出得了请求」）；
    // 两者口径不同是刻意的，切勿互相替换。
    const channelHasAnyAccount = (c) => {
      if (!aliveCache.has(c)) {
        aliveCache.set(c, adapters.channelOn(c, st) && pool.poolAccounts(c).length > 0);
      }
      return aliveCache.get(c);
    };
    res.json({ object: "list", data: adapters.listableModels(st).filter((m) => (m.sources || []).some(channelHasAnyAccount)) });
  });

  // 探活：无健康渠道时 503（只看启用渠道：全关时探活如实报不可用）
  app.get("/healthz", (_req, res) => {
    const healthy = store.CHANNELS.some((c) => adapters.channelOn(c.id) && pool.poolSummary(c.id).onlineCount > 0);
    res.status(healthy ? 200 : 503).json({ ok: healthy });
  });

  // 调试快照：默认关闭（设置里显式开启），且校验回环地址（方案 §6.7）
  app.get("/status", (req, res) => {
    const cfg = settings();
    const ip = req.socket.remoteAddress || "";
    if (!cfg.debugStatus || !/^127\.0\.0\.1$|^::1$|^::ffff:127\.0\.0\.1$/.test(ip)) {
      return res.status(404).json(util.openaiError("not found", "invalid_request_error", "not_found"));
    }
    res.json({
      uptime: runtime ? Date.now() - runtime.startedAt : 0,
      active: runtime ? runtime.active : 0,
      channels: store.CHANNELS.map((c) => pool.poolSummary(c.id)),
      channelHealth: channelHealthSnapshot(),
      today: store.statsToday(),
    });
  });

  // 兜底 404：OpenAI 同构
  app.use((_req, res) => res.status(404).json(util.openaiError("not found", "invalid_request_error", "not_found")));
  // express.json 的 413（超 32MB）/ JSON 解析失败也要回 OpenAI 同构错误，不能泄出 HTML 错误页
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 400;
    sendError(res, status, status === 413 ? "请求体超过 32MB 上限" : `请求体解析失败：${err.message}`, "invalid_request_error", status === 413 ? "payload_too_large" : "invalid_json");
  });
  return app;
}

/** 启动服务（settingsGetter 每次请求取最新配置 = 设置热生效；端口例外需重启监听） */
function start(settingsGetter) {
  if (runtime) return { ok: true, already: true, port: runtime.port };
  store.open();
  const s = settingsGetter();
  const app = buildApp(settingsGetter);
  return new Promise((resolve) => {
    const server = app.listen(s.port, s.bind, () => {
      // active：全局在途（状态页展示）；activeByChannel：单渠道在途（issue #106 选路过滤的依据）
      runtime = { server, startedAt: Date.now(), port: s.port, bind: s.bind, active: 0, activeByChannel: new Map() };
      resolve({ ok: true, port: s.port });
    });
    server.on("error", (e) => {
      resolve({ ok: false, message: `端口 ${s.port} 绑定失败：${e.code === "EADDRINUSE" ? "已被占用，请更换端口" : e.message}` });
    });
  });
}

function stop() {
  if (!runtime) return { ok: true };
  const r = runtime;
  runtime = null;
  try {
    r.server.closeAllConnections && r.server.closeAllConnections();
    r.server.close();
  } catch { /* 已关闭 */ }
  return { ok: true };
}

/** 停止并等监听完全释放（换端口/重启监听前调用，避免在途连接被 Reset 或新监听 EADDRINUSE） */
function stopAsync() {
  if (!runtime) return Promise.resolve({ ok: true });
  const r = runtime;
  runtime = null;
  return new Promise((resolve) => {
    try {
      r.server.closeAllConnections && r.server.closeAllConnections();
      r.server.close(() => resolve({ ok: true }));
      setTimeout(() => resolve({ ok: true }), 1000).unref(); // 兜底不阻塞
    } catch {
      resolve({ ok: true });
    }
  });
}

/** 优雅停机（容器 SIGTERM 专用）：先摘 runtime（服务停止期间到达的连接一律 503）→ 停收新连接
 *  （close 不毙在途）→ 等在途请求自然结束 → 超时才强制断开。stop()/stopAsync() 都立刻
 *  closeAllConnections，流式响应会被拦腰掐断——桌面重启路径需要那个语义，保持不动；只加不改。 */
function drainAndStop(opts) {
  if (!runtime) return Promise.resolve({ ok: true, drained: true, active: 0 });
  const r = runtime;
  runtime = null;
  const timeoutMs = Math.max(0, Number(opts && opts.timeoutMs) || 15000);
  const POLL_MS = 100; // 在途计数轮询：够密不漏过请求收尾，够疏不空转
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { r.server.closeAllConnections && r.server.closeAllConnections(); } catch { /* 已关 */ }
      resolve({ ok: true, drained: r.active <= 0, active: r.active });
    };
    try {
      r.server.close(() => finish()); // 回调 = 现存连接全部自然结束
    } catch {
      return finish();
    }
    const tick = () => {
      if (settled) return;
      if (r.active <= 0 || Date.now() >= deadline) return finish();
      setTimeout(tick, POLL_MS).unref();
    };
    tick();
  });
}

function status() {
  return {
    running: !!runtime,
    port: runtime ? runtime.port : 0,
    bind: runtime ? runtime.bind : "",
    uptime: runtime ? Date.now() - runtime.startedAt : 0,
    active: runtime ? runtime.active : 0,
  };
}

module.exports = { start, stop, stopAsync, drainAndStop, status, channelHealthSnapshot, classifyUpstream,
  // 成本感知路由纯函数（tools/proxy-cost-route-selftest.cjs / proxy-empty-pool-route-selftest.cjs 行为断言用）
  channelScore, costFirstScore, tierGroups, cmpByOrder, routeOrderOf, pickByOrder, routeUsable,
  // 故障转移规模纯函数（tools/proxy-failover-selftest.cjs 边界断言用）
  normalizeChannelFailoverMax, perModelUpstreamBudget,
  // 候选队列耗尽文案（scripts/test-concurrency-message.cjs 行为断言用）
  concurrencyBlockedMessage,
  // 模型名形近提示（scripts/test-model-hint.cjs 行为断言用）
  nearModelIds,
  // 瞬时错误原地重发纯函数（自测断言用）
  retrySameAccountCount, retrySameAccountIntervalMs };
