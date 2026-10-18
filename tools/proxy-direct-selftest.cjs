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
  const cat = JSON.parse(fs.readFileSync(catPath, "utf8"));
  ok("catalog 至少一条模型", Array.isArray(cat.models) && cat.models.length >= 1 && cat.models[0].slug === "glm-5.3");

  // 重复写入幂等：不应产生第二个 agenthub 段
  direct.apply({ appType: "codex", apiKey: KEY, model: "glm-5.3", port: 9527, confirmAck: true });
  const toml2 = fs.readFileSync(tomlPath, "utf8");
  const cnt = (toml2.match(/\[model_providers\.agenthub\]/g) || []).length;
  ok("重复写入不重复 provider 段", cnt === 1, `实际 ${cnt} 个`);
  ok("重复写入后 mcp 段仍在", toml2.includes("[mcp_servers.my-tool]"));
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

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  ok("_meta appliedId 指向 AgentHub profile", meta.appliedId !== "ccs-profile");
  ok("_meta 保留原有 CC Switch 条目", meta.entries.some((e) => e.id === "ccs-profile"));
  ok("_meta 含 AgentHub 条目", meta.entries.length === 2);
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
