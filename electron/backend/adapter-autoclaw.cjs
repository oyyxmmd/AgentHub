// AutoClaw（智谱 AutoGLM 桌面端）数据源适配器
// 权威数据源：%APPDATA%\AutoClaw-official\accounts\<账号key>\runtime\runtime.sqlite（SQLite 明文，只读）
//   国际版客户端装在 %APPDATA%\AutoClaw-oversea-official；旧版目录 %APPDATA%\AutoClaw 一并兼容扫描。
//   detect 按上述优先级取第一个「accounts/*/runtime/runtime.sqlite」存在的根；双区并存时另一区
//   可通过「配置 · 用量统计 · 数据源」的自定义目录指过去（目录可以是根、账号目录或 runtime 目录）。
// 两个用量载体（口径与客户端自身计费投影 projectRunBillingUsage 一致，见官方 main.cjs 0078 迁移注释
// 「run 总账 = 父 loop + Σ子 attempt，计费含子代理」——库里两处互不包含，读取方相加得总账）：
//   - work_runs.usage_json：主循环（直答 / 协作编排者）一次 run 的 token 账，run 收尾时写入（进行中为 NULL）；
//   - collaboration_run_agent_attempts.usage_json：协作子代理每次 attempt 的 token 账，结算时写入。
//   两处各自成条入库，聚合时自然相加、与客户端计费一致，不会重复计（2026-10 本机实测核对）。
// usage_json 口径（2026-10-19 本机实测 11 条逐条核对）：totalTokens = input + output + cacheRead + cacheWrite，
//   即 input 是「新鲜输入」、与 cacheRead 互斥（cacheWrite 实测恒 0，智谱侧不单列缓存写入）。
//   入库时 inputTokens 必须补入 cacheRead，对齐全系统基线「input_tokens 含 cache_read_tokens」：
//   db.cjs 的净输入按 input_tokens - cache_read_tokens 相减、命中率按 cache_read_tokens / input_tokens 计算，
//   口径错位会导致命中率超 100%、计费净输入为负、总量少算整份缓存读（与 dsh/mimo 同款归一化）。
// 设备标识：<root>\device\device-id.json 的 deviceId（客户端安装级稳定 id）；
//   缺失回退第一个账号目录名（账号 key），再缺失返回 null（上层兜底）。
// 幂等键：`${deviceId}:autoclaw:${账号key}:run:${run_id}` 与 `...:attempt:${participant_id}:${attempt}`；
//   增量按「账目落定时间」判（run 用 updated_at、attempt 用 settled_at），因为 usage_json 在
//   created_at 之后才写入，可能晚于增量锚点（跨 24h 回扫窗的长 run 也因此不漏），配合
//   db 层 INSERT OR REPLACE 同键覆盖，不重不漏。
// 自测注入：环境变量 AUTOCLAW_USAGE_HOME 把根指到临时目录，绝不碰真实数据。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeModel, providerByModel } = require("./adapter-zcode.cjs");

const ID = "autoclaw";
const NAME = "AutoClaw";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function appDataDir() {
  return process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming");
}

/** 数据根候选：AutoClaw 自测环境变量 > 国内 official > 国际 oversea > 旧版目录 */
function candidateRoots() {
  const env = String(process.env.AUTOCLAW_USAGE_HOME || "").trim();
  if (env) return [path.resolve(env)];
  return [
    path.join(appDataDir(), "AutoClaw-official"),
    path.join(appDataDir(), "AutoClaw-oversea-official"),
    path.join(appDataDir(), "AutoClaw"),
  ];
}

/** 目录下的 runtime.sqlite 清单：兼容根（accounts/*）、账号目录（runtime/）、runtime 目录本身三种指法 */
function accountDbs(dir) {
  if (!dir) return [];
  const direct = path.join(dir, "runtime.sqlite");
  if (fs.existsSync(direct)) return [direct];
  const nested = path.join(dir, "runtime", "runtime.sqlite");
  if (fs.existsSync(nested)) return [nested];
  const accountsDir = path.join(dir, "accounts");
  const out = [];
  try {
    for (const entry of fs.readdirSync(accountsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const db = path.join(accountsDir, entry.name, "runtime", "runtime.sqlite");
      if (fs.existsSync(db)) out.push(db);
    }
  } catch {
    /* 无 accounts 目录：按 0 个账号处理 */
  }
  return out;
}

/** 第一个有账号库的根（detect 契约：返回数据根，无数据返回 null） */
function detect() {
  for (const root of candidateRoots()) {
    if (accountDbs(root).length > 0) return root;
  }
  return null;
}

/** 校验：目录能解析出至少一个非空账号库 */
function validate(dir) {
  try {
    return accountDbs(dir).some((db) => fs.statSync(db).size > 0);
  } catch {
    return false;
  }
}

/** 设备标识：向上找 device/device-id.json（自定义目录可能指进账号/runtime 层）；回退账号目录名 */
function getDeviceId(dir) {
  let cur = dir ? path.resolve(dir) : null;
  for (let i = 0; cur && i < 4; i++) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(cur, "device", "device-id.json"), "utf8"));
      if (typeof v.deviceId === "string" && v.deviceId) return v.deviceId;
    } catch {
      /* 继续向上 */
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const root of (dir ? [dir, ...candidateRoots()] : candidateRoots())) {
    const dbs = accountDbs(root);
    if (dbs.length > 0) {
      // <root>\accounts\<账号key>\runtime\runtime.sqlite → 倒数第 3 段是账号 key
      const parts = dbs[0].split(/[\\/]/);
      return parts[parts.length - 3] || null;
    }
  }
  return null;
}

/** 非负整数兜底（与 grok/opensquilla 同款） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 时间戳兼容读取：epoch ms 数字 / ISO 字符串；非法返回 null */
function toMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  const s = String(v).trim();
  if (!s) return null;
  const iso = Date.parse(s);
  return Number.isNaN(iso) ? null : iso;
}

/** usage_json 解析：四桶 + totalTokens；结构非法返回 null。
 *  注意 input 是新鲜输入（不含 cacheRead），入库前需按文件头口径补入。 */
function parseUsage(raw) {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw);
    if (!u || typeof u !== "object") return null;
    return {
      input: num(u.input),
      output: num(u.output),
      cacheRead: num(u.cacheRead),
      cacheWrite: num(u.cacheWrite),
      totalTokens: num(u.totalTokens),
    };
  } catch {
    return null;
  }
}

/** 供应商推断：模型名优先（zai_* → 智谱 GLM 等，与 ZCode 同表）；推断不出时 AutoClaw 只连智谱侧 */
function providerFor(modelRaw) {
  return providerByModel(String(modelRaw || "")) || providerByModel(normalizeModel(modelRaw)) || "智谱 AutoGLM";
}

/**
 * 增量抽取：遍历目录下全部账号库（单库损坏/缺表跳过不阻断），取
 *   - work_runs：usage_json 非空且 max(updated_at, created_at) > since 的行（主循环账）；
 *   - collaboration_run_agent_attempts：usage_json 非空且 max(settled_at, started_at) > since 的行（子代理账）。
 * since 为毫秒（统一锚点口径，0 = 全量）。四桶全 0 的空轮次不入库。
 */
function extract(dir, deviceId, deviceName, since) {
  const dbs = accountDbs(dir);
  if (dbs.length === 0) throw new Error(`未找到 ${NAME} 账号数据库：${dir}`);
  const sinceMs = Math.floor(since > 0 ? since : 0);
  const out = [];
  const errors = [];

  for (const dbFile of dbs) {
    // 账号 key 只用于幂等键防撞（多账号/多根同 run_id 时互不覆盖）：
    // <root>\accounts\<账号key>\runtime\runtime.sqlite → 倒数第 3 段；自定义指法取不到时用整路径哈希
    const parts = dbFile.split(/[\\/]/);
    const accountKey = parts.length >= 4 ? parts[parts.length - 3] : dbFile;
    let conn;
    try {
      conn = new DatabaseSync(dbFile, { readOnly: true });
    } catch (e) {
      errors.push(`${accountKey}: 打开失败 ${e.message}`);
      continue;
    }
    try {
      // 表存在性：PRAGMA 失败（库损坏/被占用）必须上抛给外层按账号记账，
      // 只有「PRAGMA 成功但表不存在」（旧版本库）才返回 false 静默跳过
      const has = (table) => {
        // 表名全部来自本文件硬编码常量，无注入面
        const cols = conn.prepare(`PRAGMA table_info(${table})`).all();
        return cols.length > 0;
      };
      // work_runs：缺 usage_json 列视为旧版本库，跳过该库的 run 账
      if (has("work_runs")) {
        const runCols = new Set(conn.prepare("PRAGMA table_info(work_runs)").all().map((c) => c.name));
        if (runCols.has("run_id") && runCols.has("usage_json") && runCols.has("created_at")) {
          const pick = (c) => (runCols.has(c) ? c : "NULL");
          const rows = conn
            .prepare(
              `SELECT run_id, ${pick("session_id")} AS session_id, ${pick("status")} AS status,
                      ${pick("collaboration_mode")} AS collaboration_mode,
                      ${pick("execution_intent")} AS execution_intent,
                      ${pick("connection_model")} AS connection_model,
                      created_at, ${pick("updated_at")} AS updated_at, usage_json
                 FROM work_runs WHERE usage_json IS NOT NULL`
            )
            .all();
          for (const row of rows) {
            const usage = parseUsage(row.usage_json);
            if (!usage) continue;
            if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) continue;
            const startedAt = toMs(row.created_at);
            if (!startedAt) continue;
            const updatedMs = toMs(row.updated_at) ?? startedAt;
            if (Math.max(updatedMs, startedAt) <= sinceMs) continue; // 账目落定早于锚点窗口，早已入库
            const completedMs = row.status === "running" ? null : updatedMs;
            out.push({
              id: `${deviceId}:autoclaw:${accountKey}:run:${row.run_id}`,
              deviceId,
              deviceName,
              source: ID,
              providerId: providerFor(row.connection_model),
              modelId: row.connection_model ? normalizeModel(row.connection_model) : "unknown",
              sessionId: row.session_id || undefined,
              mode: row.collaboration_mode || row.execution_intent || undefined,
              inputTokens: usage.input + usage.cacheRead,
              outputTokens: usage.output,
              reasoningTokens: 0,
              cacheCreationTokens: usage.cacheWrite,
              cacheReadTokens: usage.cacheRead,
              startedAt,
              completedAt: completedMs ?? undefined,
              durationMs: completedMs ? Math.max(0, completedMs - startedAt) : undefined,
              status: row.status || "success",
            });
          }
        }
      }
      // 协作子代理 attempt 账：旧版本库无此表时跳过
      if (has("collaboration_run_agent_attempts")) {
        const attemptCols = new Set(conn.prepare("PRAGMA table_info(collaboration_run_agent_attempts)").all().map((c) => c.name));
        if (attemptCols.has("participant_id") && attemptCols.has("usage_json") && attemptCols.has("started_at")) {
          const pick = (c) => {
            const name = c.replace(/^a\./, ""); // 传入可带表前缀，PRAGMA 列集合里是裸列名
            return attemptCols.has(name) ? `a.${name}` : "NULL";
          };
          const rows = conn
            .prepare(
              `SELECT a.participant_id, a.attempt, ${pick("a.agent_id")} AS agent_id,
                      ${pick("a.outcome")} AS outcome,
                      ${pick("a.actual_model_json")} AS actual_model_json,
                      a.started_at, ${pick("a.settled_at")} AS settled_at, a.usage_json
                      ${has("collaboration_run_agent_participations") ? ", p.name AS participant_name" : ", NULL AS participant_name"}
                      ${has("work_runs") ? ", r.session_id AS session_id" : ", NULL AS session_id"}
                 FROM collaboration_run_agent_attempts a
                 ${has("collaboration_run_agent_participations") ? "LEFT JOIN collaboration_run_agent_participations p ON p.participation_id = a.participation_id" : ""}
                 ${has("work_runs") ? "LEFT JOIN work_runs r ON r.run_id = a.run_id" : ""}
                WHERE a.usage_json IS NOT NULL`
            )
            .all();
          for (const row of rows) {
            const usage = parseUsage(row.usage_json);
            if (!usage) continue;
            if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) continue;
            const startedAt = toMs(row.started_at);
            if (!startedAt) continue;
            const settledMs = toMs(row.settled_at);
            if (Math.max(settledMs ?? 0, startedAt) <= sinceMs) continue;
            let modelRaw = null;
            try {
              const m = JSON.parse(row.actual_model_json);
              if (m && typeof m.model === "string") modelRaw = m.model;
            } catch {
              /* 模型信息缺失时按 unknown 计 */
            }
            out.push({
              id: `${deviceId}:autoclaw:${accountKey}:attempt:${row.participant_id}:${row.attempt ?? 1}`,
              deviceId,
              deviceName,
              source: ID,
              providerId: providerFor(modelRaw),
              modelId: modelRaw ? normalizeModel(modelRaw) : "unknown",
              sessionId: row.session_id || undefined,
              agent: row.participant_name || row.agent_id || undefined,
              mode: "subagent",
              inputTokens: usage.input + usage.cacheRead,
              outputTokens: usage.output,
              reasoningTokens: 0,
              cacheCreationTokens: usage.cacheWrite,
              cacheReadTokens: usage.cacheRead,
              startedAt,
              completedAt: settledMs ?? undefined,
              durationMs: settledMs ? Math.max(0, settledMs - startedAt) : undefined,
              status: row.outcome || "running",
            });
          }
        }
      }
    } catch (e) {
      errors.push(`${accountKey}: ${e.message}`);
    } finally {
      try { conn.close(); } catch { /* 已关闭 */ }
    }
  }

  // 全部账号库都不可读才算源失败；个别库损坏由 errors 提示进日志上下文
  if (out.length === 0 && errors.length > 0 && errors.length === dbs.length) {
    throw new Error(`${NAME} 账号库全部不可读：${errors.join("；")}`);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract, _internal: { accountDbs, parseUsage, providerFor, toMs, num } };
