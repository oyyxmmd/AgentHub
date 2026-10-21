// HTTP header ByteString 边界自测（issue #148）
// 运行：node tools/test-header-bytesafe.cjs
// 覆盖：util 纯函数、Qoder 领取/状态探测的 header、统一 httpJson/fetchStream 出口。
"use strict";
const util = require("../electron/backend/proxy/util.cjs");

let pass = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", msg);
  } else {
    failed++;
    console.log("  \u2717", msg, got !== undefined ? `→ got ${JSON.stringify(got).slice(0, 200)}` : "");
  }
}

const CN_HOST = "御风-PC";
const utf8Bytes = (s) => Buffer.from(s, "utf8").toString("latin1");

(async () => {
  console.log("\n[1] util 纯函数");
  {
    ok(!/[^\x00-\xff]/.test(util.byteSafeHeaderValue(CN_HOST)), "中文 hostname 转成 ByteString");
    ok(Buffer.from(util.byteSafeHeaderValue(CN_HOST), "latin1").toString("utf8") === CN_HOST, "UTF-8 字节可无损还原");
    const ascii = util.byteSafeHeaderValue("PC-01");
    ok(ascii === "PC-01", "ASCII 值逐字不变", ascii);
    const headers = { A: "b" };
    ok(util.byteSafeHeaders(headers) === headers, "全 ASCII header 原样返回同一个对象（零行为变更）");
    const mixed = util.byteSafeHeaders({ A: "b", B: CN_HOST });
    ok(mixed !== headers && mixed.A === "b" && Buffer.from(mixed.B, "latin1").toString("utf8") === CN_HOST, "混合 header 只改非 Latin-1 项");
  }

  console.log("\n[2] 底层 fetch 确实会拒绝非 Latin-1 header（复现 issue #148）");
  {
    let err = "";
    try {
      await fetch("http://127.0.0.1:1", { headers: { "Cosy-MachineHostname": CN_HOST } });
    } catch (e) {
      err = e.message;
    }
    ok(/ByteString/.test(err) && /24481/.test(err), "未清洗的 header 触发 ByteString 错误", err);
  }

  console.log("\n[3] Qoder checkin / checkinStatus：中文计算机名不再报 ByteString");
  {
    const os = require("node:os");
    const origHostname = os.hostname;
    os.hostname = () => CN_HOST;
    const captured = [];
    try {
      const { makeQoder } = require("../electron/backend/proxy/qoderAdapter.cjs");
      const deps = {
        rules: { get: () => ({ qoder: { openApi: "https://openapi.test", userAgent: "Qoder", cosyVersion: "0.4.3" } }), rulesDir: () => os.tmpdir() },
        auth: { readRiskIdentity: () => ({ machineToken: "tok", machineType: "ty", machineCode: "co" }) },
        httpJson: async (url, opts) => {
          captured.push(opts.headers);
          return { ok: true, status: 200, data: { campaigns: [] } };
        },
        util,
        signer: { createSession: async () => { throw new Error("stub"); } },
        store: null,
      };
      const ad = makeQoder("qoder", deps);
      const account = { uid: "u1", meta: { machineId: "00000000-0000-0000-0000-000000000000" } };
      const secrets = { token: "dt-test" };
      const r1 = await ad.checkin(account, secrets);
      const r2 = await ad.checkinStatus(account, secrets);
      ok(!/ByteString/.test(String(r1.message || "")), "checkin 不再返回 ByteString 错误", r1);
      ok(!/ByteString/.test(String(r2.message || "")), "checkinStatus 不再返回 ByteString 错误", r2);
      ok(captured.length === 2, "两次请求都发出了", captured.length);
      for (const h of captured) {
        ok(!/[^\x00-\xff]/.test(String(h["Cosy-MachineHostname"] || "")), "Cosy-MachineHostname 是 ByteString");
        ok(Buffer.from(String(h["Cosy-MachineHostname"] || ""), "latin1").toString("utf8") === CN_HOST, "Cosy-MachineHostname 可还原为中文机器名");
        let fetchErr = "";
        try {
          await fetch("http://127.0.0.1:1", { headers: h });
        } catch (e) {
          fetchErr = e.message;
        }
        ok(!/ByteString/.test(fetchErr), "清洗后的整组 header 能通过 undici 校验（不再 ByteString）", fetchErr);
      }
    } finally {
      os.hostname = origHostname;
    }
  }

  console.log("\n[4] 统一 HTTP 出口：httpJson / fetchStream 兜底清洗");
  {
    const adapters = require("../electron/backend/proxy/adapters.cjs");
    const origFetch = global.fetch;
    let captured = null;
    try {
      global.fetch = async (url, opts) => {
        captured = opts.headers;
        return { ok: true, status: 200, headers: new Headers(), body: null, text: async () => "{}" };
      };
      const r = await adapters.httpJson("http://test.local", { method: "GET", headers: { "X-Test": CN_HOST, "X-Ascii": "ok" } });
      ok(r.ok && captured && captured["X-Ascii"] === "ok", "httpJson 请求成功且 ASCII header 不变");
      ok(!/[^\x00-\xff]/.test(String(captured["X-Test"] || "")), "httpJson 的非 Latin-1 header 已清洗");
      ok(Buffer.from(String(captured["X-Test"] || ""), "latin1").toString("utf8") === CN_HOST, "httpJson header 可还原");

      captured = null;
      const stream = await adapters.fetchStream("http://test.local", { headers: { "X-Test": CN_HOST } });
      stream.cancelTimer();
      ok(!/[^\x00-\xff]/.test(String(captured["X-Test"] || "")), "fetchStream 的非 Latin-1 header 已清洗");
      ok(Buffer.from(String(captured["X-Test"] || ""), "latin1").toString("utf8") === CN_HOST, "fetchStream header 可还原");
    } finally {
      global.fetch = origFetch;
    }
  }

  console.log(`\n${failed ? "\u2717" : "OK"} HTTP header ByteString 自测：${pass} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
