// 账号导入格式自测（issue #143）
// 运行：node scripts/test-account-import-formats.cjs
// 重点：桌面端「导出选中账号」是元数据包（无 token），必须给出可行动错误；
//       带 token 的裸数组 / {accounts:[]} 包装仍能正常解析。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-import-formats-"));
process.env.AGENTHUB_DATA_DIR = TMP;

let pass = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", msg);
  } else {
    failed++;
    console.log("  \u2717", msg, got !== undefined ? `→ got ${JSON.stringify(got).slice(0, 300)}` : "");
  }
}

try {
  const proxy = require("../electron/backend/proxy/index.cjs");
  const parse = proxy.parseAccountsJson;

  console.log("\n[1] 桌面端元数据导出（format=agenthub-accounts，无 token）");
  {
    const metadata = JSON.stringify({
      format: "agenthub-accounts",
      exportedAt: "2026-10-18T00:00:00.000Z",
      channel: "modelscope",
      accounts: [
        { id: "a1", channel: "modelscope", uid: "u1", name: "号1", note: "", source: "paste", status: "ok" },
        { id: "a2", channel: "modelscope", uid: "u2", name: "号2", note: "", source: "paste", status: "ok" },
      ],
    });
    const r = parse(metadata, "modelscope");
    ok(r.reason === "metadata-only", "识别为元数据包（不再按缺 token 报错）", r);
    ok(r.list.length === 0 && r.invalid === 2, "不产出任何可导入账号，并如实计数", r);
    ok(/元数据/.test(proxy.METADATA_ONLY_MESSAGE) && /号池同步/.test(proxy.METADATA_ONLY_MESSAGE), "提示文案指向号池同步", proxy.METADATA_ONLY_MESSAGE);
  }

  console.log("\n[2] 带 token 的裸数组 / {accounts:[]} 包装仍正常");
  {
    const one = { channel: "modelscope", uid: "u1", name: "号1", token: "ms-token" };
    const a = parse(JSON.stringify([one]), "modelscope");
    ok(a.list.length === 1 && a.list[0].token === "ms-token" && !a.reason, "裸数组解析成功", a);
    const b = parse(JSON.stringify({ channel: "modelscope", accounts: [one] }), "modelscope");
    ok(b.list.length === 1 && b.list[0].uid === "u1" && !b.reason, "{accounts:[]} 包装解析成功", b);
  }

  console.log("\n[3] 缺 token / 非法 JSON 的既有语义不变");
  {
    const missing = parse(JSON.stringify([{ channel: "modelscope", uid: "u1" }]), "modelscope");
    ok(missing.list.length === 0 && missing.invalid === 1 && !missing.reason, "缺 token 仍按无效记录计数", missing);
    let err = "";
    try { parse("{not-json", "modelscope"); } catch (e) { err = e.message; }
    ok(/JSON 解析失败/.test(err), "非法 JSON 仍抛出可读错误", err);
  }

  console.log(`\n${failed ? "\u2717" : "OK"} 账号导入格式自测：${pass} 项通过，${failed} 项失败`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
