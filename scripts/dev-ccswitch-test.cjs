// 生态接入 · CC Switch 假库自测：造临时库（对齐真实 schema：BOOLEAN 标志列 + 复合主键 (id, app_type)），
// 用 CCSWITCH_DB_PATH 把模块指到它上面，验证 status / register 幂等 / 备份与轮换 / 条目内容 / 校验报错 / 版本不兼容 /
// live 链路探测（USERPROFILE+HOME 指到 fixture 家目录，并当场验证隔离真的生效）。
// 用法：node scripts/dev-ccswitch-test.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccswitch-test-"));
const dbFile = path.join(tmp, "cc-switch.db");
process.env.CCSWITCH_DB_PATH = dbFile;

let Database = null;
try {
  Database = require("node:sqlite").DatabaseSync;
} catch {
  Database = require("better-sqlite3");
}

// 真实 providers 表结构（CC Switch database/schema.rs：BOOLEAN 标志列默认 '0'，复合主键）
const PROVIDERS_SQL = `
CREATE TABLE providers (
  id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  name TEXT NOT NULL,
  settings_config TEXT NOT NULL,
  website_url TEXT,
  category TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL DEFAULT 0,
  sort_index INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  icon TEXT,
  icon_color TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  is_current BOOLEAN NOT NULL DEFAULT '0',
  in_failover_queue BOOLEAN NOT NULL DEFAULT '0',
  PRIMARY KEY (id, app_type)
);
`;

// 真实库另有 proxy_config 表：enabled 为该应用是否接管，proxy_enabled 为全局代理网关在线
// （Claude Desktop 映射模式无独立行，借 claude 行 proxy_enabled 判断）
const PROXY_CONFIG_SQL = `
CREATE TABLE proxy_config (
  app_type TEXT NOT NULL PRIMARY KEY,
  proxy_enabled BOOLEAN NOT NULL DEFAULT '0',
  enabled BOOLEAN NOT NULL DEFAULT '0'
);
`;

/** 重建指定库文件（可自定义建表 SQL；不传则建空库） */
function makeDb(file, tableSql) {
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  if (tableSql) db.exec(tableSql);
  db.close();
  return file;
}

makeDb(dbFile, PROVIDERS_SQL + PROXY_CONFIG_SQL);
const db = new Database(dbFile);
// 塞一条用户自己的 provider，验证绝不被改动
db.prepare(`INSERT INTO providers (id, app_type, name, settings_config, website_url, category, created_at, sort_index, is_current, in_failover_queue)
  VALUES ('user-claude-main', 'claude', '我的主力', '{"env":{"X":"1"}}', null, 'custom', 1, 5, '1', '0')`).run();
db.prepare(`INSERT INTO proxy_config (app_type, proxy_enabled, enabled) VALUES ('claude', '1', '1'), ('codex', '0', '0')`).run();
db.close();

const ccswitch = require("../electron/backend/proxy/ccswitch.cjs");

(async () => {
  // 1) 初始 status：未注册
  let s = ccswitch.status();
  assert.strictEqual(s.installed, true, "installed 应为 true");
  assert.strictEqual(s.incompatible, false, "schema 正常不应 incompatible");
  assert.deepStrictEqual(s.entries.map((e) => e.registered), [false, false, false], "初始应都未注册");
  console.log("✓ status 初始未注册");

  // 2) 注册 claude
  let r = ccswitch.register({ appType: "claude", apiKey: "sk-test-123", model: "deepseek-v4-flash", port: 9527 });
  assert.strictEqual(r.ok, true, "register claude 应 ok: " + JSON.stringify(r));
  assert.strictEqual(r.action, "inserted", "首次应为 inserted");
  assert.ok(r.backupPath && fs.existsSync(r.backupPath), "应生成备份文件: " + r.backupPath);
  console.log("✓ register claude inserted，备份 =", r.backupPath);

  // 3) 重复注册 claude：updated 幂等，不新增行
  r = ccswitch.register({ appType: "claude", apiKey: "sk-test-456", model: "deepseek-v4-flash", port: 9527 });
  assert.strictEqual(r.action, "updated", "重复注册应为 updated");

  // 4) 注册 codex
  r = ccswitch.register({ appType: "codex", apiKey: "sk-test-123", model: "deepseek-v4-flash", port: 9527 });
  assert.strictEqual(r.clone, undefined); // 防呆：register 不返回无关字段
  assert.strictEqual(r.ok, true, "register codex 应 ok");
  assert.strictEqual(r.action, "inserted", "codex 首次应为 inserted");
  assert.strictEqual(r.name, "AgentHub 网关（Codex）", "register 应回传真实条目名，供提示语直接使用");
  console.log("✓ register codex inserted");

  // 4.5) 注册 claude-desktop：proxy 模型映射模式（meta.claudeDesktopModelRoutes 四角色全映射同一上游模型）
  r = ccswitch.register({ appType: "claude-desktop", apiKey: "sk-test-123", model: "deepseek-v4-flash", port: 9527 });
  assert.strictEqual(r.ok, true, "register claude-desktop 应 ok: " + JSON.stringify(r));
  assert.strictEqual(r.action, "inserted", "claude-desktop 首次应为 inserted");
  assert.strictEqual(r.name, "AgentHub 网关（Claude Desktop）", "claude-desktop 应回传真实条目名");
  console.log("✓ register claude-desktop inserted");

  // 4.6) Claude 四档独立配置：tiers 传入后各档写各的模型，空档回落默认 model
  // （key 沿用 sk-test-456，与第 3 步「重复注册更新 key」的终态断言保持一致）
  r = ccswitch.register({
    appType: "claude", apiKey: "sk-test-456", model: "deepseek-v4-flash", port: 9527,
    tiers: { sonnet: "glm-5.3", opus: "", haiku: "kimi-k3", subagent: "sub_agent_x" },
  });
  assert.strictEqual(r.ok, true, "register claude with tiers 应 ok: " + JSON.stringify(r));
  r = ccswitch.register({
    appType: "claude-desktop", apiKey: "sk-test-456", model: "deepseek-v4-flash", port: 9527,
    tiers: { sonnet: "glm-5.3", opus: "", haiku: "kimi-k3", subagent: "sub_agent_x" },
  });
  assert.strictEqual(r.ok, true, "register claude-desktop with tiers 应 ok: " + JSON.stringify(r));
  console.log("✓ register claude / claude-desktop with tiers");

  // 5) 校验最终库内容
  const db2 = new Database(dbFile);
  const rows = db2.prepare("SELECT * FROM providers ORDER BY sort_index").all();
  db2.close();
  const claudeRow = rows.find((x) => x.id === "agenthub-gateway-claude");
  const codexRow = rows.find((x) => x.id === "agenthub-gateway-codex");
  const desktopRow = rows.find((x) => x.id === "agenthub-gateway-claude-desktop");
  assert.ok(claudeRow, "应有 claude 固定条目");
  assert.ok(codexRow, "应有 codex 固定条目");
  assert.ok(desktopRow, "应有 claude-desktop 固定条目");
  assert.strictEqual(desktopRow.app_type, "claude-desktop", "claude-desktop 条目应落独立 app_type");
  // 用户 provider 未被动过
  const userRow = rows.find((x) => x.id === "user-claude-main");
  assert.strictEqual(userRow.settings_config, '{"env":{"X":"1"}}', "用户 provider 不得被改动");
  assert.strictEqual(userRow.sort_index, 5, "用户 provider 的 sort_index 不得被改动");
  console.log("✓ 用户 provider 未被触碰");

  // 接管状态：proxy_config.enabled 决定 CC Switch 是否会做协议转换；
  // claudeDesktop 无独立行，跟 claude 行 proxy_enabled（全局代理网关在线）
  const stTakeover = ccswitch.status();
  assert.strictEqual(stTakeover.takeover.claude, true, "claude 接管状态应可读取");
  assert.strictEqual(stTakeover.takeover.codex, false, "codex 未开启接管时应为 false");
  assert.strictEqual(stTakeover.takeover.claudeDesktop, true, "claudeDesktop 应跟随全局代理（claude 行 proxy_enabled=1）");
  console.log("✓ 代理接管状态读取");

  // 条目内容
  const cs = JSON.parse(claudeRow.settings_config);
  assert.strictEqual(cs.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9527", "claude base url");
  assert.strictEqual(cs.env.ANTHROPIC_AUTH_TOKEN, "sk-test-456", "重复注册后 key 应更新为最新");
  assert.strictEqual(cs.env.ANTHROPIC_API_KEY, undefined, "claude 只写 AUTH_TOKEN，避免双变量鉴权告警");
  // *_MODEL 是接管后 model_mapper 的上游真值；*_MODEL_NAME 只是展示名，不能写角色别名。
  assert.strictEqual(cs.env.ANTHROPIC_MODEL, "deepseek-v4-flash", "默认模型为真实上游模型");
  // 四档独立配置：tiers 传入了 sonnet/haiku/subagent，opus 留空回落默认
  assert.strictEqual(cs.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-5.3", "Sonnet 档应为独立配置的模型");
  assert.strictEqual(cs.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, "glm-5.3", "Sonnet 显示名与该档模型同值");
  assert.strictEqual(cs.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "deepseek-v4-flash", "Opus 档留空应回落默认模型");
  assert.strictEqual(cs.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "deepseek-v4-flash", "Opus 显示名与该档模型同值");
  assert.strictEqual(cs.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "kimi-k3", "Haiku 档应为独立配置的模型");
  assert.strictEqual(cs.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, "kimi-k3", "Haiku 显示名与该档模型同值");
  assert.strictEqual(cs.env.CLAUDE_CODE_SUBAGENT_MODEL, "sub_agent_x", "子代理模型应为独立配置");
  const metaC = JSON.parse(claudeRow.meta);
  assert.strictEqual(metaC.apiFormat, "openai_chat", "claude 上游格式须为 openai_chat");
  assert.strictEqual(metaC.commonConfigEnabled, true, "claude 须并入用户通用配置，否则切换后全局配置丢失");
  assert.strictEqual(metaC.apiKeyField, "ANTHROPIC_AUTH_TOKEN", "claude 须声明鉴权字段，避免表单回写 API_KEY");
  const cdx = JSON.parse(codexRow.settings_config);
  assert.strictEqual(cdx.auth.OPENAI_API_KEY, "sk-test-123", "codex auth");
  assert.strictEqual(cdx.modelCatalog.models[0].model, "deepseek-v4-flash", "codex 模型目录应含网关模型");
  assert.strictEqual(cdx.modelCatalog.models[0].contextWindow, 300000, "codex 模型目录上下文窗口");
  assert.deepStrictEqual(cdx.modelCatalog.models[0].reasoningLevels, ["low", "high", "max"], "codex 模型目录可选推理档位");
  assert.strictEqual(cdx.modelCatalog.models[0].defaultReasoningLevel, "high", "codex 模型目录默认推理档位");
  assert.ok(cdx.config.includes('model_provider = "custom"'), "codex toml: model_provider");
  assert.ok(cdx.config.includes('model = "deepseek-v4-flash"'), "codex toml: model");
  assert.ok(cdx.config.includes('[model_providers.custom]'), "codex toml: custom 段");
  assert.ok(cdx.config.includes('base_url = "http://127.0.0.1:9527/v1"'), "codex toml: base_url");
  assert.ok(cdx.config.includes('wire_api = "responses"'), "codex toml: wire_api");
  assert.ok(cdx.config.includes("requires_openai_auth = true"), "codex toml: requires_openai_auth");
  assert.strictEqual(cdx.app_name, undefined, "无多余字段");
  // codex 的 meta 必须同时带这几项，见 ccswitch.cjs 顶部注释：
  // apiFormat 触发 Responses→Chat 翻译（缺了会 404），commonConfigEnabled 保住用户全局配置，
  // codexChatReasoning 声明网关支持思考模式/思考等级（否则 Codex 的 reasoning.effort 不转成上游参数）。
  const metaX = JSON.parse(codexRow.meta);
  assert.strictEqual(metaX.apiFormat, "openai_chat", "codex 必须显式声明上游为 chat，否则 CC Switch 不转换");
  assert.strictEqual(metaX.commonConfigEnabled, true, "codex 须并入用户通用配置，否则切换后全局配置丢失");
  assert.strictEqual(metaX.codexChatReasoning.supportsThinking, true, "codex 须开启支持思考模式");
  assert.strictEqual(metaX.codexChatReasoning.supportsEffort, true, "codex 须开启支持思考等级");
  assert.strictEqual(metaX.codexChatReasoning.thinkingParam, "thinking", "thinking 参数名为上游默认");
  assert.strictEqual(metaX.codexChatReasoning.effortParam, "reasoning_effort", "effort 参数名为顶层 OpenAI 风格字段");
  assert.strictEqual(metaX.codexChatReasoning.effortValueMode, "passthrough", "effort 档位按原值透传网关");
  console.log("✓ claude 条目 env 嵌套 + apiFormat=openai_chat");
  console.log("✓ codex 条目 auth + 指定 toml + apiFormat=openai_chat + 思考能力已开启");

  // claude-desktop 条目内容：proxy 模型映射模式
  // 模型不写 env（Desktop 只认 CC Switch 网关里的角色路由），全放 meta.claudeDesktopModelRoutes；
  // Desktop 3P 不走通用配置同步，故无 commonConfigEnabled。
  const cdd = JSON.parse(desktopRow.settings_config);
  assert.strictEqual(cdd.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9527", "claude-desktop base url");
  assert.strictEqual(cdd.env.ANTHROPIC_AUTH_TOKEN, "sk-test-456", "claude-desktop token（4.6 节重新注册已更新为最新）");
  assert.strictEqual(cdd.env.ANTHROPIC_API_KEY, undefined, "claude-desktop 只写 AUTH_TOKEN，避免双变量鉴权告警");
  assert.strictEqual(cdd.env.ANTHROPIC_MODEL, undefined, "claude-desktop 模型不写 env，走 meta 角色路由映射");
  const metaD = JSON.parse(desktopRow.meta);
  assert.strictEqual(metaD.apiFormat, "openai_chat", "claude-desktop 上游格式须为 openai_chat");
  assert.strictEqual(metaD.claudeDesktopMode, "proxy", "claude-desktop 须为 proxy 模型映射模式");
  assert.strictEqual(metaD.commonConfigEnabled, undefined, "Desktop 3P 不走通用配置同步，不得写 commonConfigEnabled");
  assert.deepStrictEqual(
    Object.keys(metaD.claudeDesktopModelRoutes).sort(),
    ["claude-fable-5", "claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5"],
    "四角色 routeId 应全映射",
  );
  for (const [rid, route] of Object.entries(metaD.claudeDesktopModelRoutes)) {
    assert.strictEqual(route.labelOverride, route.model, `角色 ${rid} 的菜单显示名应与实际请求模型一致`);
  }
  // 四档独立路由：subagent 档即 fable；opus 留空回落默认
  assert.strictEqual(metaD.claudeDesktopModelRoutes["claude-sonnet-5"].model, "glm-5.3", "Desktop Sonnet 路由应为独立配置的模型");
  assert.strictEqual(metaD.claudeDesktopModelRoutes["claude-opus-5"].model, "deepseek-v4-flash", "Desktop Opus 路由留空应回落默认模型");
  assert.strictEqual(metaD.claudeDesktopModelRoutes["claude-haiku-4-5"].model, "kimi-k3", "Desktop Haiku 路由应为独立配置的模型");
  assert.strictEqual(metaD.claudeDesktopModelRoutes["claude-fable-5"].model, "sub_agent_x", "Desktop fable 路由应取 tiers.subagent");
  console.log("✓ claude-desktop 条目 env 形态 + proxy 模式 + 四角色路由映射（显示名对齐上游模型）");

  // 6) 校验报错分支：未知 appType / 空 key / 空 model（不落库）
  assert.strictEqual(ccswitch.register({ appType: "foo", apiKey: "k", model: "m" }).ok, false, "未知 appType 应失败");
  assert.ok(/未知应用类型/.test(ccswitch.register({ appType: "foo", apiKey: "k", model: "m" }).message), "未知 appType 报错文案");
  assert.ok(/API Key/.test(ccswitch.register({ appType: "claude", apiKey: "  ", model: "m" }).message), "空 key 报错文案");
  assert.ok(/默认模型/.test(ccswitch.register({ appType: "claude", apiKey: "k", model: "" }).message), "空 model 报错文案");
  console.log("✓ 参数校验报错分支");

  // 7) 备份：至少 4 份（两次 claude + 一次 codex + 一次 claude-desktop）
  let backups = fs.readdirSync(path.join(tmp, "backups"));
  assert.ok(backups.length >= 4, "备份数量应 >=4，实际 " + backups.length + " -> " + backups.join(","));
  console.log("✓ 备份目录文件 =", backups.join(", "));

  // 8) 备份轮换：连续注册足够多次后，本应用前缀备份不超过保留上限（BACKUP_KEEP=10），
  //    且不误删非本应用文件（预先放一个别的备份文件当哨兵）
  fs.writeFileSync(path.join(tmp, "backups", "cc-switch.db.bak_user_manual"), "user sentinel");
  for (let i = 0; i < 12; i++) {
    ccswitch.register({ appType: "claude", apiKey: "sk-rotate", model: "m", port: 9527 });
  }
  backups = fs.readdirSync(path.join(tmp, "backups"));
  const mine = backups.filter((n) => n.startsWith("cc-switch.db.bak_agenthub_"));
  assert.ok(mine.length <= 10, "轮换后本应用备份应 <=10，实际 " + mine.length + " -> " + mine.join(","));
  assert.ok(backups.includes("cc-switch.db.bak_user_manual"), "哨兵备份不得被删");
  console.log("✓ 备份轮换保留 <=10 且不动其它备份");

  // 9) status 终态：都 registered
  s = ccswitch.status();
  assert.deepStrictEqual(
    s.entries.map((e) => [e.appType, e.registered]),
    [["claude", true], ["codex", true], ["claude-desktop", true]],
  );
  console.log("✓ status 终态全部已注册");

  // 10) 版本不兼容：providers 缺列 → status.incompatible + register 报版本不兼容
  const badCols = path.join(tmp, "bad-cols.db");
  makeDb(badCols, `CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT)`);
  process.env.CCSWITCH_DB_PATH = badCols;
  assert.strictEqual(ccswitch.status().incompatible, true, "缺列库 incompatible 应为 true");
  const rBad = ccswitch.register({ appType: "claude", apiKey: "k", model: "m" });
  assert.strictEqual(rBad.ok, false, "缺列库 register 应失败");
  assert.ok(/版本不兼容/.test(rBad.message), "应报版本不兼容: " + rBad.message);
  console.log("✓ 缺列库：incompatible + 「版本不兼容」报错");

  // 11) 无 providers 表 → status.incompatible + register 报表不存在
  const empty = path.join(tmp, "empty.db");
  makeDb(empty, null);
  process.env.CCSWITCH_DB_PATH = empty;
  assert.strictEqual(ccswitch.status().incompatible, true, "空库 incompatible 应为 true");
  const rEmpty = ccswitch.register({ appType: "claude", apiKey: "k", model: "m" });
  assert.strictEqual(rEmpty.ok, false, "空库 register 应失败");
  assert.ok(/providers 表不存在/.test(rEmpty.message), "应报表不存在: " + rEmpty.message);
  console.log("✓ 无 providers 表：incompatible + 表不存在报错");

  // 12) 缺库：整库不存在 → installed=false + register 失败
  // 注意：这里不能 delete 环境变量——那样会回退到真实 ~/.cc-switch/cc-switch.db，
  // 本机装有 CC Switch 时该库存在，断言就会假失败；指向临时目录下的确定不存在路径才隔离。
  process.env.CCSWITCH_DB_PATH = path.join(tmp, "missing", "cc-switch.db");
  assert.strictEqual(ccswitch.status().installed, false, "无库时 installed=false");
  const rNoDb = ccswitch.register({ appType: "claude", apiKey: "k", model: "m" });
  assert.strictEqual(rNoDb.ok, false, "无库时 register 应失败");
  console.log("✓ 缺库状态与报错");

  // 13) live 链路探测：读的是 os.homedir() 下的客户端配置文件。
  //     先把 USERPROFILE / HOME 指到 fixture 家目录（Windows 取 USERPROFILE、类 Unix 取 HOME，
  //     两个都设才跨平台），并**当场验证隔离真的生效**——不验证的话，这段会在本机读到
  //     用户真实的 ~/.claude/settings.json，断言可能因为用户恰好指向 9527 而假通过。
  const fakeHome = path.join(tmp, "home");
  fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  try {
    // 前置闸：先确认被测面真的在，再往下断言。缺字段时后面每一条都会以
    // 「Cannot read properties of undefined」崩掉，只报第一条、且看不出断的是什么
    assert.ok(typeof ccswitch.classifyLiveTarget === "function",
      "ccswitch 必须导出 classifyLiveTarget（分类边界的断言靠它）");
    assert.strictEqual(path.resolve(os.homedir()), path.resolve(fakeHome),
      "os.homedir() 必须跟着 USERPROFILE/HOME 走，否则本闸正在读用户真实配置（判据无意义）");

    fs.writeFileSync(path.join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9527" } }));
    // Codex 故意写两段 provider，且**把指向网关的那段放在前面**：当前生效的 custom 指向
    // CC Switch 本地代理。整份文件抓第一个 base_url 的实现会答「直连网关」，只有按
    // model_provider 选段才答得对——顺序反过来就变成两边都对的摆设判据。
    fs.writeFileSync(path.join(fakeHome, ".codex", "config.toml"),
      'model_provider = "custom"\n\n[model_providers.dormant]\nbase_url = "http://127.0.0.1:9527"\n\n[model_providers.custom]\nbase_url = "http://127.0.0.1:15721/v1"\n');
    process.env.CCSWITCH_DB_PATH = dbFile; // 第 12 段把它指去了不存在的路径，这里指回假库
    const sLive = ccswitch.status({ port: 9527 });
    assert.ok(sLive.live && sLive.live.claude && sLive.live.codex,
      "status({ port }) 必须回传 live.claude / live.codex（缺字段时下面的断言会崩成 TypeError）");
    assert.strictEqual(sLive.live.claude.target, "gateway", "claude live 指向 9527 应分类为直连网关");
    assert.strictEqual(sLive.live.claude.url, "http://127.0.0.1:9527", "claude live 应回传原始地址");
    assert.strictEqual(sLive.live.codex.target, "ccswitch", "codex live 指向 15721 应分类为经 CC Switch");
    assert.strictEqual(sLive.live.codex.url, "http://127.0.0.1:15721/v1",
      "codex 应按 model_provider 选段取 base_url，不能被另一段（指向网关的 dormant）带偏");
    // model_provider 指向的段根本不存在（用户删了一半）：必须按未配置处理，
    // 不能退回去读别段的地址——那会把一个没在用的 provider 地址报成当前链路
    fs.writeFileSync(path.join(fakeHome, ".codex", "config.toml"),
      'model_provider = "gone"\n\n[model_providers.custom]\nbase_url = "http://127.0.0.1:9527"\n');
    assert.strictEqual(ccswitch.status({ port: 9527 }).live.codex.target, "unset",
      "model_provider 指向缺失的段时应按未配置处理，不得回落到别段的 base_url");
    console.log("✓ live 链路探测：claude=直连网关 / codex=经 CC Switch（且按 model_provider 选段）");

    // 「未安装 CC Switch」那条分支也必须带 live：两处 return 只补一处，页面在最常见的
    // 「用户还没装 CC Switch」状态下就会显示成空值
    process.env.CCSWITCH_DB_PATH = path.join(tmp, "missing", "cc-switch.db");
    const sNoDb = ccswitch.status({ port: 9527 });
    assert.strictEqual(sNoDb.installed, false, "缺库分支仍应 installed=false");
    assert.strictEqual(sNoDb.live && sNoDb.live.claude.target, "gateway",
      "缺库分支同样要回传 live（fixture 的 settings.json 仍指向 9527）");
    process.env.CCSWITCH_DB_PATH = dbFile;

    // 读不到配置文件 → unset；分类纯函数边界
    fs.unlinkSync(path.join(fakeHome, ".claude", "settings.json"));
    const sUnset = ccswitch.status({ port: 9527 });
    assert.strictEqual(sUnset.live.claude.target, "unset", "读不到 settings.json 应按未配置处理");
    const cls = ccswitch.classifyLiveTarget;
    assert.strictEqual(cls("", 9527).target, "unset", "空地址应为 unset");
    assert.strictEqual(cls("https://api.example.com/v1", 9527).target, "other", "非本地地址应为 other");
    assert.strictEqual(cls("http://localhost:9527", 9527).target, "gateway", "localhost 同样算直连");
    assert.strictEqual(cls("not a url", 9527).target, "other", "解析失败应为 other");
    // 端口差一档必须不是「直连」：按 host 前缀或字符串包含来判的实现会在这里露出来
    assert.strictEqual(cls("http://127.0.0.1:9528", 9527).target, "other", "同机不同端口不是直连网关");
    assert.strictEqual(cls("http://127.0.0.1:9527/", 9527).target, "gateway", "尾斜杠应被剥掉");
    assert.strictEqual(cls("http://127.0.0.1:9527/v1", 9527).target, "gateway", "带路径前缀仍应认出网关");
    // URL.hostname 对 IPv6 回的是带方括号的形态，只认 "::1" 的实现会在这里露出来
    assert.strictEqual(cls("http://[::1]:9527", 9527).target, "gateway", "IPv6 回环同样算直连");
    assert.strictEqual(cls("http://[::1]:15721", 9527).target, "ccswitch", "IPv6 指向 CC Switch 端口应分类为经 CC Switch");
    console.log("✓ live 分类边界：unset / other / localhost / IPv6 / 坏地址 / 端口差档 / 尾斜杠与路径");
  } finally {
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n全部通过 ✓");
})().catch((e) => {
  console.error("✗ 异常：", e);
  process.exit(1);
});
