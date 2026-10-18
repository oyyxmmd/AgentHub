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
//        model-catalog.json（/model 列表；文件名自建，不抢 CC Switch 的 cc-switch-model-catalog.json）
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

const config = require("../config.cjs");

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

/** Desktop 四档角色名：必须匹配客户端校验正则 (sonnet|opus|haiku|fable|mythos)(-数字) */
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

/** Claude Code：只改 env 里的模型/鉴权键，其它键（enableWorkflows / plugins / mcp 等）原样保留 */
function buildClaudeSettings(existing, { base, apiKey, model, tiers }) {
  const next = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  const env = next.env && typeof next.env === "object" && !Array.isArray(next.env) ? { ...next.env } : {};
  const upstream = String(model);
  const tierOf = (k) => String((tiers && tiers[k]) || "").trim() || upstream;

  env.ANTHROPIC_BASE_URL = base;
  env.ANTHROPIC_AUTH_TOKEN = apiKey;
  // 网关只认 Bearer：写 API_KEY 会触发 Claude Code 双变量鉴权告警（与 ccswitch 同口径）
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_MODEL = upstream;
  for (const [tier, keys] of Object.entries(CC_TIER_KEYS)) {
    const v = tierOf(tier);
    env[keys[0]] = v;
    if (keys[1]) env[keys[1]] = v;
  }
  next.env = env;
  return { data: next, text: JSON.stringify(next, null, 2) + "\n", env };
}

/** Codex TOML：文本级替换三个顶层键 + [model_providers.<id>] 段，其它段一个字节不动 */
function buildCodexToml(existingText) {
  const text = String(existingText || "");
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
  body = setTop(body, "model_catalog_json", `"${CODEX_CATALOG_FILE}"`);

  // 3) 追加 provider 段到文末（子表写在哪个位置都合法，文末对用户已有内容零扰动）
  body = body.replace(/\s+$/, "");
  body = body.length ? `${body}\n\n${block}` : block;
  return body;
}

/** Codex model catalog：至少一条，否则配置了 model_catalog_json 时 Codex 会报错 */
function buildCodexCatalog(model) {
  return {
    models: [
      {
        slug: String(model),
        display_name: String(model),
        description: "",
        context_window: 300000,
        max_context_window: 300000,
        effective_context_window_percent: 95,
        default_reasoning_level: "high",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
        supports_reasoning_summaries: true,
        visibility: "list",
        supported_in_api: true,
        priority: 1000,
      },
    ],
  };
}

/**
 * Claude Desktop profile。
 * name 必须是 sonnet/opus/haiku/fable + 可选版本号（客户端 GSe 正则硬校验）；
 * labelOverride 是菜单展示名，填真实上游模型，这样菜单看到的是真实模型而不是角色名。
 */
function buildDesktopProfile({ base, apiKey, model, tiers }) {
  const upstream = String(model);
  const tierOf = (k) => String((tiers && tiers[k]) || "").trim() || upstream;
  return {
    coworkEgressAllowedHosts: ["*"],
    disableDeploymentModeChooser: true,
    inferenceGatewayApiKey: apiKey,
    inferenceGatewayAuthScheme: "bearer",
    inferenceGatewayBaseUrl: base,
    inferenceProvider: "gateway",
    inferenceModels: Object.entries(DESKTOP_TIER_NAMES).map(([tier, name]) => {
      const real = tierOf(tier);
      return { name, labelOverride: real, supports1m: false };
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

// ===== 写后校验 =====

/** Claude Code：env 目标键全部落位 + 原有顶层键一个不少 */
function verifyClaude(before, after) {
  const problems = [];
  const env = (after && after.env) || {};
  if (!env.ANTHROPIC_BASE_URL) problems.push("ANTHROPIC_BASE_URL 未写入");
  if (!env.ANTHROPIC_AUTH_TOKEN) problems.push("ANTHROPIC_AUTH_TOKEN 未写入");
  if (!env.ANTHROPIC_MODEL) problems.push("ANTHROPIC_MODEL 未写入");
  for (const keys of Object.values(CC_TIER_KEYS)) {
    if (!env[keys[0]]) problems.push(`${keys[0]} 未写入`);
  }
  const lost = Object.keys(before || {}).filter((k) => !(k in (after || {})));
  if (lost.length) problems.push(`原有键丢失：${lost.join("、")}`);
  return problems;
}

/** Codex：三个顶层键 + provider 段里的 base_url/wire_api 落位 */
function verifyCodex(toml) {
  const problems = [];
  if (!/^\s*model_provider\s*=\s*"agenthub"/m.test(toml)) problems.push("model_provider 未指向 agenthub");
  if (!/^\s*model_catalog_json\s*=/m.test(toml)) problems.push("model_catalog_json 未写入");
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
function verifyDesktop(profile) {
  const problems = [];
  if (profile.inferenceProvider !== "gateway") problems.push("inferenceProvider 不是 gateway");
  const models = Array.isArray(profile.inferenceModels) ? profile.inferenceModels : [];
  if (models.length !== 4) problems.push(`四档模型数量不对（${models.length}）`);
  for (const m of models) {
    if (!desktopNameOk(m.name)) problems.push(`模型名 "${m.name}" 不符合客户端校验（需 sonnet/opus/haiku/fable + 可选版本号）`);
    if (!m.labelOverride) problems.push(`模型 ${m.name} 缺 labelOverride`);
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
function apply({ appType, apiKey, model, tiers, port, confirmAck } = {}) {
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
  if (!confirmAck) {
    return { ok: true, needConfirm: true, probe, message: probe.confirmText };
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
      const built = buildClaudeSettings(before, { base, apiKey: key, model: mdl, tiers });
      writeAtomic(app.files[0], built.text, { secret: true });
      const after = JSON.parse(fs.readFileSync(app.files[0], "utf8"));
      const problems = verifyClaude(before, after);
      if (problems.length) return rollback(t, backup, `写入校验失败：${problems.join("；")}`);
    } else if (t === "codex") {
      const root = codexHome();
      const tomlPath = path.join(root, "config.toml");
      const before = (() => {
        try { return fs.readFileSync(tomlPath, "utf8"); } catch { return ""; }
      })();
      const toml = buildCodexToml(before).replace(/\{\{BASE\}\}/g, base).replace(/\{\{MODEL\}\}/g, mdl);
      writeAtomic(tomlPath, toml);
      writeAtomic(path.join(root, "auth.json"), JSON.stringify({ OPENAI_API_KEY: key }, null, 2) + "\n", { secret: true });
      writeAtomic(path.join(root, CODEX_CATALOG_FILE), JSON.stringify(buildCodexCatalog(mdl), null, 2) + "\n");
      const after = fs.readFileSync(tomlPath, "utf8");
      const problems = verifyCodex(after);
      if (problems.length) return rollback(t, backup, `写入校验失败：${problems.join("；")}`);
    } else {
      const lib = path.join(userDataRoot(), "Claude-3p", "configLibrary");
      const profPath = path.join(lib, `${DESKTOP_PROFILE_ID}.json`);
      const metaPath = path.join(lib, "_meta.json");
      // _meta 里已有的其它 profile 条目要保留（用户可能在 CC Switch 之外还有别的配置源）
      const beforeMeta = (() => {
        try { return JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { return {}; }
      })();
      const profile = buildDesktopProfile({ base, apiKey: key, model: mdl, tiers });
      writeAtomic(profPath, JSON.stringify(profile, null, 2) + "\n", { secret: true });
      const meta = buildDesktopMeta(beforeMeta);
      writeAtomic(metaPath, JSON.stringify(meta, null, 2) + "\n");
      const afterProfile = JSON.parse(fs.readFileSync(profPath, "utf8"));
      const problems = verifyDesktop(afterProfile);
      const afterMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (afterMeta.appliedId !== DESKTOP_PROFILE_ID) problems.push("_meta.json 的 appliedId 未指向 AgentHub profile");
      const lost = (beforeMeta.entries || []).filter((e) => e && e.id !== DESKTOP_PROFILE_ID && !(afterMeta.entries || []).some((x) => x && x.id === e.id));
      if (lost.length) problems.push(`原有 profile 条目丢失：${lost.map((e) => e.name || e.id).join("、")}`);
      if (problems.length) return rollback(t, backup, `写入校验失败：${problems.join("；")}`);
    }
  } catch (e) {
    return rollback(t, backup, `写入失败：${(e && e.message) || e}`);
  }

  return { ok: true, appType: t, backupPath: backup.dir, files: app.files, base, message: `${probe.hint}` };
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

module.exports = { status, apply, restoreLatest, DIRECT_APPS, targetsOf, gatewayBase, buildCodexToml, buildDesktopProfile, desktopNameOk };
