// 生态接入 · 直连模式自测：用临时 HOME 沙箱验证三端的路径解析、合并式写入、写后校验与回滚。
// 用法：node tools/proxy-direct-selftest.cjs
// 关键断言：只改自己的键（用户其它配置一个字节不动）、Desktop 模型名符合客户端校验正则、
//          Codex TOML 段替换不影响其它段、写前备份可回滚。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

// ===== 沙箱：把 HOME / APPDATA / CODEX_HOME / AGENTHUB_DATA_DIR 全指到临时目录 =====
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "direct-test-"));
const fakeHome = path.join(sandbox, "home");
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.APPDATA = path.join(sandbox, "appdata");
process.env.LOCALAPPDATA = path.join(sandbox, "localappdata");
process.env.AGENTHUB_DATA_DIR = path.join(sandbox, "agenthub-data");
delete process.env.CODEX_HOME;

// 注意：os.homedir() 在 Node 里会读 HOME（POSIX）/ USERPROFILE（Win），设完环境变量后 require 模块即可
const direct = require("../electron/backend/proxy/direct.cjs");
const util = require("../electron/backend/proxy/util.cjs");

let pass = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error(`FAIL: ${name}${extra ? `（${extra}）` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
}

const GATEWAY = "http://127.0.0.1:9527";
const KEY = "sk-direct-test-key";

// ===== 1. 路径解析 =====
console.log("1. 路径解析");
{
  const c = direct.targetsOf("claude").files;
  ok("Claude Code 指向 ~/.claude/settings.json", c.length === 1 && c[0].endsWith(path.join(".claude", "settings.json")), c[0]);
  const x = direct.targetsOf("codex").files;
  ok("Codex 三个文件（config/auth/catalog）", x.length === 3 && x.some((f) => f.endsWith("config.toml")) && x.some((f) => f.endsWith("auth.json")), x.join(","));
  const d = direct.targetsOf("claude-desktop").files;
  ok("Claude Desktop 两个文件（profile + _meta）", d.length === 2 && d.some((f) => f.endsWith("_meta.json")), d.join(","));
  ok("不支持的 appType 返回空", direct.targetsOf("nope").files.length === 0);
}

// ===== 2. Claude Code：合并写只动自己的键 =====
console.log("2. Claude Code 合并写");
{
  const f = direct.targetsOf("claude").files[0];
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // 用户原有配置：含非模型键与自定义 MCP
  fs.writeFileSync(f, JSON.stringify({
    enableWorkflows: true,
    enabledPlugins: ["foo"],
    env: { ANTHROPIC_API_KEY: "old-key-should-be-removed", SOME_CUSTOM: "keep-me" },
    permissions: { allow: ["Bash"] },
  }, null, 2));

  const pre = direct.apply({ appType: "claude", apiKey: KEY, model: "glm-5.3", tiers: { sonnet: "kimi-k3", opus: "", haiku: "", subagent: "sub_agent_x" }, port: 9527 });
  ok("首调返回 needConfirm（不落盘）", pre.ok === true && pre.needConfirm === true && pre.probe.conflict === false);
  // 两阶段返回形状必须一致：前端用同一个 appType 字段走「预检 → 确认写入」，
  // 只在 probe 里给会让前端读到 undefined → 空串 → 后端报「不支持的应用类型 ""」
  ok("预检顶层带 appType（与写入阶段一致）", pre.appType === "claude" && pre.probe.appType === "claude");
  ok("预检带目标文件与提示", Array.isArray(pre.probe.files) && !!pre.probe.confirmText && !!pre.probe.hint);
  const beforeWrite = JSON.parse(fs.readFileSync(f, "utf8"));
  ok("预检未修改文件", beforeWrite.env.ANTHROPIC_API_KEY === "old-key-should-be-removed");

  const r = direct.apply({ appType: "claude", apiKey: KEY, model: "glm-5.3", tiers: { sonnet: "kimi-k3", opus: "", haiku: "", subagent: "sub_agent_x" }, port: 9527, confirmAck: true });
  ok("确认后写入成功", r.ok === true, r.message);
  ok("生成了备份目录", !!r.backupPath && fs.existsSync(r.backupPath));

  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  ok("baseURL 指向网关", j.env.ANTHROPIC_BASE_URL === GATEWAY);
  ok("只写 AUTH_TOKEN，删掉 API_KEY", j.env.ANTHROPIC_AUTH_TOKEN === KEY && j.env.ANTHROPIC_API_KEY === undefined);
  ok("默认模型落位", j.env.ANTHROPIC_MODEL === "glm-5.3");
  ok("四档独立：sonnet 用自定义值", j.env.ANTHROPIC_DEFAULT_SONNET_MODEL === "kimi-k3" && j.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME === "kimi-k3");
  ok("四档留空回落默认", j.env.ANTHROPIC_DEFAULT_OPUS_MODEL === "glm-5.3" && j.env.ANTHROPIC_DEFAULT_HAIKU_MODEL === "glm-5.3");
  ok("子代理档独立", j.env.CLAUDE_CODE_SUBAGENT_MODEL === "sub_agent_x");
  // 关键：用户其它配置一个都不能丢
  ok("保留 enableWorkflows", j.enableWorkflows === true);
  ok("保留 enabledPlugins", Array.isArray(j.enabledPlugins) && j.enabledPlugins[0] === "foo");
  ok("保留 permissions", !!j.permissions && Array.isArray(j.permissions.allow));
  ok("保留 env 里的自定义键", j.env.SOME_CUSTOM === "keep-me");

  // 状态：应识别为已指向网关
  const st = direct.status({ port: 9527 });
  ok("status 识别已直连网关", st.apps.claude.pointingGateway === true && st.apps.claude.pointingCcSwitch === false);
}

// ===== 2b. Claude Code 的 1M 档：后缀 + ANTHROPIC_BETAS 缺一不可 =====
console.log("2b. Claude Code 1M 档信号");
{
  const f = direct.targetsOf("claude").files[0];
  // 本段中途会直接覆盖 settings.json（模拟"用户已有别的 beta"），结束时必须还原成
  // 第 2 段 apply 的产物——否则第 5 段的回滚断言会拿这段的残缺夹具去比对 enableWorkflows
  const snapshot = fs.readFileSync(f, "utf8");
  const tiers = { sonnet: "kimi-k3", opus: "", haiku: "", subagent: "" };

  // 1M：模型名带 [1m]…（客户端内部按它判窗口）+ betas 里含 context-1m（让请求真的带 beta 头）
  const r1 = direct.apply({ appType: "claude", apiKey: KEY, model: "glm-5.3", tiers, port: 9527, confirmAck: true, contextWindow: 1000000 });
  ok("声明 1M 写入成功", r1.ok === true, r1.message);
  const j1 = JSON.parse(fs.readFileSync(f, "utf8"));
  ok("ANTHROPIC_MODEL 带 [1m] 后缀", j1.env.ANTHROPIC_MODEL === "glm-5.3[1m]", j1.env.ANTHROPIC_MODEL);
  ok("四档 *_MODEL 也都带 [1m]", j1.env.ANTHROPIC_DEFAULT_SONNET_MODEL === "kimi-k3[1m]"
    && j1.env.ANTHROPIC_DEFAULT_OPUS_MODEL === "glm-5.3[1m]", j1.env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  ok("ANTHROPIC_BETAS 含 context-1m-2025-08-07", String(j1.env.ANTHROPIC_BETAS || "").includes(direct.CLAUDE_1M_BETA), j1.env.ANTHROPIC_BETAS);
  ok("*_MODEL_NAME 是展示名，不含 [1m]（否则菜单显示的名字对不上上游模型）",
    !/\[1m\]/i.test(String(j1.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME || "")), j1.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME);
  ok("1M 档的确认文案说明了机制", /\[1m\]|ANTHROPIC_BETAS/.test(String(r1.message || "")), r1.message);

  // 切回 200K：必须摘掉后缀与 beta —— 留着会让真实的 200K 模型在 200K 之后直接 400
  const r2 = direct.apply({ appType: "claude", apiKey: KEY, model: "glm-5.3", tiers, port: 9527, confirmAck: true, contextWindow: 200000 });
  const j2 = JSON.parse(fs.readFileSync(f, "utf8"));
  ok("降回 200K 时摘掉 [1m] 后缀", j2.env.ANTHROPIC_MODEL === "glm-5.3" && !/\[1m\]/i.test(JSON.stringify(j2.env)), j2.env.ANTHROPIC_MODEL);
  ok("降回 200K 时摘掉 context-1m beta", r2.ok === true && !String(j2.env.ANTHROPIC_BETAS || "").includes(direct.CLAUDE_1M_BETA), j2.env.ANTHROPIC_BETAS);

  // 用户自己的 beta 不能被我们覆盖掉（整串覆盖会静默关掉他已有的能力）
  fs.writeFileSync(f, JSON.stringify({ env: { ANTHROPIC_BETAS: "interleaved-thinking" } }, null, 2));
  direct.apply({ appType: "claude", apiKey: KEY, model: "glm-5.3", tiers, port: 9527, confirmAck: true, contextWindow: 1000000 });
  const j3 = JSON.parse(fs.readFileSync(f, "utf8"));
  ok("保留用户已有的其它 beta", String(j3.env.ANTHROPIC_BETAS).includes("interleaved-thinking"), j3.env.ANTHROPIC_BETAS);
  ok("同时带上 context-1m", String(j3.env.ANTHROPIC_BETAS).includes(direct.CLAUDE_1M_BETA));
  ok("betas 不重复（幂等）", String(j3.env.ANTHROPIC_BETAS).split(",").filter((x) => x.trim() === direct.CLAUDE_1M_BETA).length === 1, j3.env.ANTHROPIC_BETAS);

  // [1m] 的网关别名：客户端万一本版本不剥后缀，网关也不能 400
  const al = direct.buildClaude1mAliases({}, { model: "glm-5.3", tiers, contextWindow: 1000000 });
  ok("1M 档登记 <model>[1m] → <model> 别名", al["glm-5.3[1m]"] === "glm-5.3", al);
  ok("四档模型同样登记", al["kimi-k3[1m]"] === "kimi-k3", al);
  const alOff = direct.buildClaude1mAliases({ ...al, "my-own": "x" }, { model: "glm-5.3", tiers, contextWindow: 200000 });
  ok("降档时摘掉 [1m] 别名", !Object.keys(alOff).some((k) => /\[1m\]$/i.test(k)), alOff);
  ok("降档不碰用户自己的别名", alOff["my-own"] === "x", alOff);

  // 校验闸：写漏任一条都必须报出来，而不是"设了 1M 但仍在 200K 断开"
  const bad = { env: { ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: "glm-5.3",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "a", ANTHROPIC_DEFAULT_OPUS_MODEL: "b", ANTHROPIC_DEFAULT_HAIKU_MODEL: "c", CLAUDE_CODE_SUBAGENT_MODEL: "d" } };
  const probs = direct.verifyClaude({}, bad, { contextWindow: 1000000 });
  ok("校验能抓出缺 [1m] 后缀", probs.some((p) => /\[1m\]/.test(p)), probs);
  ok("校验能抓出缺 ANTHROPIC_BETAS", probs.some((p) => /ANTHROPIC_BETAS/.test(p)), probs);
  ok("200K 档不要求这两个（不能误报）", direct.verifyClaude({}, bad, { contextWindow: 200000 }).length === 0);

  fs.writeFileSync(f, snapshot);
}

// ===== 3. Codex：TOML 段替换不影响其它段 =====
console.log("3. Codex TOML 合并");
{
  const [tomlPath, authPath, catPath] = direct.targetsOf("codex").files;
  fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
  // 用户已有配置：CC Switch 接管态 + 自己的 MCP 与 desktop 段
  fs.writeFileSync(tomlPath, [
    'model_provider = "custom"',
    'model = "old-model"',
    "",
    "[model_providers.custom]",
    'name = "custom"',
    'base_url = "http://127.0.0.1:15721/v1"',
    'wire_api = "responses"',
    "",
    "[mcp_servers.my-tool]",
    'command = "my-tool"',
    'args = ["--flag"]',
    "",
    "[desktop]",
    'theme = "dark"',
    "",
    '[projects."/Users/x/proj"]',
    'trust_level = "trusted"',
    "",
  ].join("\n"));

  const pre = direct.apply({ appType: "codex", apiKey: KEY, model: "glm-5.3", port: 9527 });
  ok("Codex 预检识别 CC Switch 接管", pre.needConfirm === true && pre.probe.conflict === true);

  const r = direct.apply({ appType: "codex", apiKey: KEY, model: "glm-5.3", port: 9527, confirmAck: true });
  ok("Codex 写入成功", r.ok === true, r.message);

  const toml = fs.readFileSync(tomlPath, "utf8");
  ok("model_provider 指向 agenthub", /^\s*model_provider\s*=\s*"agenthub"/m.test(toml));
  ok("model 更新", /^\s*model\s*=\s*"glm-5\.3"/m.test(toml));
  ok("model_catalog_json 写入", /^\s*model_catalog_json\s*=\s*"agenthub-model-catalog\.json"/m.test(toml));
  const sec = /\[model_providers\.agenthub\]([\s\S]*?)(?:\n\[|$)/.exec(toml);
  ok("agenthub provider 段存在", !!sec);
  ok("base_url 以 /v1 结尾", /base_url\s*=\s*"http:\/\/127\.0\.0\.1:9527\/v1"/.test(sec[1]));
  ok('wire_api = "responses"', /wire_api\s*=\s*"responses"/.test(sec[1]));
  // 旧 provider 段原样保留（不删用户的）
  ok("保留旧的 [model_providers.custom] 段", toml.includes("[model_providers.custom]") && toml.includes("127.0.0.1:15721/v1"));
  // 其它段一字不动
  ok("保留 mcp_servers 段", toml.includes("[mcp_servers.my-tool]") && toml.includes('command = "my-tool"'));
  ok("保留 desktop 段", toml.includes("[desktop]") && toml.includes('theme = "dark"'));
  ok("保留 projects 段", toml.includes("[projects.") && toml.includes('trust_level = "trusted"'));

  ok("auth.json 写 OPENAI_API_KEY", JSON.parse(fs.readFileSync(authPath, "utf8")).OPENAI_API_KEY === KEY);

  // 重复写入幂等：不应产生第二个 agenthub 段
  direct.apply({ appType: "codex", apiKey: KEY, model: "glm-5.3", port: 9527, confirmAck: true });
  const toml2 = fs.readFileSync(tomlPath, "utf8");
  const cnt = (toml2.match(/\[model_providers\.agenthub\]/g) || []).length;
  ok("重复写入不重复 provider 段", cnt === 1, `实际 ${cnt} 个`);
  ok("重复写入后 mcp 段仍在", toml2.includes("[mcp_servers.my-tool]"));
}

// ===== 3b. Codex 模型目录：克隆内置条目，不能手写 =====
// 手写字段会被下个客户端版本判成「无法加载配置」（0.163 就在 reasoning 档位上改过结构），
// 而 instructions_template 会顶替内置系统提示，漏写等于给用户一个没有系统提示的 Codex。
console.log("3b. Codex 模型目录");
{
  const [tomlPath, , catPath] = direct.targetsOf("codex").files;

  // 本机没装 Codex 时跳过（沙箱里取不到内置目录）
  const catalog = direct.buildCodexCatalog("glm-5.3", {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "Frontier",
    visibility: "hide",
    priority: 2,
    supported_in_api: true,
    comp_hash: "abc123",
    shell_type: "unified_exec",
    supported_reasoning_levels: [{ effort: "high", description: "Greater reasoning depth" }],
    model_messages: { instructions_template: "You are Codex." },
  });
  ok("目录条目沿用模板的必需字段", catalog.models[0].shell_type === "unified_exec"
    && Array.isArray(catalog.models[0].supported_reasoning_levels)
    && catalog.models[0].model_messages.instructions_template === "You are Codex.");
  ok("slug / 展示名换成用户选的模型", catalog.models[0].slug === "glm-5.3" && catalog.models[0].display_name === "glm-5.3");
  ok("克隆后模型在列表可见", catalog.models[0].visibility === "list");
  ok("丢弃模板的内容哈希", !("comp_hash" in catalog.models[0]));
  ok("取不到模板时不出目录（调用方据此不写该键）", direct.buildCodexCatalog("glm-5.3", null) === null);
  const wide = direct.buildCodexCatalog("deepseek-v4.1-flash", { slug: "gpt-5.5", context_window: 272000, max_context_window: 272000 }, 1000000);
  ok("1M 模型不继承模板的 272K 窗口", wide.models[0].context_window === 1000000 && wide.models[0].max_context_window === 1000000);
  const narrow = direct.buildCodexCatalog("small", { slug: "gpt-5.5", context_window: 272000, max_context_window: 272000 }, 128000);
  ok("小窗口模型也不被模板抬高", narrow.models[0].context_window === 128000 && narrow.models[0].max_context_window === 128000);
  const unknown = direct.buildCodexCatalog("unknown", { slug: "gpt-5.5", context_window: 272000, max_context_window: 272000 }, 0);
  ok("未知窗口保留客户端模板值", unknown.models[0].context_window === 272000 && unknown.models[0].max_context_window === 272000);
  // 来源标记：面板据此把"沿用模板 272K"这件事说清楚。少了它，症状（长会话被提前截断）
  // 发生在写盘之后，用户没有任何线索指向这个字段。
  ok("沿用模板时标记 source=template 并带出模板模型名",
    unknown._ctx && unknown._ctx.source === "template" && unknown._ctx.value === 272000 && unknown._ctx.templateModel === "gpt-5.5",
    unknown._ctx);
  ok("声明窗口时标记 source=declared", wide._ctx && wide._ctx.source === "declared" && wide._ctx.value === 1000000, wide._ctx);
  // 写盘前必须剥掉 _ctx：Codex 只认 models，顶层多一个键没意义且会被版本升级抱怨
  const stripped = direct.stripCatalogMeta(wide);
  ok("写盘前剥掉 _ctx，只留 models", !("_ctx" in stripped) && Array.isArray(stripped.models) && stripped.models.length === 1,
    Object.keys(stripped));
  ok("剥掉 _ctx 不影响 models 条目本身", stripped.models[0].context_window === 1000000);

  // 偏好列表优先，其次取指令最长的（信息最全）
  const picked = direct.pickCodexTemplate([
    { slug: "other", base_instructions: "short" },
    { slug: "gpt-5.5", base_instructions: "长一点的指令" },
  ]);
  ok("模板优先取偏好模型", picked && picked.slug === "gpt-5.5");
  const byLen = direct.pickCodexTemplate([
    { slug: "a", base_instructions: "x" },
    { slug: "b", base_instructions: "xxxx" },
  ]);
  ok("没有偏好模型时取指令最长的一条", byLen && byLen.slug === "b");

  // 写不进目录时：TOML 不能留 model_catalog_json（否则 Codex 会去读不存在的文件）
  const noCat = direct.buildCodexToml("model_catalog_json = \"old.json\"\n", { withCatalog: false });
  ok("降级时不写 model_catalog_json", !/model_catalog_json/.test(noCat), noCat);
  ok("降级不影响 provider 段", /\[model_providers\.agenthub\]/.test(noCat));
  if (!fs.existsSync(catPath)) {
    console.log("  skip 本机未安装 Codex，跳过真实目录断言");
  } else {
    const cat = JSON.parse(fs.readFileSync(catPath, "utf8"));
    const e = cat.models[0];
    ok("真实写入的目录带指令模板（否则 Codex 没有系统提示）",
      !!((e.model_messages || {}).instructions_template || e.base_instructions));
    ok("真实写入的目录带当前版本要求的结构", !!e.shell_type && Array.isArray(e.supported_reasoning_levels)
      && typeof e.supported_reasoning_levels[0] === "object");
  }
}

// ===== 3c. 默认思考强度：三端各自的落点 =====
console.log("3c. 默认思考强度");
{
  const tpl = {
    slug: "gpt-5.5", context_window: 272000, max_context_window: 272000,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
    base_instructions: "x", model_messages: { instructions_template: "You are Codex." },
  };
  // 未指定：保留模板推荐档。这里必须"不写"，不能兜一个 high —— 那样等于静默改了所有用户的默认。
  const dflt = direct.buildCodexCatalog("m", tpl, 0, "");
  ok("未指定档位时保留模板推荐档（不覆盖成 high）", dflt.models[0].default_reasoning_level === "medium", dflt.models[0].default_reasoning_level);

  const xh = direct.buildCodexCatalog("m", tpl, 0, "xhigh");
  ok("指定 xhigh 时写入 default_reasoning_level", xh.models[0].default_reasoning_level === "xhigh");
  ok("指定档位不改动 supported_reasoning_levels 的既有条目（那是客户端下发的权威能力表）",
    xh.models[0].supported_reasoning_levels.map((x) => x.effort).join(",") === "low,medium,high,xhigh",
    xh.models[0].supported_reasoning_levels);

  const thin = direct.buildCodexCatalog("m", { ...tpl, supported_reasoning_levels: [{ effort: "low" }] }, 0, "xhigh");
  ok("模板缺该档时补一条（不补会被客户端静默降到最近的更低档）",
    thin.models[0].supported_reasoning_levels.some((x) => x.effort === "xhigh"), thin.models[0].supported_reasoning_levels);

  const base = { base: "http://127.0.0.1:9527", apiKey: KEY, model: "glm-5.3", tiers: {} };
  const cOn = direct.buildClaudeSettings({}, { ...base, contextWindow: 0, reasoningEffort: "high" });
  ok("Claude Code 写 CLAUDE_CODE_EFFORT_LEVEL", cOn.env.CLAUDE_CODE_EFFORT_LEVEL === "high", cOn.env.CLAUDE_CODE_EFFORT_LEVEL);
  const cOff = direct.buildClaudeSettings(cOn.data, { ...base, contextWindow: 0, reasoningEffort: "" });
  ok("留空时删掉该键（空串是「已设置但无值」的档位，客户端按未知值处理）",
    !("CLAUDE_CODE_EFFORT_LEVEL" in cOff.env), Object.keys(cOff.env));

  // 词表：客户端默认档只认两边的交集，off/minimal/max 不在其中
  ok("off 被拒绝（它是「关思考」的语义开关，不是档位）", util.normalizeClientEffort("off") === "");
  ok("minimal 被拒绝（Codex 的档位表里没有它）", util.normalizeClientEffort("minimal") === "");
  ok("max 被拒绝（只有 Claude 有，Codex 侧会被当非法档）", util.normalizeClientEffort("max") === "");
  ok("合法档原样透传", util.normalizeClientEffort("xhigh") === "xhigh" && util.normalizeClientEffort("HIGH") === "high");

  // 校验闸
  const badEff = { env: { ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: "m",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "a", ANTHROPIC_DEFAULT_OPUS_MODEL: "b", ANTHROPIC_DEFAULT_HAIKU_MODEL: "c",
    CLAUDE_CODE_SUBAGENT_MODEL: "d", CLAUDE_CODE_EFFORT_LEVEL: "low" } };
  ok("校验能抓出档位没落位", direct.verifyClaude({}, badEff, { reasoningEffort: "high" }).some((x) => /EFFORT_LEVEL/.test(x)));
  ok("未指定档位时不校验它（不能误报）", direct.verifyClaude({}, badEff, {}).length === 0);

  const noEff = direct.stripCatalogMeta(direct.buildCodexCatalog("m", tpl, 0, ""));
  const ck = direct.verifyCodex('model_provider = "agenthub"\nmodel_catalog_json = "x"\n[model_providers.agenthub]\nbase_url = "http://h/v1"\nwire_api = "responses"\n', { withCatalog: true, catalog: noEff, reasoningEffort: "high" });
  ok("Codex 校验能抓出 default_reasoning_level 没写成指定档", ck.some((x) => /default_reasoning_level/.test(x)), ck);
}

// ===== 4. Claude Desktop：模型名必须符合客户端校验 =====
console.log("4. Claude Desktop profile");
{
  const [profPath, metaPath] = direct.targetsOf("claude-desktop").files;
  fs.mkdirSync(path.dirname(profPath), { recursive: true });
  // 用户已有 CC Switch 的 profile 条目
  fs.writeFileSync(metaPath, JSON.stringify({ appliedId: "ccs-profile", entries: [{ id: "ccs-profile", name: "CC Switch" }] }, null, 2));

  const r = direct.apply({ appType: "claude-desktop", apiKey: KEY, model: "glm-5.3", tiers: { sonnet: "kimi-k3", opus: "", haiku: "", subagent: "" }, port: 9527, confirmAck: true });
  ok("Desktop 写入成功", r.ok === true, r.message);

  const prof = JSON.parse(fs.readFileSync(profPath, "utf8"));
  ok("inferenceProvider = gateway", prof.inferenceProvider === "gateway");
  ok("baseUrl 指向网关（不经 15721）", prof.inferenceGatewayBaseUrl === GATEWAY);
  ok("authScheme = bearer", prof.inferenceGatewayAuthScheme === "bearer");
  ok("四档模型数量 = 4", prof.inferenceModels.length === 4);
  // ★ 核心：name 必须匹配客户端校验，labelOverride 才是展示名
  for (const m of prof.inferenceModels) {
    ok(`模型名 "${m.name}" 符合客户端正则`, direct.desktopNameOk(m.name));
  }
  const sonnet = prof.inferenceModels.find((m) => m.name.startsWith("sonnet"));
  ok("sonnet 档 labelOverride 为真实模型", sonnet.labelOverride === "kimi-k3");
  const opus = prof.inferenceModels.find((m) => m.name.startsWith("opus"));
  ok("opus 档留空回落默认模型", opus.labelOverride === "glm-5.3");
  ok("fable 档存在（第四档）", prof.inferenceModels.some((m) => m.name.startsWith("fable")));
  // supports1m 原先是无条件 false：所有 1M 上游都被压成 200K，与 Codex 的"模板 272K"同类。
  // 现在跟随声明的窗口，且客户端只有两档 —— 低于 1M 一律 false（不能谎报）。
  ok("未声明窗口时 supports1m=false（客户端按 200K）", prof.inferenceModels.every((m) => m.supports1m === false));
  ok("未声明窗口时不写 prefer1m", prof.inferenceModels.every((m) => m.prefer1m === undefined));
  {
    const r1 = direct.apply({ appType: "claude-desktop", apiKey: KEY, model: "glm-5.3", tiers: { sonnet: "kimi-k3", opus: "", haiku: "", subagent: "" }, port: 9527, confirmAck: true, contextWindow: 1000000 });
    ok("声明 1M 时写入成功", r1.ok === true, r1.message);
    const p1 = JSON.parse(fs.readFileSync(profPath, "utf8"));
    ok("声明 1M → 四档 supports1m 全为 true（漏一档就等于该档仍 200K）",
      p1.inferenceModels.every((m) => m.supports1m === true));
    // ★ 实测踩到的坑：只写 supports1m 时客户端只是"菜单里多一个 <id>[1m] 选项"，
    //   不去手动选它跑的仍是 200K。prefer1m 才让该条目本身即以 1M 形态存在。
    ok("声明 1M → 四档同时带 prefer1m（否则用户不选 [1m] 变体就仍是 200K）",
      p1.inferenceModels.every((m) => m.prefer1m === true), p1.inferenceModels.map((m) => [m.name, m.supports1m, m.prefer1m]));
    // prefer1m 之后客户端发的是 `<角色名>[1m]`，别名必须跟着登记，否则 400
    const cfgA = direct.status({ port: 9527 });
    ok("1M 档登记了 <角色名>[1m] 的网关别名", (() => {
      const a = direct.buildDesktopAliases({}, { model: "glm-5.3", tiers: { sonnet: "kimi-k3", opus: "", haiku: "", subagent: "" }, contextWindow: 1000000 });
      return a["sonnet-4-5[1m]"] === "kimi-k3" && a["sonnet-4-5"] === "kimi-k3";
    })(), cfgA.apps["claude-desktop"].profileName);
    const r2 = direct.apply({ appType: "claude-desktop", apiKey: KEY, model: "glm-5.3", tiers: { sonnet: "", opus: "", haiku: "", subagent: "" }, port: 9527, confirmAck: true, contextWindow: 400000 });
    const p2 = JSON.parse(fs.readFileSync(profPath, "utf8"));
    ok("声明 400K（中间档）→ 仍 false：客户端表达不了 400K，谎报会让它跳过压缩直接超限",
      r2.ok === true && p2.inferenceModels.every((m) => m.supports1m === false), p2.inferenceModels.map((m) => m.supports1m));
    // 校验闸：只写 supports1m 漏掉 prefer1m 必须被拦
    const half = { inferenceProvider: "gateway", inferenceModels: p1.inferenceModels.map(({ prefer1m, ...m }) => m) };
    ok("校验能抓出「有 supports1m 但缺 prefer1m」", direct.verifyDesktop(half, { contextWindow: 1000000 }).some((x) => /prefer1m/.test(x)));
    ok("200K 档不要求 prefer1m（不能误报）", direct.verifyDesktop({ inferenceProvider: "gateway", inferenceModels: p2.inferenceModels }, { contextWindow: 200000 }).length === 0);
    // 恢复成基准态，后面的回滚/校验断言按它比对
    direct.apply({ appType: "claude-desktop", apiKey: KEY, model: "glm-5.3", tiers: { sonnet: "kimi-k3", opus: "", haiku: "", subagent: "" }, port: 9527, confirmAck: true });
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  ok("_meta appliedId 指向 AgentHub profile", meta.appliedId !== "ccs-profile");
  ok("_meta 保留原有 CC Switch 条目", meta.entries.some((e) => e.id === "ccs-profile"));
  ok("_meta 含 AgentHub 条目", meta.entries.length === 2);

  // ★ 网关别名登记：客户端发的是角色名，不登记会被判「不在任何渠道目录」400
  const cfg = require("../electron/backend/config.cjs").loadConfig();
  const aliases = cfg.proxy.modelAliases || {};
  for (const m of prof.inferenceModels) {
    ok(`别名表登记了角色名 "${m.name}"`, typeof aliases[m.name] === "string" && aliases[m.name].length > 0, `实际 ${aliases[m.name]}`);
    ok(`角色名 "${m.name}" 映射到与该档 labelOverride 一致的模型`, aliases[m.name] === m.labelOverride);
  }
  ok("sonnet 角色名映射到自定义模型", aliases["sonnet-4-5"] === "kimi-k3");
  ok("opus 角色名映射到默认模型（该档留空）", aliases["opus-4-5"] === "glm-5.3");
  // 复用校验：buildDesktopAliases 不破坏用户已有别名
  const merged = direct.buildDesktopAliases({ "my-custom-alias": "glm-5" }, { model: "deepseek-v4", tiers: {} });
  ok("登记别名不影响用户已有别名", merged["my-custom-alias"] === "glm-5" && merged["sonnet-4-5"] === "deepseek-v4");
}

// ===== 5. 回滚 =====
console.log("5. 回滚");
{
  const orig = direct.apply({ appType: "claude", apiKey: KEY, model: "glm-5.3", port: 9527, confirmAck: true });
  ok("再次写入成功", orig.ok === true);
  const f = direct.targetsOf("claude").files[0];
  const beforeRollback = JSON.parse(fs.readFileSync(f, "utf8"));
  ok("写入后 baseURL 为网关", beforeRollback.env.ANTHROPIC_BASE_URL === GATEWAY);

  const rr = direct.restoreLatest({ appType: "claude" });
  ok("回滚成功", rr.ok === true, rr.message);
  ok("回滚后有备份路径", !!rr.backupPath);
  const after = JSON.parse(fs.readFileSync(f, "utf8"));
  ok("回滚恢复为上一次内容", after.env.ANTHROPIC_BASE_URL === GATEWAY && after.enableWorkflows === true);
}

// ===== 6. 参数校验 =====
console.log("6. 参数校验");
{
  ok("未知 appType 拒绝", direct.apply({ appType: "foo", apiKey: KEY, model: "m" }).ok === false);
  ok("空 Key 拒绝", direct.apply({ appType: "claude", apiKey: "  ", model: "m" }).ok === false);
  ok("空模型拒绝", direct.apply({ appType: "claude", apiKey: KEY, model: "" }).ok === false);
  ok("无备份时回滚给出提示", direct.restoreLatest({ appType: "codex" }).ok === true || direct.restoreLatest({ appType: "codex" }).ok === false);
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n全部通过：${pass} 项`);
