// 反代网关 · 生态接入「直连模式」：不经 CC Switch，直接写各客户端自己的配置文件。
//
// 为什么可以直连：网关已原生实现三个协议面（见 server.cjs）——
//   · POST /v1/messages   Anthropic Messages（Claude Code / Claude Desktop 3P）
//   · POST /v1/responses  OpenAI Responses（Codex，wire_api 必须是 responses）
//   · POST /v1/chat/completions
// 协议翻译在网关内部完成，客户端填一个 Base URL 即可，不需要中间的 CC Switch 本地代理。
//
// 三个应用的落点（本机实测 2026-10-18）：
//   ① Claude Code：~/.claude/settings.json 的 env.*（只写模型与 baseURL/token，保留用户其它键）
//   ② Codex（CLI 与桌面端共用）：$CODEX_HOME|~/.codex 下的
//        config.toml（顶层 model_provider/model + [model_providers.<name>] 段）
//        auth.json（OPENAI_API_KEY）
//        model-catalog.json（模型目录：不给它，Codex 对自定义模型只按回退元数据跑，
//          每次启动都警告「metadata not found」；给了它，条目里的指令模板会**顶替**内置系统提示，
//          所以条目必须从一个可用的内置条目克隆，见 buildCodexCatalog）
//   ③ Claude Desktop：<userData>/configLibrary/<profileId>.json + _meta.json 的 appliedId，
//      inferenceProvider="gateway" + inferenceGatewayBaseUrl 直接指向网关。
//      ⚠ Desktop 的模型名校验（逆向 app.asar）：
//         jo(provider, model.name) 第一行 GSe.test(name) 直接放行，
//         GSe = /^(sonnet|opus|haiku|fable|mythos)(-[\d.]+)?$/。
//         校验只认 name；labelOverride 是纯展示名。故 name 用角色形态（sonnet-4-5），
//         labelOverride 填真实上游模型名（glm-5.3），菜单显示真实模型、请求也能路由。
//
// 写入纪律（照抄 zcodeSwitch/ideswitch 的成熟做法）：
//   预检(只读) → 两段式确认 → 时间戳备份(失败即中止) → 合并式写入(只动自己的键)
//   → 原子写 → 写后回读校验 → 失败自动回滚 → 提供 restoreLatest 手动逃生
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const config = require("../config.cjs");
const util = require("./util.cjs");

// ===== 常量 =====

/** 支持的直连应用 */
const DIRECT_APPS = ["claude", "claude-desktop", "codex"];

/** Codex provider 段名（与 CC Switch 的 custom 分开，便于识别归属） */
const CODEX_PROVIDER_ID = "agenthub";
/** Claude Desktop 自建 profile 的固定 id（UUID 形态，与 CC Switch 的 profile 并存不冲突） */
const DESKTOP_PROFILE_ID = "a6e1b7c2-4d3f-4a58-9e21-7b5c8d0f1a34";
const DESKTOP_PROFILE_NAME = "AgentHub 直连";
/** Codex model catalog 文件名（自建，不抢 CC Switch 的 cc-switch-model-catalog.json） */
const CODEX_CATALOG_FILE = "agenthub-model-catalog.json";
/** 克隆指令模板时优先挑的模型：偏通用的编码模型，措辞与自定义上游最接近 */
const CODEX_CLONE_PREFER = ["gpt-5.5", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol"];

/** Desktop 四档角色名：必须匹配客户端校验正则 (sonnet|opus|haiku|fable|mythos)(-数字)。
 *  同时这些名字会被登记进网关 modelAliases（见 applyDesktopAliases）——客户端发的是
 *  角色名，网关按别名表映射回真实模型；不登记会得到 400「不在任何渠道目录中」。 */
const DESKTOP_TIER_NAMES = {
  sonnet: "sonnet-4-5",
  opus: "opus-4-5",
  haiku: "haiku-4-5",
  subagent: "fable-4-5", // 第四档在 Desktop 叫 fable
};

/** Claude Code 四档 env 键（与 ccswitch.cjs 同口径：*_MODEL 存真实模型，*_MODEL_NAME 只展示） */
const CC_TIER_KEYS = {
  sonnet: ["ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"],
  opus: ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"],
  haiku: ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"],
  subagent: ["CLAUDE_CODE_SUBAGENT_MODEL"],
};

// ===== 平台路径 =====

/** 用户主目录下的点目录（三平台一致） */
function homePath(...segs) {
  return path.join(os.homedir(), ...segs);
}

/** Electron userData 类目录：Windows %APPDATA%，macOS ~/Library/Application Support，Linux ~/.config */
function userDataRoot() {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  if (process.platform === "linux") return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(os.homedir(), "AppData", "Roaming");
}

/** Codex 配置根：尊重 $CODEX_HOME（CLI 与桌面端都认这个变量） */
function codexHome() {
  const env = process.env.CODEX_HOME;
  if (env && String(env).trim()) return String(env).trim();
  return homePath(".codex");
}

/** 各应用要写的文件清单（供状态展示与写入） */
function targetsOf(appType) {
  if (appType === "claude") {
    return { files: [homePath(".claude", "settings.json")] };
  }
  if (appType === "codex") {
    const root = codexHome();
    return { files: [path.join(root, "config.toml"), path.join(root, "auth.json"), path.join(root, CODEX_CATALOG_FILE)] };
  }
  if (appType === "claude-desktop") {
    const lib = path.join(userDataRoot(), "Claude-3p", "configLibrary");
    return { files: [path.join(lib, `${DESKTOP_PROFILE_ID}.json`), path.join(lib, "_meta.json")] };
  }
  return { files: [] };
}

/** 网关 base（无尾斜杠）。Claude/Desktop 用裸 origin，Codex 要 /v1 */
function gatewayBase(port) {
  return `http://127.0.0.1:${Number(port) || 9527}`;
}

// ===== 文件安全写入 =====

/** 写前时间戳备份到 dataDir/proxy/direct-backup/<app>/<ts>/，失败抛错（调用方中止写入） */
function backupFiles(appType, files) {
  const dir = path.join(config.dataDir(), "proxy", "direct-backup", appType, String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const dest = path.join(dir, path.basename(f));
    fs.copyFileSync(f, dest);
    saved.push({ from: f, to: dest });
  }
  // 滚动：只留最近 5 份（按目录名时间戳排序）
  try {
    const root = path.join(config.dataDir(), "proxy", "direct-backup", appType);
    const dirs = fs.readdirSync(root).filter((n) => /^\d+$/.test(n)).sort();
    while (dirs.length > 5) {
      const old = dirs.shift();
      fs.rmSync(path.join(root, old), { recursive: true, force: true });
    }
  } catch { /* 轮换失败不影响本次写入 */ }
  return { dir, saved };
}

/** 原子写：tmp.<pid> + fsync + rename；凭据文件 0600 */
function writeAtomic(file, content, opts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  const mode = opts && opts.secret ? 0o600 : undefined;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeSync(fd, content);
    try { fs.fsyncSync(fd); } catch { /* 部分平台不支持 */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// ===== 各应用「当前指向」探测 =====

/** 网关端口判据：与 ccswitch.classifyLiveTarget 同口径 */
function isGatewayUrl(raw, port) {
  const url = String(raw || "").trim().replace(/\/+$/, "");
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    const local = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    const p = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    return local && p === Number(port);
  } catch {
    return false;
  }
}

/** CC Switch 本地代理端口（出现即说明被它接管，直连写入会被覆盖） */
const CCS_PROXY_PORT = 15721;
function isCcSwitchUrl(raw) {
  const url = String(raw || "").trim().replace(/\/+$/, "");
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    const local = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    return local && (Number(u.port) || 0) === CCS_PROXY_PORT;
  } catch {
    return false;
  }
}

/** 读 Claude Code 当前 env（失败返回 {}） */
function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(homePath(".claude", "settings.json"), "utf8")) || {};
  } catch {
    return null;
  }
}

/** 读 Codex config.toml 里当前 provider 的 base_url（文本级，不解析 TOML） */
function readCodexRouting() {
  try {
    const toml = fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8");
    const cur = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(toml);
    if (!cur) return { provider: "", url: "" };
    const esc = cur[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sec = new RegExp(`\\[\\s*model_providers\\.${esc}\\s*\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(toml);
    const url = sec ? ((/^\s*base_url\s*=\s*"([^"]+)"/m.exec(sec[1]) || [])[1] || "") : "";
    return { provider: cur[1], url };
  } catch {
    return { provider: "", url: "" };
  }
}

/** 读 Claude Desktop 当前 applied profile 的 base url */
function readDesktopRouting() {
  const lib = path.join(userDataRoot(), "Claude-3p", "configLibrary");
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(lib, "_meta.json"), "utf8"));
    const id = String((meta && meta.appliedId) || "");
    if (!id) return { profileId: "", name: "", url: "" };
    const prof = JSON.parse(fs.readFileSync(path.join(lib, `${id}.json`), "utf8"));
    const entry = (meta.entries || []).find((e) => e && e.id === id);
    return { profileId: id, name: String((entry && entry.name) || ""), url: String(prof.inferenceGatewayBaseUrl || "") };
  } catch {
    return { profileId: "", name: "", url: "" };
  }
}

// ===== 合并式内容构造 =====

// ===== 上下文窗口声明 → 各客户端的表达方式 =====
// 1M 的常量与纯函数放在 util.cjs：CC Switch 那条写入路径要写同一组 env 键，
// 两处各留一份 "context-1m-2025-08-07" 字面量，改一处漏一处就是"设了 1M 但有一半不生效"。
const { CTX_1M_THRESHOLD, CLAUDE_1M_BETA, CLAUDE_1M_SUFFIX, with1m, mergeBetas } = util;

/** Claude Code：只改 env 里的模型/鉴权键，其它键（enableWorkflows / plugins / mcp 等）原样保留。
 *
 *  contextWindow 是「该模型声明的真实窗口」，达到 1M 时才写 [1m] 后缀 + ANTHROPIC_BETAS。
 *  低于门槛时主动**摘掉**我们写过的后缀与 beta：否则从 1M 模型切回 200K 模型，
 *  旧的 [1m] 会让客户端继续按 1M 判定窗口，真实 200K 的模型在 200K 之后直接 400。 */
function buildClaudeSettings(existing, { base, apiKey, model, tiers, contextWindow, reasoningEffort }) {
  const next = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  const env = next.env && typeof next.env === "object" && !Array.isArray(next.env) ? { ...next.env } : {};
  const use1m = Number(contextWindow) >= CTX_1M_THRESHOLD;
  const upstream = with1m(model, use1m);
  const tierOf = (k) => with1m(String((tiers && tiers[k]) || "").trim() || model, use1m);

  env.ANTHROPIC_BASE_URL = base;
  env.ANTHROPIC_AUTH_TOKEN = apiKey;
  // 网关只认 Bearer：写 API_KEY 会触发 Claude Code 双变量鉴权告警（与 ccswitch 同口径）
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_MODEL = upstream;
  for (const [tier, keys] of Object.entries(CC_TIER_KEYS)) {
    const v = tierOf(tier);
    env[keys[0]] = v;
    // _MODEL_NAME 是菜单展示名，不带 [1m]：后缀是给客户端判窗口用的标记，
    // 混进展示名只会让人以为上游模型就叫这个，排查时对不上号。
    if (keys[1]) env[keys[1]] = String(v).replace(/\[1m\]/gi, "");
  }
  const betas = mergeBetas(env.ANTHROPIC_BETAS, use1m);
  if (betas) env.ANTHROPIC_BETAS = betas;
  else delete env.ANTHROPIC_BETAS;
  // 默认思考强度：Claude Code 认 CLAUDE_CODE_EFFORT_LEVEL（会话内 /effort 与设置里的
  // effortLevel 仍可覆盖它，正是"默认档"该有的语义）。留空时删掉这个键而不是写空串——
  // 空串是一个"已设置但无值"的档位，客户端会按未知值处理。
  const effort = String(reasoningEffort || "");
  if (effort) env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  else delete env.CLAUDE_CODE_EFFORT_LEVEL;
  next.env = env;
  return { data: next, text: JSON.stringify(next, null, 2) + "\n", env };
}

/** Codex TOML：文本级替换四个顶层键 + [model_providers.<id>] 段，其它段一个字节不动 */
function buildCodexToml(existingText, opts) {
  const text = String(existingText || "");
  const withCatalog = !(opts && opts.withCatalog === false);
  const block = [
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    `name = "AgentHub"`,
    `base_url = "{{BASE}}/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,
    "",
  ].join("\n");

  // 1) 先摘掉旧的同名 provider 段（到下一个顶层 [ 前）
  const segRe = new RegExp(`\\n?\\[model_providers\\.${CODEX_PROVIDER_ID}\\][\\s\\S]*?(?=\\n\\s*\\[|$)`, "g");
  let body = text.replace(segRe, "");

  // 2) 顶层三键：存在则改值，不存在则在文件头补
  const setTop = (src, key, val) => {
    const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
    if (re.test(src)) return src.replace(re, `${key} = ${val}`);
    return `${key} = ${val}\n${src}`;
  };
  body = setTop(body, "model_provider", `"${CODEX_PROVIDER_ID}"`);
  body = setTop(body, "model", `"{{MODEL}}"`);
  if (withCatalog) body = setTop(body, "model_catalog_json", `"${CODEX_CATALOG_FILE}"`);
  else body = body.replace(/^\s*model_catalog_json\s*=.*\n?/m, "");

  // 3) 追加 provider 段到文末（子表写在哪个位置都合法，文末对用户已有内容零扰动）
  body = body.replace(/\s+$/, "");
  body = body.length ? `${body}\n\n${block}` : block;
  return body;
}

/**
 * 取本机 Codex 自带的内置模型目录（纯净的，不含用户配的 model_catalog_json）。
 *
 * 为什么要问二进制而不是手写字段：目录条目的 schema 随客户端版本走
 * （0.163 把 supported_reasoning_levels 从字符串数组改成 ReasoningEffortPreset 对象，
 *  同时新增强制的 shell_type / truncation_policy / support_verbosity / 指令模板），
 * 手写的条目在下一次升级后又会被判「无法加载配置」，而客户端自己的条目永远跟自己的 schema 对得上。
 *
 * 候选顺序：PATH 上的 codex → 桌面端（ChatGPT.app）自带的 codex-cli。
 * macOS 的图形应用不继承 shell 的 PATH，只装了桌面端时第一条会落空，靠第二条兜住。
 */
function codexBundledCatalog() {
  const home = os.homedir();
  const candidates = [];
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) candidates.push(path.join(dir, `codex${ext}`));
  }
  if (process.platform === "darwin") {
    for (const app of ["ChatGPT", "Codex"]) {
      candidates.push(`/Applications/${app}.app/Contents/Resources/codex-cli/bin/codex`);
      candidates.push(path.join(home, "Applications", `${app}.app`, "Contents", "Resources", "codex-cli", "bin", "codex"));
    }
  }
  for (const bin of candidates) {
    let out = "";
    try {
      if (!fs.existsSync(bin)) continue;
      out = execFileSync(bin, ["debug", "models", "--bundled"], {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 8 << 20,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        // 隔离 CODEX_HOME：--bundled 只是"不刷新"，仍会读用户的 config.toml
        env: { ...process.env, CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cx-")) },
      });
    } catch {
      continue; // 装的是别的 codex / 版本太老不认 debug models，换下一个候选
    }
    try {
      const models = (JSON.parse(out) || {}).models;
      if (Array.isArray(models) && models.length) return models;
    } catch { /* 输出不是 JSON，换下一个候选 */ }
  }
  return null;
}

/** 从内置目录挑一条做模板：优先偏好列表，其次取 base_instructions 最长的（信息最多） */
function pickCodexTemplate(models) {
  for (const slug of CODEX_CLONE_PREFER) {
    const hit = models.find((m) => m && m.slug === slug && (m.base_instructions || (m.model_messages || {}).instructions_template));
    if (hit) return hit;
  }
  return models
    .filter((m) => m && m.slug && !/auto-review/.test(m.slug) && (m.base_instructions || (m.model_messages || {}).instructions_template))
    .sort((a, b) => String((b.model_messages || {}).instructions_template || b.base_instructions || "").length
      - String((a.model_messages || {}).instructions_template || a.base_instructions || "").length)[0] || null;
}

/**
 * Codex model catalog：按本机客户端自带的条目克隆一条，只换 slug/展示名与我们要的档位。
 *
 * 上下文窗口的三级来源（优先级从高到低），全部在 buildCodexCatalog 里显式决定：
 *   ① 面板手填的 contextWindow（用户最清楚上游真实窗口）；
 *   ② 目录里该模型的 contextLength（同步到的官方声明 / 用户在模型页的 per-model 覆盖）；
 *   ③ 都没有 → **沿用模板条目的值，并把「这是模板值」如实报回面板**。
 * 为什么 ③ 要报备而不是悄悄沿用：模板条目的 272000 只属于模板模型（gpt-5.x 系），
 * 客户端会拿它当窗口做溢出判定，于是 1M 模型被当成 256K 提前截断。
 * 而目录写 0 之外的"猜一个 1M"更糟——猜错方向不可控，且用户无从分辨是猜的还是真的。
 * 面板把「沿用模板 272K」摆出来，用户手填一次即永久生效，这是唯一诚实的降级。
 *
 * 为什么必须克隆而不是手写：条目的 instructions_template 会**替换**（不是追加）内置系统提示，
 * 漏写就得到一个没有系统提示的 Codex；而字段又随版本增加，手写迟早会缺字段导致启动即报错。
 *
 * 取不到内置目录时返回 null：调用方据此不写 model_catalog_json。
 * 退化成「元数据未找到，使用回退元数据」的警告——功能可用，比让客户端开不起来好。
 *
 * @returns {{models: Array}|null} 同构目录；非 null 时附带 `_ctx` 说明字段供面板展示（写盘前会剥掉）
 */
function buildCodexCatalog(model, template, contextWindow, reasoningEffort) {
  const src = template;
  if (!src) return null;
  const entry = JSON.parse(JSON.stringify(src));
  const mdl = String(model);
  entry.slug = mdl;
  entry.display_name = mdl;
  entry.description = "";
  const ctx = Number(contextWindow);
  const explicit = Number.isFinite(ctx) && ctx > 0;
  if (explicit) {
    entry.context_window = Math.trunc(ctx);
    entry.max_context_window = Math.trunc(ctx);
  }
  delete entry.comp_hash; // 内置条目的内容哈希，克隆后已不成立
  if ("visibility" in entry) entry.visibility = "list";
  if ("supported_in_api" in entry) entry.supported_in_api = true;
  if ("priority" in entry) entry.priority = 1000;
  // 默认思考强度：只改 default，不动 supported_reasoning_levels 的既有内容——
  // 模板条目那份是客户端随版本下发的权威能力表，删改它等于谎报模型能力。
  // 但要保证所选档在支持表里：模板默认的 medium 在 low/medium/high/xhigh 之内，
  // 而 off / minimal / max 这些客户端不认的档在 normalizeClientEffort 那层就被拦掉了。
  const effort = String(reasoningEffort || "");
  if (effort && Array.isArray(entry.supported_reasoning_levels)) {
    const has = entry.supported_reasoning_levels.some((x) => String((x && x.effort) || x) === effort);
    // 缺档时补一条：不补的话客户端会按「回落到最近的更低档」静默改写用户的选择
    if (!has) entry.supported_reasoning_levels.push({ effort, description: effort });
    entry.default_reasoning_level = effort;
  }
  const catalog = { models: [entry] };
  // 供 apply() 回给面板的上下文来源说明。不塞进 models 条目里：客户端会照单解析未知字段，
  // 而顶层 `_ctx` 只有我们自己读（写盘前 strip 掉），出问题的概率是零。
  catalog._ctx = {
    value: Number(entry.context_window) || 0,
    source: explicit ? "declared" : "template",
    templateModel: String(src.slug || ""),
  };
  return catalog;
}

/** 写盘前剥掉仅供 UI 用的顶层 `_ctx`：Codex 只认 `models`，多一个键没有意义且会被版本升级抱怨 */
function stripCatalogMeta(catalog) {
  if (!catalog || typeof catalog !== "object") return catalog;
  const { _ctx, ...rest } = catalog;
  return rest;
}

/**
 * Claude Desktop profile。
 * name 必须是 sonnet/opus/haiku/fable + 可选版本号（客户端 GSe 正则硬校验）；
 * labelOverride 是菜单展示名，填真实上游模型，这样菜单看到的是真实模型而不是角色名。
 *
 * 1M 档要写**两个**字段，只写 supports1m 是不够的（这是实测踩到的坑）：
 *   · supports1m  —— 只是"在菜单里额外提供一个 <id>[1m] 选项"（客户端 U5t() 展开成两条）。
 *                    用户不去手动选那条 1M 变体，跑的仍是 200K 的普通条目。
 *   · prefer1m    —— 配合 supports1m 后该条目本身即"只以 1M 形态存在"（客户端 D8t()），
 *                    模型 id 会被 G5t() 自动解析成 <id>[1m]，无需用户再选。
 * 两者都带，才是"接上就是 1M"。
 *
 * 代价：客户端随后发出的 model 是 `<角色名>[1m]`，所以 buildDesktopAliases 必须同时
 * 登记这条别名，否则网关会收到目录里不存在的名字。
 */
function buildDesktopProfile({ base, apiKey, model, tiers, contextWindow }) {
  const upstream = String(model);
  const tierOf = (k) => String((tiers && tiers[k]) || "").trim() || upstream;
  const supports1m = Number(contextWindow) >= CTX_1M_THRESHOLD;
  return {
    coworkEgressAllowedHosts: ["*"],
    disableDeploymentModeChooser: true,
    inferenceGatewayApiKey: apiKey,
    inferenceGatewayAuthScheme: "bearer",
    inferenceGatewayBaseUrl: base,
    inferenceProvider: "gateway",
    inferenceModels: Object.entries(DESKTOP_TIER_NAMES).map(([tier, name]) => {
      const real = tierOf(tier);
      return { name, labelOverride: real, supports1m, ...(supports1m && { prefer1m: true }) };
    }),
  };
}

/** Desktop _meta.json：把 appliedId 指向 AgentHub 的 profile，保留其它条目 */
function buildDesktopMeta(existing) {
  const meta = existing && typeof existing === "object" ? { ...existing } : {};
  const entries = Array.isArray(meta.entries) ? meta.entries.filter((e) => e && e.id !== DESKTOP_PROFILE_ID) : [];
  entries.push({ id: DESKTOP_PROFILE_ID, name: DESKTOP_PROFILE_NAME });
  meta.entries = entries;
  meta.appliedId = DESKTOP_PROFILE_ID;
  return meta;
}

/**
 * Desktop 直连必需：把四档角色名登记进网关 modelAliases。
 *
 * 为什么必须有：客户端发出去的 model 是角色名（sonnet-4-5），网关拿它去渠道目录里找
 * → 找不到 → 400「模型 "sonnet-4-5" 不在任何渠道目录中」。别名解析在 server.cjs 里
 * 早于目录校验执行，所以登记别名后即可路由到真实模型。
 *
 * 1M 档还要多登记一条 `<角色名>[1m]`：profile 带了 prefer1m 之后，客户端会把模型 id
 * 自动解析成 `sonnet-4-5[1m]` 再发请求（见 buildDesktopProfile 的注释）。少这条别名，
 * 症状与"角色名没登记"一样是 400，但报错里带个后缀，很容易被当成模型名写错。
 *
 * 降档时把带 `[1m]` 的别名整体摘掉：留着会让一个当前不该存在的名字继续可路由。
 * 只摘带后缀的键——用户自己配的别名一个字不动。
 *
 * 反方向（modelReverseAliases）不写：Desktop 只发角色名，不需要把真实模型名映射回去。
 * 返回本次写入的别名表，供调用方判断是否需要落盘。
 */
function buildDesktopAliases(existingAliases, { model, tiers, contextWindow }) {
  const upstream = String(model);
  const tierOf = (k) => String((tiers && tiers[k]) || "").trim() || upstream;
  const next = { ...(existingAliases || {}) };
  for (const k of Object.keys(next)) {
    if (/\[1m\]$/i.test(k)) delete next[k];
  }
  const use1m = Number(contextWindow) >= CTX_1M_THRESHOLD;
  for (const [tier, name] of Object.entries(DESKTOP_TIER_NAMES)) {
    const real = tierOf(tier);
    next[name] = real;
    if (use1m) next[`${name}${CLAUDE_1M_SUFFIX}`] = real;
  }
  return next;
}

// ===== 写后校验 =====

/** Claude Code：env 目标键全部落位 + 原有顶层键一个不少 */
function verifyClaude(before, after, opts) {
  const problems = [];
  const env = (after && after.env) || {};
  if (!env.ANTHROPIC_BASE_URL) problems.push("ANTHROPIC_BASE_URL 未写入");
  if (!env.ANTHROPIC_AUTH_TOKEN) problems.push("ANTHROPIC_AUTH_TOKEN 未写入");
  if (!env.ANTHROPIC_MODEL) problems.push("ANTHROPIC_MODEL 未写入");
  for (const keys of Object.values(CC_TIER_KEYS)) {
    if (!env[keys[0]]) problems.push(`${keys[0]} 未写入`);
  }
  // 1M 双条件必须一起成立：少了后缀客户端内部仍是 200K，少了 beta 上游不认。
  // 只查一个的话，写漏的那个不会报错，症状是"设了 1M 但会话仍在 200K 断开"。
  const want1m = opts && Number(opts.contextWindow) >= CTX_1M_THRESHOLD;
  if (want1m) {
    if (!/\[1m\]/i.test(String(env.ANTHROPIC_MODEL || ""))) problems.push("1M 档的 ANTHROPIC_MODEL 缺少 [1m] 后缀");
    if (!String(env.ANTHROPIC_BETAS || "").includes(CLAUDE_1M_BETA)) problems.push(`ANTHROPIC_BETAS 未包含 ${CLAUDE_1M_BETA}`);
  }
  // 指定了默认档就必须真的落进 env：CLAUDE_CODE_EFFORT_LEVEL 拼错一个字母不会报错，
  // 客户端只是"没读到"，表现与完全没配一模一样。
  const wantEffort = opts && String(opts.reasoningEffort || "");
  if (wantEffort && String(env.CLAUDE_CODE_EFFORT_LEVEL || "") !== wantEffort) {
    problems.push(`CLAUDE_CODE_EFFORT_LEVEL 未写成 ${wantEffort}`);
  }
  const lost = Object.keys(before || {}).filter((k) => !(k in (after || {})));
  if (lost.length) problems.push(`原有键丢失：${lost.join("、")}`);
  return problems;
}

/**
 * Claude Code 的 `[1m]` 后缀必须同时登记成网关别名。
 *
 * 客户端把 `[1m]` 当"窗口标记"，正常会剥掉再发请求；但这一点没有任何官方承诺，
 * 一旦哪个版本没剥，网关会收到 `deepseek-v4.1-flash[1m]` 这种目录里不存在的名字，
 * 直接 400「模型不在任何渠道目录中」——症状是接完就完全不能用，且报错完全指向不了后缀。
 * 别名表在目录校验之前生效（server.cjs 的 alias 解析早于 modelOwners），所以这里是唯一
 * 能兜住"客户端不剥后缀"的位置。
 *
 * 关闭时把带 `[1m]` 的别名整体摘掉：留着会让一个已经不存在的名字继续可路由，
 * 而它指向的模型可能已经换掉了。只摘带后缀的键——用户自己配的别名一个字不动。
 */
function buildClaude1mAliases(existingAliases, { model, tiers, contextWindow }) {
  const next = { ...(existingAliases || {}) };
  for (const k of Object.keys(next)) {
    if (/\[1m\]$/i.test(k)) delete next[k];
  }
  if (Number(contextWindow) < CTX_1M_THRESHOLD) return next;
  const upstream = String(model);
  const names = new Set([upstream]);
  for (const k of Object.keys(CC_TIER_KEYS)) {
    const v = String((tiers && tiers[k]) || "").trim() || upstream;
    names.add(v);
  }
  for (const n of names) next[`${String(n).replace(/\[1m\]/gi, "")}${CLAUDE_1M_SUFFIX}`] = String(n).replace(/\[1m\]/gi, "");
  return next;
}

/** Codex：顶层键 + provider 段里的 base_url/wire_api 落位（目录键由 withCatalog 决定是否要求） */function verifyCodex(toml, opts) {
  const problems = [];
  if (!/^\s*model_provider\s*=\s*"agenthub"/m.test(toml)) problems.push("model_provider 未指向 agenthub");
  // 默认思考强度写在 model_catalog_json 里（不是 toml 顶层）：catalog 才是 Codex 的模型元数据来源，
  // 顶层 model_reasoning_effort 会被 catalog 的 default_reasoning_level 覆盖。
  if (opts && opts.catalog && opts.reasoningEffort) {
    const m = (opts.catalog.models || [])[0] || {};
    if (String(m.default_reasoning_level || "") !== String(opts.reasoningEffort)) {
      problems.push(`模型目录的 default_reasoning_level 未写成 ${opts.reasoningEffort}`);
    }
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const has = levels.some((x) => String((x && x.effort) || x) === String(opts.reasoningEffort));
    // 档位不在支持表里时客户端会静默降到最近的更低档 —— 用户以为设了 xhigh，实际跑 high
    if (!has) problems.push(`default_reasoning_level=${opts.reasoningEffort} 不在 supported_reasoning_levels 里`);
  }
  if (!(opts && opts.withCatalog === false) && !/^\s*model_catalog_json\s*=/m.test(toml)) problems.push("model_catalog_json 未写入");
  const sec = new RegExp(`\\[model_providers\\.${CODEX_PROVIDER_ID}\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(toml);
  if (!sec) problems.push("provider 段缺失");
  else {
    if (!/^\s*base_url\s*=\s*"http[^"]*\/v1"\s*$/m.test(sec[1])) problems.push("base_url 未以 /v1 结尾");
    if (!/^\s*wire_api\s*=\s*"responses"/m.test(sec[1])) problems.push('wire_api 不是 "responses"');
  }
  return problems;
}

/** Desktop：四档 name 必须匹配客户端校验正则。
 *  客户端 GSe = /^(sonnet|opus|haiku|fable|mythos)(-[\d.]+)?$/ —— 版本段只认数字与点（-4.5），
 *  但本机实测 CC Switch 写入的是 -4-5 形态（连字符分隔）。两者都放过：先把 - 归一成 . 再校验，
 *  这样既能对上客户端放行条件，也不会因为自己写错名字导致写入被自己的校验拦下。 */
function desktopNameOk(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (/^(sonnet|opus|haiku|fable|mythos)(-[\d.]+)?$/.test(raw)) return true;
  return /^(sonnet|opus|haiku|fable|mythos)(-[\d-]+)?$/.test(raw);
}
function verifyDesktop(profile, opts) {
  const problems = [];
  if (profile.inferenceProvider !== "gateway") problems.push("inferenceProvider 不是 gateway");
  const models = Array.isArray(profile.inferenceModels) ? profile.inferenceModels : [];
  if (models.length !== 4) problems.push(`四档模型数量不对（${models.length}）`);
  for (const m of models) {
    if (!desktopNameOk(m.name)) problems.push(`模型名 "${m.name}" 不符合客户端校验（需 sonnet/opus/haiku/fable + 可选版本号）`);
    if (!m.labelOverride) problems.push(`模型 ${m.name} 缺 labelOverride`);
  }
  // 1M 档必须同时有 prefer1m：只写 supports1m 时客户端只是"多给一个可选项"，
  // 不选它仍跑 200K —— 这与完全没配的观感一模一样，事后没有任何线索指向漏了这个字段。
  if (opts && Number(opts.contextWindow) >= CTX_1M_THRESHOLD) {
    const missing = models.filter((m) => !(m.supports1m === true && m.prefer1m === true));
    if (missing.length) problems.push(`1M 档缺少 prefer1m（只写 supports1m 时客户端不会自动用 1M）：${missing.map((m) => m.name).join("、")}`);
  }
  return problems;
}

// ===== 状态 =====

/**
 * 只读状态：各应用的目标文件、当前指向、是否与 CC Switch 冲突。
 * 不写任何文件，供页面加载与写入前预检共用。
 */
function status(opts) {
  const port = Number((opts && opts.port) || config.loadConfig().proxy.port) || 9527;
  const claudeSettings = readClaudeSettings();
  const claudeEnv = (claudeSettings && claudeSettings.env) || {};
  const codex = readCodexRouting();
  const desktop = readDesktopRouting();
  const out = {
    port,
    apps: {},
  };
  const info = (appType, url) => {
    const t = targetsOf(appType);
    return {
      appType,
      files: t.files,
      // 是否已存在（区分「新建」与「修改」）
      exists: t.files.map((f) => {
        try { return fs.existsSync(f); } catch { return false; }
      }),
      url: String(url || ""),
      pointingGateway: isGatewayUrl(url, port),
      pointingCcSwitch: isCcSwitchUrl(url),
    };
  };
  out.apps.claude = info("claude", claudeEnv.ANTHROPIC_BASE_URL);
  out.apps.codex = info("codex", codex.url);
  out.apps["claude-desktop"] = { ...info("claude-desktop", desktop.url), profileName: desktop.name };
  return out;
}

/** 目标文件是否被其它进程占用/客户端在跑（只做提示，不杀进程） */
function runningHint(appType) {
  // 不做进程探测（跨平台不可靠且开销大）：只给出「需重启客户端生效」的静态提示
  if (appType === "claude") return "Claude Code 每次启动会重新读取配置，新开一个会话即生效。";
  if (appType === "codex") return "Codex 需要重启（CLI 退出重开 / 桌面端完全退出再打开）才会读到新的 provider 配置。";
  return "Claude Desktop 需要完全退出并重启才会加载新的 profile。";
}

/**
 * 应用配置。
 * 无 confirmAck 时只做预检（返回 needConfirm + probe），用户确认后带 confirmAck 重调才真正写盘。
 */
function apply({ appType, apiKey, model, tiers, port, confirmAck, contextWindow, contextWindowSource, reasoningEffort } = {}) {
  const t = String(appType || "");
  if (!DIRECT_APPS.includes(t)) return { ok: false, message: `不支持的应用类型 "${t}"` };
  const key = String(apiKey || "").trim();
  const mdl = String(model || "").trim();
  if (!key) return { ok: false, message: "请先选择网关 API Key" };
  if (!mdl) return { ok: false, message: "请先选择默认模型" };

  const cfg = config.loadConfig();
  const p = Number(port) || Number(cfg.proxy.port) || 9527;
  const base = gatewayBase(p);

  // 预检（只读）
  const st = status({ port: p });
  const app = st.apps[t];
  const probe = {
    appType: t,
    base,
    files: app.files,
    exists: app.exists,
    currentUrl: app.url,
    pointingGateway: app.pointingGateway,
    // CC Switch 接管中：直连写入会被它下次切换时覆盖
    conflict: app.pointingCcSwitch,
    hint: runningHint(t),
    confirmText: app.pointingCcSwitch
      ? `当前 ${app.url} 由 CC Switch 本地路由接管。写入直连配置后，需要到 CC Switch 里停用该应用的本地路由，否则它会在下次切换时把你的配置覆盖回去。`
      : `将写入 ${app.files.join("、")}（写前自动备份，只改 AgentHub 负责的键，其它配置保持不变）。`,
  };
  // 上下文窗口声明：三个客户端的表达方式完全不同，但输入只有一个数。
  // Codex 写进 model catalog 的 context_window；Claude Code 靠 [1m] 后缀 + ANTHROPIC_BETAS；
  // Claude Desktop 靠 profile 的 supports1m。这里统一归一一次，避免各处对「已声明」的判断漂移。
  const ctxDeclared = Number(contextWindow) > 0 ? Math.trunc(Number(contextWindow)) : 0;
  // 默认思考强度：三端表达方式又各不相同（Codex 走 catalog 的 default_reasoning_level，
  // Claude Code 走 CLAUDE_CODE_EFFORT_LEVEL，Desktop 无公开写入点）。
  // 归一放在这里一处，别让各分支对"空串"的理解漂移。
  const effort = util.normalizeClientEffort(reasoningEffort);
  if (t === "claude-desktop" && effort) {
    probe.warn = "Claude Desktop 的默认思考强度由管理端策略（admin_default_effort_level）决定，"
      + "没有可写入的 profile 字段；本次不会生效，Desktop 里仍用客户端的推荐档。";
  }
  if (t !== "codex" && !ctxDeclared) {
    probe.warn = "所选模型没有声明上下文窗口："
      + (t === "claude"
        ? "将按 Claude Code 默认的 200K 运行（超过后客户端会提前压缩会话）。"
        : "将按 Claude Desktop 默认的 200K 运行。")
      + "若该模型真实窗口更大（如 1M），请在下方「上下文窗口」手填真实值后重新写入。";
  }
  // Codex 的模型目录要从本机客户端克隆（预检与写入共用这一次结果，别为同一件事起两次子进程）；
  // 取不到就降级成不写目录，Codex 用回退元数据并告警。提前告知，免得用户以为写入失败或漏配了什么。
  let codexCatalog = null;
  let codexCtx = null;
  // 统一回给面板的「这次写了多少窗口、靠什么机制、值从哪来」。
  // 三个客户端的机制不同，但面板不需要知道细节——它只要能把"沿用了默认值"这件事说清楚。
  let ctxInfo = null;
  if (t === "codex") {
    codexCatalog = buildCodexCatalog(mdl, pickCodexTemplate(codexBundledCatalog() || []), ctxDeclared, effort);
    if (!codexCatalog) {
      probe.warn = "未找到本机 Codex 客户端（PATH 或 ChatGPT.app），无法生成模型元数据：将不写模型目录，"
        + "Codex 启动时会提示「Model metadata not found」并按回退元数据运行；装好 Codex 后重新写入可消除。";
    } else {
      codexCtx = codexCatalog._ctx || null;
      // 面板没填、目录也没声明 → 现在写进去的是模板模型的窗口（如 272000 ≈ 256K）。
      // 不 warn 的话没人看得见，而它造成的症状（长会话被提前截断）会被误判成模型本身不行。
      if (codexCtx && codexCtx.source === "template") {
        probe.warn = `所选模型没有声明上下文窗口，将沿用 Codex 内置模板（${codexCtx.templateModel}）的 `
          + `${codexCtx.value} Token。若该模型真实窗口更大（如 1M），请在下方「上下文窗口」手填真实值后重新写入。`;
      } else if (codexCtx && contextWindowSource === "manual") {
        probe.confirmText += ` 上下文窗口按你手填的 ${codexCtx.value} Token 写入。`;
      }
      ctxInfo = { value: codexCtx ? codexCtx.value : 0, source: codexCtx ? codexCtx.source : "template", mechanism: "catalog" };
    }
  } else if (t === "claude") {
    const on = ctxDeclared >= CTX_1M_THRESHOLD;
    ctxInfo = {
      value: on ? ctxDeclared : 200000,
      // 未声明时客户端按 200K 跑，这不是"写了 200000"，而是"没写、留默认"——分开表述
      source: ctxDeclared ? "declared" : "default",
      mechanism: on ? "claude-1m" : "default-200k",
    };
    if (ctxDeclared && contextWindowSource === "manual") {
      probe.confirmText += on
        ? ` 上下文窗口按你手填的 ${ctxDeclared} Token 写入（模型名加 [1m] 后缀 + ANTHROPIC_BETAS）。`
        : ` 你手填的 ${ctxDeclared} Token 未达 1M：Claude Code 只有 200K / 1M 两档，将按默认 200K 运行。`;
    }
  } else {
    const on = ctxDeclared >= CTX_1M_THRESHOLD;
    ctxInfo = { value: on ? ctxDeclared : 200000, source: ctxDeclared ? "declared" : "default", mechanism: on ? "supports1m" : "default-200k" };
    if (ctxDeclared && contextWindowSource === "manual") {
      probe.confirmText += on
        ? ` 上下文窗口按你手填的 ${ctxDeclared} Token 写入（profile 的 supports1m=true）。`
        : ` 你手填的 ${ctxDeclared} Token 未达 1M：Desktop 只有 200K / 1M 两档，将按默认 200K 运行。`;
    }
  }
  if (!confirmAck) {
    // 顶层也带 appType：前端两阶段（预检/写入）用同一个字段取值，避免只在 probe 里出现导致的读空
    return { ok: true, appType: t, needConfirm: true, probe, codexCtx, ctxInfo, effort, message: probe.confirmText };
  }

  // 备份 → 写入 → 校验，任一步失败回滚
  let backup = null;
  try {
    backup = backupFiles(t, app.files);
  } catch (e) {
    return { ok: false, message: `备份失败，已中止（未修改任何文件）：${(e && e.message) || e}` };
  }

  try {
    if (t === "claude") {
      const before = readClaudeSettings() || {};
      const built = buildClaudeSettings(before, { base, apiKey: key, model: mdl, tiers, contextWindow: ctxDeclared, reasoningEffort: effort });
      writeAtomic(app.files[0], built.text, { secret: true });
      const after = JSON.parse(fs.readFileSync(app.files[0], "utf8"));
      const problems = verifyClaude(before, after, { contextWindow: ctxDeclared, reasoningEffort: effort });
      if (problems.length) return rollback(t, backup, `写入校验失败：${problems.join("；")}`);
      // [1m] 后缀的网关别名：写在客户端配置校验通过之后，配置没落住就不该留下半套别名
      const cfgAll = config.loadConfig();
      const aliases = buildClaude1mAliases(cfgAll.proxy.modelAliases, { model: mdl, tiers, contextWindow: ctxDeclared });
      if (JSON.stringify(aliases) !== JSON.stringify(cfgAll.proxy.modelAliases || {})) {
        cfgAll.proxy.modelAliases = aliases;
        config.saveConfig(cfgAll);
      }
    } else if (t === "codex") {
      const root = codexHome();
      const tomlPath = path.join(root, "config.toml");
      const before = (() => {
        try { return fs.readFileSync(tomlPath, "utf8"); } catch { return ""; }
      })();
      // 目录在预检阶段就克隆好了：字段随版本增加，手写会被下个版本判成无法加载；
      // 取不到就不写目录，让 Codex 用回退元数据跑——可用但会警告，好过开不起来。
      // 写盘前剥掉 _ctx：它只给面板看，客户端不需要。
      const catalog = codexCatalog ? stripCatalogMeta(codexCatalog) : null;
      const withCatalog = !!catalog;
      const toml = buildCodexToml(before, { withCatalog })
        .replace(/\{\{BASE\}\}/g, base)
        .replace(/\{\{MODEL\}\}/g, mdl);
      writeAtomic(tomlPath, toml);
      writeAtomic(path.join(root, "auth.json"), JSON.stringify({ OPENAI_API_KEY: key }, null, 2) + "\n", { secret: true });
      if (withCatalog) writeAtomic(path.join(root, CODEX_CATALOG_FILE), JSON.stringify(catalog, null, 2) + "\n");
      const after = fs.readFileSync(tomlPath, "utf8");
      const problems = verifyCodex(after, { withCatalog, catalog, reasoningEffort: effort });
      if (problems.length) return rollback(t, backup, `写入校验失败：${problems.join("；")}`);
    } else {
      const lib = path.join(userDataRoot(), "Claude-3p", "configLibrary");
      const profPath = path.join(lib, `${DESKTOP_PROFILE_ID}.json`);
      const metaPath = path.join(lib, "_meta.json");
      // _meta 里已有的其它 profile 条目要保留（用户可能在 CC Switch 之外还有别的配置源）
      const beforeMeta = (() => {
        try { return JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { return {}; }
      })();
      const profile = buildDesktopProfile({ base, apiKey: key, model: mdl, tiers, contextWindow: ctxDeclared });
      writeAtomic(profPath, JSON.stringify(profile, null, 2) + "\n", { secret: true });
      const meta = buildDesktopMeta(beforeMeta);
      writeAtomic(metaPath, JSON.stringify(meta, null, 2) + "\n");
      const afterProfile = JSON.parse(fs.readFileSync(profPath, "utf8"));
      const problems = verifyDesktop(afterProfile, { contextWindow: ctxDeclared });
      const afterMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (afterMeta.appliedId !== DESKTOP_PROFILE_ID) problems.push("_meta.json 的 appliedId 未指向 AgentHub profile");
      const lost = (beforeMeta.entries || []).filter((e) => e && e.id !== DESKTOP_PROFILE_ID && !(afterMeta.entries || []).some((x) => x && x.id === e.id));
      if (lost.length) problems.push(`原有 profile 条目丢失：${lost.map((e) => e.name || e.id).join("、")}`);
      if (problems.length) return rollback(t, backup, `写入校验失败：${problems.join("；")}`);

      // 角色名必须登记进网关别名表，否则客户端发 sonnet-4-5 会被判「不在任何渠道目录」400。
      // 放在客户端文件全部校验通过之后写：配置写失败就不该留下半套别名。
      const cfgAll = config.loadConfig();
      const aliases = buildDesktopAliases(cfgAll.proxy.modelAliases, { model: mdl, tiers, contextWindow: ctxDeclared });
      cfgAll.proxy.modelAliases = aliases;
      config.saveConfig(cfgAll);
    }
  } catch (e) {
    return rollback(t, backup, `写入失败：${(e && e.message) || e}`);
  }

  // 成功提示里带上窗口档位与默认思考强度：写入成功的 toast 是用户唯一会看到的结果，
  // 只说"需重启"而不说实际写了什么，没生效时又得回头翻配置。
  const effortNote = (() => {
    if (!effort) return "";
    if (t === "claude-desktop") return "";
    return ` 默认思考强度 ${effort}。`;
  })();
  const ctxNote = (() => {
    if (!ctxInfo) return "";
    if (ctxInfo.source === "template") return ` 上下文窗口沿用了 Codex 模板值 ${ctxInfo.value}（未声明真实窗口）。`;
    if (ctxInfo.source === "default") return " 未声明上下文窗口，客户端按默认 200K 运行。";
    // Codex 写的是真实数字，Claude 两端只能表达"够 1M"这个档位，文案必须分开说
    if (ctxInfo.mechanism === "catalog") return ` 上下文窗口写入 ${ctxInfo.value}（model catalog）。`;
    if (ctxInfo.mechanism === "claude-1m") return " 已按 1M 档写入（模型名 [1m] 后缀 + ANTHROPIC_BETAS）。";
    if (ctxInfo.mechanism === "supports1m") return " 已按 1M 档写入（profile 的 supports1m）。";
    return "";
  })();
  return { ok: true, appType: t, backupPath: backup.dir, files: app.files, base, codexCtx, ctxInfo, effort, message: `${probe.hint}${ctxNote}${effortNote}` };
}

/** 用备份回滚（文件原本不存在则删除新建的） */
function rollback(appType, backup, reason) {
  const restored = [];
  try {
    for (const f of targetsOf(appType).files) {
      const saved = (backup && backup.saved ? backup.saved : []).find((x) => x.from === f);
      if (saved && fs.existsSync(saved.to)) {
        fs.copyFileSync(saved.to, f);
        restored.push(f);
      } else {
        // 备份里没有 = 写入前该文件不存在 → 删掉新建的
        try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
      }
    }
  } catch (e) {
    return { ok: false, message: `${reason}；回滚也失败（${(e && e.message) || e}），请手工从 ${backup ? backup.dir : "备份目录"} 恢复` };
  }
  return { ok: false, message: `${reason}；已回滚${restored.length ? `（${restored.length} 个文件）` : ""}` };
}

/** 手动逃生：用最近一次备份恢复某应用 */
function restoreLatest({ appType } = {}) {
  const t = String(appType || "");
  if (!DIRECT_APPS.includes(t)) return { ok: false, message: `不支持的应用类型 "${t}"` };
  const root = path.join(config.dataDir(), "proxy", "direct-backup", t);
  let entries = [];
  try {
    entries = fs.readdirSync(root).filter((n) => /^\d+$/.test(n)).sort();
  } catch {
    return { ok: false, message: "没有可用的备份" };
  }
  if (!entries.length) return { ok: false, message: "没有可用的备份" };
  const dir = path.join(root, entries[entries.length - 1]);
  const files = targetsOf(t).files;
  let n = 0;
  try {
    for (const f of files) {
      const saved = path.join(dir, path.basename(f));
      if (!fs.existsSync(saved)) continue;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.copyFileSync(saved, f);
      n++;
    }
  } catch (e) {
    return { ok: false, message: `恢复失败：${(e && e.message) || e}` };
  }
  return { ok: true, restored: n, backupPath: dir, message: n ? `已从 ${dir} 恢复 ${n} 个文件` : "备份目录里没有匹配的文件" };
}

module.exports = {
  status,
  apply,
  restoreLatest,
  DIRECT_APPS,
  targetsOf,
  gatewayBase,
  buildCodexToml,
  buildClaudeSettings,
  verifyClaude,
  verifyCodex,
  buildCodexCatalog,
  stripCatalogMeta,
  with1m,
  mergeBetas,
  buildClaude1mAliases,
  CTX_1M_THRESHOLD,
  CLAUDE_1M_BETA,
  pickCodexTemplate,
  buildDesktopProfile,
  buildDesktopAliases,
  verifyDesktop,
  DESKTOP_TIER_NAMES,
  desktopNameOk,
};
