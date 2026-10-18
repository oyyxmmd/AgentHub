// 反代网关 · Cline 渠道适配器（cline_free / cline_pass 共用工厂）
//
// 两个池 = 两个独立渠道（同套实现、按池参数化，与 makeQoder / makeAutoClaw 同款）：
// 上游同域同协议同凭证，差别只有「收哪个池的模型」。把整份实现复制两份只为一个过滤条件，
// 会让凭证续期、错误分类、SSE 回写任何一处改动都要记得改两遍（参考实现同款取舍）。
//
// 协议层拆在本地目录：
//   credentials.cjs（workos: 前缀 + JWT 解析 + providers.json 读取）
//   login.cjs（WorkOS 设备授权四步） / models.cjs（归池 + 友好名归一）
//   balance.cjs（微 credit ÷1e6 + plan 404） / refresh.cjs（轮换 + 裸 JWT + ISO expiresAt）
//
// ── 上游协议要点（全部实测核对，2026-09 参考实现 agent2api）────────
//   - LLM：POST {apiBase}/chat/completions（完整路径 /api/v1/chat/completions，
//     路径只有一个 v1；发成 /api/v1/v1/... 是 404 Not Found）；
//   - 鉴权 Authorization: Bearer workos:<JWT>（前缀原样带，去掉 401）；
//   - X-CLIENT-TYPE: cline-sdk 是免费池**硬门槛**（缺它免费池一律 403
//     only available via Cline product surfaces）；
//   - stream:true → 裸 chat.completion.chunk 帧（与 OpenAI 逐字同形，直接透传不解包）；
//   - SSE 帧的 model 是上游内部名（请求 cline-free/x 回 deepseek/x）→ 必须回写为
//     客户端请求名，否则客户端会看到它没请求过的名字。
//
// ── 出站 body 的取舍（与参考实现的一处刻意偏离）──────────────────
// 参考实现照抄 cline-proxy 做**白名单重建**（固定键 + 白名单透传）。本实现只做
// 「透传 + 三处改写」：① model 补池前缀（models.resolveBodyModel，目录内匹配）；
// ② session_id 注入（官方 CLI 形态，与 X-Task-ID 同值）；③ reasoning_effort 归一
// （驼峰键翻译 + 缺失默认 high，追随参考实现两个独立来源的既有语义）。
// **不注入 max_tokens 默认值**：参考实现缺省注入 128000，但那不知道每个模型的实际输出
// 上限，注入超限值只会引入新的失败面——缺失时透传缺失，由上游按模型默认处理。
// 白名单重建同样不做：上游是 OpenAI 兼容网关，透传即可；重建漏字段才是真风险。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const credentials = require("./credentials.cjs");
const modelsMod = require("./models.cjs");
const balanceMod = require("./balance.cjs");
const refreshMod = require("./refresh.cjs");
const headersMod = require("./headers.cjs");

/** 默认思考档位（参考实现 cline-proxy 同值；官方 CLI 未显式给档时的默认形态） */
const DEFAULT_REASONING_EFFORT = "high";

/** 家族启发式（参考实现 context_window_for / reasoning_for 的回退口径）：
 *  目录里查不到的全新模型按 id 家族给窗口与思考开关，不写死一个数 */
function contextWindowHeuristic(id) {
  const name = String(id || "").toLowerCase();
  if (name.includes("deepseek-v4.1") || name.includes("1m") || name.includes("minimax") || name.includes("mimo")) return 1000000;
  if (name.includes("kimi") || name.includes("qwen3.8") || name.includes("glm-5")) return 256000;
  if (name.includes("claude") || name.includes("gpt-6") || name.includes("grok")) return 200000;
  return 128000;
}

/** 少数小模型没有 reasoning 输出（参考实现 reasoning_for 同口径） */
function reasoningHeuristic(id) {
  const name = String(id || "").toLowerCase();
  return !(name.includes("solar-pro4") || name.includes("flash-lite"));
}

/** 429 文案里的人话时长解析（参考实现 parseHumanDuration 移植）：
 *  "Try again in 17h 59m" / "1d 2h 30m" / "30s" 任意组合 → 毫秒；解析不出返回 0。
 *  免费额度撞限的真实冷却可达小时级，只按通用层的短退避会反复打无效请求。 */
function parseTryAgainMs(text) {
  const s = String(text || "");
  const marker = s.indexOf("Try again in");
  if (marker < 0) return 0;
  const rest = s.slice(marker + "Try again in".length);
  const end = rest.search(/["\n\r}]/);
  const seg = (end >= 0 ? rest.slice(0, end) : rest).trim();
  let total = 0;
  let num = 0;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch >= "0" && ch <= "9") { num = num * 10 + Number(ch); continue; }
    if (ch === "d") { total += num * 86400000; num = 0; continue; }
    if (ch === "h") { total += num * 3600000; num = 0; continue; }
    if (ch === "m" && seg[i + 1] === "s") { total += num; num = 0; i++; continue; }
    if (ch === "m") { total += num * 60000; num = 0; continue; }
    if (ch === "s") { total += num * 1000; num = 0; continue; }
    if (ch === " ") continue;
    num = 0; // 未知字符重置累积（半截 token 不算数）
  }
  return total > 0 ? total : 0;
}

/** 上游错误体 → 可读文案（{"error":"..."} 与 {"error":{"code":..,"message":..}} 都认） */
function upstreamMessage(body) {
  const text = String(body || "");
  try {
    const d = JSON.parse(text);
    if (d && d.error) {
      if (typeof d.error === "string" && d.error.trim()) return d.error.trim();
      if (typeof d.error === "object") {
        const msg = String(d.error.message || "").trim();
        if (msg) return msg;
      }
    }
  } catch { /* 非 JSON 用原文 */ }
  return text.slice(0, 200);
}

/**
 * 工厂：deps = { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs }
 * channel：cline_free（免费池）/ cline_pass（订阅池）；两池共用 headers.json 的 cline 段
 */
function makeCline(channel, deps) {
  const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs } = deps;
  const pool = channel === "cline_free" ? "free" : "pass";
  const cfg = () => (rules.get("headers.json") || {}).cline || {};

  // ===== 目录索引（catalog.json 对应渠道段，mtime 缓存；models 与 body 模型名归一共用）=====
  // at 初值 -1（mtimeMs 恒 ≥ 0）保证首次必读；判据**只看 mtime**、不看 entries.length——
  // 否则「该渠道目录段为空」时判据恒假，models() 每次调用都重复 stat + 读文件 + 解析
  let catalogCache = { at: -1, entries: [] };
  function catalogEntries() {
    const file = path.join(rules.rulesDir(), "catalog.json");
    let st = 0;
    try { st = fs.statSync(file).mtimeMs; } catch { /* 无缓存文件 */ }
    if (catalogCache.at === st) return catalogCache.entries;
    const all = (() => {
      try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 文件缺失/损坏 */ }
      // 回退内存态（rules.get 链路自带内置 DEFAULTS 兜底）：删掉规则文件时模型清单不该变空
      return rules.get("catalog.json") || {};
    })();
    const entry = all[channel];
    const entries = (entry && Array.isArray(entry.models) ? entry.models : []).filter((m) => m && m.id);
    catalogCache = { at: st, entries };
    return entries;
  }

  /** 伪装头统一走 headers.cjs（对话/登录/续期三处同一实现），见下方 chat/headers 的 buildUpstreamHeaders 调用 */

  return {
    id: channel,
    cfg,

    /** 目录接口**无需登录态**（recommended-models 实测无 Authorization 也 200）：
     *  据此放宽 proxy_models_sync 的「号池必须有可用账号」前置条件——
     *  用户可在导入任何账号前先同步模型目录（其余渠道不声明，仍按「需要」处理） */
    modelsNeedAuth: false,

    /** 凭据临期窗口（秒）：access 实测 1 小时（exp-iat=3600），窗口 10 分钟（1/6）。
     *  与其它渠道同口径写死（qoder 86400 / raccoon 300），配置层不再放一份防双源漂移 */
    refreshWindowSec: 600,

    /** 余额 0 不是硬门禁：上游允许余额记负（实测欠费 -0.02 仍可用），真实门禁是
     *  每日额度的 429（带重置时间）与订阅 403，都已由错误分类按账号处置。号池调度
     *  的「余额 0 → exhausted」与 routeUsable 同口径据此跳过本渠道——否则余额恒 0 的
     *  账号（store 入库层把舍入后的 0 与 < -1 负值都归 0）会被锁死在调度外且永不复活 */
    zeroBalanceUsable: true,

    /** 模型 id 清单（带池前缀的完整上游 id；目录未就绪时为空数组——rules 默认值已含静态兜底） */
    models() {
      return catalogEntries().map((m) => String(m.id));
    },

    /** 拉取官方目录（GET {apiBase}{modelsPath}，**无需鉴权**实测）→ 只回本池那一批。
     *  归池按响应分组（models.parseRecommended），cllineCloud 不收录（实测 403）。 */
    async fetchModels() {
      const c = cfg();
      const base = String(c.apiBase || "https://api.cline.bot/api/v1").replace(/\/+$/, "");
      const r = await httpJson(`${base}${c.modelsPath || "/ai/cline/recommended-models"}`, {
        method: "GET",
        // 伪装头走唯一实现（headers.json upstreamHeaders 覆盖层），与对话/登录/续期同一口径
        headers: headersMod.buildUpstreamHeaders(c, { accept: "application/json" }),
      }).catch((e) => ({ status: 0, ok: false, data: null, message: String((e && e.message) || e) }));
      if (!r.ok || !r.data) return { ok: false, message: `模型目录 HTTP ${r.status}${r.message ? `：${r.message}` : ""}` };
      const parsed = modelsMod.filterByPool(modelsMod.parseRecommended(r.data), pool);
      if (!parsed.length) return { ok: false, message: "模型目录为空（响应里没有本池可用模型）" };
      const models = parsed.map((m) => {
        // 元数据继承（先查表再启发式，与参考实现同款两段式）：上游目录不回传元数据，
        // 硬编码 capabilities/0 会让「远程与静态两条路径给出不同的数」——同步后
        // solar-pro4 的思考开关从 false 跳 true、全部上下文长度归 0（刷新前后跳变）
        const hit = catalogEntries().find((e) => String(e.id || "").toLowerCase() === m.id.toLowerCase());
        const caps = hit && hit.capabilities && typeof hit.capabilities === "object"
          ? { images: hit.capabilities.images !== false, reasoning: hit.capabilities.reasoning !== false, tools: hit.capabilities.tools !== false }
          : { images: true, reasoning: reasoningHeuristic(m.id), tools: true };
        const ctx = hit && Number(hit.contextLength) > 0 ? Number(hit.contextLength) : contextWindowHeuristic(m.id);
        return { id: m.id, name: m.name, rate: null, capabilities: caps, contextLength: ctx, maxOutputTokens: 0 };
      });
      return { ok: true, models };
    },

    /** 非会话语义：标准 OpenAI 兼容单发请求 */
    headers() {
      const c = cfg();
      return headersMod.buildUpstreamHeaders(c, { "content-type": "application/json", accept: "text/event-stream" });
    },

    /**
     * 出站 body 改写（透传 + 三处；深拷贝后改写——渠道回退链复用同一个 body 对象）。
     * 返回 { body, sessionId }：sessionId 供 chat 出 X-Task-ID（与 body.session_id 同值）。
     */
    rewriteBody(model, body) {
      const out = structuredClone(body || {});
      out.model = modelsMod.resolveBodyModel(model, catalogEntries(), pool);
      // 官方 CLI 形态：每请求生成会话标识（sess_<毫秒>），body 与 X-Task-ID 同值
      const sessionId = `sess_${Date.now()}`;
      out.session_id = sessionId;
      // reasoning_effort：客户端 snake_case 优先，驼峰 reasoningEffort 也认（上行统一 snake）；
      // 都没给时注入默认 high（参考实现两来源同值；贴近官方客户端形态，无失败面）
      const effort = [out.reasoning_effort, out.reasoningEffort]
        .map((v) => String(v == null ? "" : v).trim())
        .find((v) => v) || DEFAULT_REASONING_EFFORT;
      out.reasoning_effort = effort;
      delete out.reasoningEffort;
      // max_tokens ≤ 0 按缺失处理（对齐参考 adapter.rs：0/负数不算显式小值，对上游只会是
      // 参数错误）；保留「缺失时透传缺失」的既有取舍（本适配器刻意不注入默认值）
      if (Number(out.max_tokens) <= 0) delete out.max_tokens;
      return { body: out, sessionId };
    },

    /** 对话主流程：标准 OpenAI 兼容 SSE（裸 chat.completion.chunk 帧透传 + model 回写）。 */
    async chat({ account, secrets, model, body, emit }) {
      const c = cfg();
      const token = credentials.ensureTokenPrefix(secrets && secrets.token);
      if (!token) throw Object.assign(new Error("该账号没有凭据"), { status: 401 });
      const base = String(c.apiBase || "https://api.cline.bot/api/v1").replace(/\/+$/, "");
      const { body: out, sessionId } = this.rewriteBody(model, body);
      const headers = headersMod.buildUpstreamHeaders(c, {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
        // 任务标识：与 body 的 session_id 同值（官方 CLI 形态）
        "x-task-id": sessionId,
      });

      let resp = null;
      let cancelTimer = () => {};
      // model 回传实际转发名（短名已补本池前缀）：server 侧据此记账 rev→，让
      // 「请求 X 实际发 Y」在用量明细里可见——此前只有适配器内部知道，属静默改写
      const result = { status: 200, model: out.model };
      let sentDelta = false;
      // 首字节预算按 prompt 规模给；首事件到达即解除（见下面 pumpSse 回调第一行）
      const payload = JSON.stringify({ ...out, stream: true });
      try {
        const r = await fetchStream(`${base}/chat/completions`, {
          method: "POST",
          headers,
          body: payload,
          firstByteMs: firstByteBudgetMs(payload),
        });
        resp = r.resp;
        cancelTimer = r.cancelTimer;
      } catch (e) {
        // 404 的最常见形态是模型名不对（路径只有一个 v1，发错路径也是 404）：附加可执行提示
        if (e && e.status === 404 && !/模型名不对/.test(String(e.message || ""))) {
          e.message = `${e.message}（Cline 的 404 多为模型 id 不对：请用带池前缀的完整 id，或选目录里的模型）`;
        }
        throw e;
      }
      let settled = false;
      try {
        await pumpSse(resp, (_event, raw) => {
          // 首个 SSE 事件到达 = 首字节达标，必须**立刻**解除首字节预算计时器：漏这一步会让
          // 计时器在整个流期间一直武装，到点 abort 掉 resp.body，把一条正常的长回答掐成
          // 「HTTP 200 + 半截内容」（issue #107 的根因，其余渠道都在首事件里这么做）
          if (!settled) { settled = true; cancelTimer(); }
          if (!raw) return;
          if (raw === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
          let chunk = null;
          try { chunk = JSON.parse(raw); } catch { return; }
          if (!chunk || typeof chunk !== "object") return;
          if (chunk.error) {
            const msg = String((chunk.error && (chunk.error.message || chunk.error.code)) || "上游返回错误");
            emit({ type: "error", status: 502, code: chunk.error.code, message: msg });
            return;
          }
          // 响应帧 model 回写为客户端请求名（上游回的是承载模型的内部 slug，会暴露内部命名）
          if (chunk.model) chunk.model = String(model || "");
          const choice = Array.isArray(chunk.choices) && chunk.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) {
              if (util.hasConsumableDelta(choice.delta)) sentDelta = true;
              emit({ type: "delta", delta: choice.delta });
            }
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (chunk.usage) {
            emit({
              type: "usage",
              usage: {
                ...chunk.usage,
                prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
                completion_tokens: Number(chunk.usage.completion_tokens) || 0,
                total_tokens: Number(chunk.usage.total_tokens) || 0,
              },
            });
          }
        });
      } catch (e) {
        // 流中断：已出内容则如实上报，未出内容交给外层换号
        if (sentDelta) {
          emit({ type: "error", status: 502, message: `流中断：${String((e && e.message) || e).slice(0, 120)}` });
          return result;
        }
        throw e;
      } finally {
        cancelTimer();
      }
      return result;
    },

    /** 余额（微 credit ÷1e6 + plan 404 正常态，见 balance.cjs）。 */
    async queryCredits(account, secrets) {
      const c = cfg();
      const token = credentials.ensureTokenPrefix(secrets && secrets.token);
      if (!token) return { authError: true, message: "该账号没有凭据" };
      try {
        return await balanceMod.queryBalance({
          cfg: c,
          token,
          httpJson,
          // uid 已在导入/登录时解析为 usr-...（外部 id）；没有时从 JWT 兜底
          userId: String((account && account.uid) || ""),
          jwtAccountId: credentials.accountIdFromJwt(secrets && secrets.token),
          parseExpiresAt: credentials.parseExpiresAt,
        });
      } catch (e) {
        if (e && e.authError) return { authError: true, message: e.message };
        return { error: String((e && e.message) || e) };
      }
    },

    /** 续期（轮换 + 裸 JWT 补前缀；single-flight 由 refreshTokenLocked 提供）。 */
    async refreshToken(account, secrets) {
      const c = cfg();
      const r = await refreshMod.refreshToken({
        cfg: c,
        token: credentials.ensureTokenPrefix(secrets && secrets.token),
        refreshToken: String((secrets && secrets.refreshToken) || ""),
        httpJson,
      });
      if (!r.ok) return r;
      return { ok: true, token: r.token, refreshToken: r.refreshToken, expiresAt: r.expiresAt || 0 };
    },

    /** Cline 上游无签到/奖励活动：如实回报「不适用」（与 CatPaw 同口径，前端不渲染入口）。 */
    async checkin() {
      return { ok: true, unavailable: true, checkedIn: false, message: "Cline 无签到活动，无需操作" };
    },
    async checkinStatus() {
      return { ok: true, unavailable: true, message: "Cline 无签到活动，无需操作" };
    },

    /**
     * 渠道私有错误分类（server.js 的 classifyUpstream 入口，返回非空即走本分类）：
     *   - 403：**不是限额** —— 两种语义都归 model_denied（不罚号、不记错、终止链），
     *     但**文案必须区分**，否则用户只拿到一句上游原文、无从定位：
     *       ① ENTITLEMENT_ERROR（该账号未订阅该模型）：换账号同样失败，换模型即可；
     *       ② only available via Cline product surfaces / not a supported client：
     *          **渠道级**产品面校验失败——最常见成因是 headers.json 的 X-CLIENT-TYPE
     *          伪装头被删/改空（它是免费池的**硬门槛**，方案 §3），此时整池都会 403。
     *     ⚠ 两类都保持 switchable:false（方案 §8：403 一律不重试）——渠道级也**不降级不冷却**：
     *       降级/冷却救不了配置错误，只会把「改一行配置就能修」变成「静默跳过」。
     *   - 404 model not found：模型名不对，同样 model_denied（换账号无用）；
     *   - 429：真限流 → rate；错误文案带人话时长（"Try again in 17h 59m"）→ 解析成
     *     恢复墙钟填 resetMs（免费额度撞限的真实冷却可达小时级）；
     *   - 401 与其余状态不拦截（走通用层：401 → relogin 刷新重试 / 5xx → server）。
     */
    classifyError(e) {
      const status = Number(e && e.status) || 0;
      if (status === 403) {
        const msg = upstreamMessage(e.body || e.message);
        // 渠道级产品面校验（整池命中）与账号×模型无权限（换模型即可）要给不同的可操作提示：
        // 前者最常见成因是伪装头 X-CLIENT-TYPE 被删/改空，不提示则「整池静默失效」而用户无感
        const channelLevel = /product surfaces|not a supported client|unapproved (channel|client)/i.test(msg);
        return {
          kind: "model_denied",
          switchable: false,
          status: 403,
          // channelLevel 供 server 侧决定是否记入账号错误：渠道级故障（配置问题）需要可见，
          // 账号×模型的确定性拒绝不需要（用户从客户端就能看到，记到卡片只会误导）
          channelLevel,
          message: channelLevel
            ? `${msg}（疑似渠道级产品面校验失败：请检查 headers.json 的 X-CLIENT-TYPE 伪装头是否被删或改空——它是 Cline 免费池的硬门槛）`
            : msg,
        };
      }
      if (status === 404) {
        return { kind: "model_denied", switchable: false, status: 404, message: upstreamMessage(e.body || e.message) };
      }
      if (status === 429) {
        const ms = parseTryAgainMs(`${e.body || ""} ${e.message || ""}`);
        // 文案解析不出时接住 fetchStream 已解析的 Retry-After 三头族（通用层同款兜底）：
        // 不接住的话 resetMs=0 会先白打一次 1s 就地重试，再落 softBackoff 短冷却，墙钟对齐失效
        return { kind: "rate", switchable: true, status: 429, resetMs: ms > 0 ? Date.now() + ms : (Number(e.retryAfterMs) > 0 ? Date.now() + Number(e.retryAfterMs) : 0) };
      }
      return null;
    },
  };
}

module.exports = { makeCline, parseTryAgainMs, DEFAULT_REASONING_EFFORT };
