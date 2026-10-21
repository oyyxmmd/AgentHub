// Trae 模型目录过滤自测：拉取 get_detail_param 时，表里混着的三类「不是模型」的条目
// 必须被滤掉，而**字段缺失的条目必须放行**（缺省 = 可见）。
//
// 判据来源：对 38 条实测目录的校准结论 ——
//   ① is_invisible_to_user = true   → 内部 subagent / 实验通道
//   ② display_config.display_name 为空 → 租户自定义模型的占位模板
//   ③ config_switch = false          → 已下线开关
// 同时钉住「三个布尔字段一律缺省 = 可见」：上游删字段时若把整张表滤空，
// 用户看到的是「上游没模型了」，而真相是本机判空判错了 —— 那是最坏的失效方式。
//
// 本自测不起网络：用本地 http 服务冒充 get_detail_param，只验证解析与过滤这一段。
// 用法：node tools/proxy-trae-catalog-selftest.cjs
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let failures = 0;
function assert(cond, label, extra) {
  if (cond) {
    console.log("  ok   " + label);
  } else {
    failures++;
    console.error("  FAIL " + label + (extra ? " —— " + extra : ""));
  }
}

/** 造一条 config_info 条目（参数即上游真实字段名，便于对照判据） */
function entry(configName, displayName, extra) {
  return {
    config_name: configName,
    display_config: { display_name: displayName, model_capability: "chat_model" },
    ...(extra || {}),
  };
}

async function main() {
  const r = [];
  // ---- 目录样本：4 条该留、4 条该滤 ----
  r.push(entry("glm-5.3", "GLM-5.3"));
  r.push(entry("kimi-k3", "Kimi-K3"));
  // 缺省字段的条目：必须留（缺省 = 可见）
  r.push({ config_name: "minimax-m3", display_config: { display_name: "MiniMax-M3" } });
  // display_config 整个缺失但 config 名合法：按 ③ 的判据会被「display_name 为空」滤掉，
  // 这是既有的取舍（没有展示名的条目不是可选模型）。这里单独断言，避免回归成"保留"。
  r.push(entry("browser_use_subagent", "Browser Use Subagent", { is_invisible_to_user: true }));
  r.push(entry("summary", "")); // display_name 空 → 占位模板
  r.push(entry("glm-5-turbo", "GLM-5 Turbo", { config_switch: false })); // 已下线
  // 相邻反例：名字相近但字段正常 → 必须留（防「前缀匹配误杀」，issue #10 的教训）
  r.push(entry("glm-5.3-flash", "GLM-5.3-Flash"));

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0, config_info_list: r }));
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;

  // ---- 用临时数据目录承载 rules 热加载（不碰真实用户数据） ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-catalog-"));
  const locFile = path.join(os.homedir(), ".Dosage_sync.location");
  const prevLoc = fs.existsSync(locFile) ? fs.readFileSync(locFile, "utf8") : null;
  fs.writeFileSync(locFile, JSON.stringify({ path: dir }));
  try {
    const rules = require("../electron/backend/proxy/rules.cjs");
    const cfgPath = path.join(rules.rulesDir(), "headers.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.trae.modelsUrl = `http://127.0.0.1:${port}/api/ide/v1/get_detail_param`;
    cfg.trae.mirrorModelsUrl = "";
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    rules.reload("headers.json");

    const adapters = require("../electron/backend/proxy/adapters.cjs");
    const trae = adapters.get("trae");
    const out = await trae.fetchModels({ id: "t1", uid: "u1" }, { token: "tk" });
    assert(out && out.ok === true, "目录拉取成功", JSON.stringify(out && out.message));
    const ids = (out.models || []).map((m) => m.id);
    console.log("  解析结果：" + JSON.stringify(ids));

    assert(ids.includes("glm-5.3") && ids.includes("kimi-k3"), "普通模型保留");
    assert(ids.includes("minimax-m3"), "字段缺省（无 is_invisible_to_user / config_switch）的模型保留");
    assert(!ids.includes("browser_use_subagent"), "is_invisible_to_user=true 被滤掉");
    assert(!ids.includes("summary"), "display_name 为空的占位模板被滤掉");
    assert(!ids.includes("glm-5-turbo"), "config_switch=false 的已下线模型被滤掉");
    assert(ids.includes("glm-5.3-flash"), "名字相近但字段正常的模型不被误杀（前缀匹配教训）");

    // 展示名取自 display_config.display_name（不是 config 名）
    const glm = (out.models || []).find((m) => m.id === "glm-5.3");
    assert(glm && glm.name === "GLM-5.3", "展示名取 display_config.display_name");
  } finally {
    server.close();
    if (prevLoc === null) fs.rmSync(locFile, { force: true });
    else fs.writeFileSync(locFile, prevLoc);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures ? `\nRESULT: ${failures} failed` : "\nTrae 目录过滤自测全过");
  // 与 workbuddy 保活自测同一处置：Windows 上 fetch 连接池会在强退时与 libuv 抢跑，
  // 触发 UV_HANDLE_CLOSING 断言并把退出码变成 127。让事件循环自然收尾，5 秒兜底。
  process.exitCode = failures ? 1 : 0;
  const t = setTimeout(() => process.exit(failures ? 1 : 0), 5000);
  t.unref();
}

main().catch((e) => {
  console.error("自测异常：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
