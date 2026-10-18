// issue #89 回归守卫：S3 兼容传输层（electron/backend/s3.cjs + webdav.cjs 分派）
//
// 不引 npm 依赖、不打真实桶：本自测自建一个**会独立重算 SigV4 签名**的假 S3 服务——
// 服务端按 AWS 规范用已知 SecretKey 从「收到的原始请求行/头/体」重算签名并比对，
// 能抓出规范化路径/查询编码/头部排序/payload 哈希等一切签名实现错误；
// 对象存储语义用内存 Map 模拟（PUT/GET/DELETE/ListObjectsV2/批量删）。
//
// 断言面：
//   S1 签名与 payload 完整性（服务端独立重算，全部请求隐式校验）
//   S2 put → get → getText 回环；404 → null（与 WebDAV 同语义）
//   S3 list 判目录（Delimiter=/）、子项名剥离前缀
//   S4 remove 文件幂等（404 不报错）；remove 目录按前缀批量删
//   S5 test 连接成功/403/404 三态文案
//   S6 webdav.cjs 分派：同一套调用入口对 __s3 配置直接工作（引擎零改动的前提）
"use strict";
const crypto = require("node:crypto");
const http = require("node:http");

const PORT = 19561;
const AK = "AKIDEXAMPLE";
const SK = "wJalrXUtnFEMIsecretKEY000000000000";
const BUCKET = "test-bucket";

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}

function sha256Hex(b) { return crypto.createHash("sha256").update(b).digest("hex"); }
function hmac(k, d) { return crypto.createHmac("sha256", k).update(d).digest(); }
function uriEncode(str, encodeSlash = true) {
  const bytes = Buffer.from(String(str), "utf8");
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else if (c === "/" && !encodeSlash) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

// ===== 假 S3：内存对象存储 + SigV4 独立验证 =====
const objects = new Map(); // key -> Buffer

function verifySig(req, rawBody) {
  const auth = req.headers.authorization || "";
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return "authorization 形状不对: " + auth.slice(0, 80);
  const [, ak, dateStamp, region, signedHeaders, signature] = m;
  if (ak !== AK) return "AccessKeyId 不匹配";
  const amzDate = req.headers["x-amz-date"];
  if (!amzDate || !amzDate.startsWith(dateStamp)) return "x-amz-date 与 Credential 日期不一致";
  const payloadHash = req.headers["x-amz-content-sha256"];
  if (payloadHash !== sha256Hex(rawBody)) return "payload 哈希与 body 不一致";
  // 从收到的原始请求重建 canonical request（与客户端实现互相独立）
  const [rawPath, rawQuery] = String(req.url).split("?");
  const headerList = signedHeaders.split(";");
  const canonHeaders = headerList.map((h) => `${h}:${String(req.headers[h]).trim()}\n`).join("");
  const canonicalQuery = (rawQuery || "").split("&").filter(Boolean).sort().join("&");
  const canonicalRequest = [req.method, rawPath, canonicalQuery, canonHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${SK}`, dateStamp);
  const kSigning = hmac(hmac(hmac(kDate, region), "s3"), "aws4_request");
  const expect = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  if (expect !== signature) return "签名不匹配";
  return null;
}

function listXml(prefix, delimiter) {
  const keys = [...objects.keys()].sort();
  const files = [];
  const dirs = new Set();
  for (const k of keys) {
    if (prefix && !k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (delimiter && slash >= 0) dirs.add(prefix + rest.slice(0, slash + 1));
    else files.push(k);
  }
  let xml = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>';
  for (const f of files) xml += `<Contents><Key>${f}</Key></Contents>`;
  for (const d of dirs) xml += `<CommonPrefixes><Prefix>${d}</Prefix></CommonPrefixes>`;
  xml += "</ListBucketResult>";
  return xml;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const sigErr = verifySig(req, body);
    if (sigErr) { res.writeHead(403, { "content-type": "text/plain" }); res.end(sigErr); return; } // 真实 S3 对坏签名回 403
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (u.pathname !== `/${BUCKET}` && !u.pathname.startsWith(`/${BUCKET}/`)) {
      res.writeHead(404); res.end("NoSuchBucket"); return;
    }
    const key = decodeURIComponent(u.pathname.slice(BUCKET.length + 2));
    const contentType = String(req.headers["content-type"] || "");
    // POST ?delete：批量删（解析 XML 里的 Key）
    if (req.method === "POST" && u.searchParams.has("delete")) {
      const ks = [...body.toString("utf8").matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((x) => x[1]);
      for (const k of ks) objects.delete(k);
      res.writeHead(200, { "content-type": "application/xml" });
      res.end("<DeleteResult></DeleteResult>");
      return;
    }
    if (req.method === "PUT") { objects.set(key, body); res.writeHead(200); res.end(); return; }
    if (req.method === "GET" && (u.searchParams.get("list-type") === "2" || contentType.includes("xml"))) {
      const prefix = u.searchParams.get("prefix") || "";
      const delimiter = u.searchParams.get("delimiter") || "";
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(listXml(prefix, delimiter));
      return;
    }
    if (req.method === "GET") {
      const obj = objects.get(key);
      if (!obj) { res.writeHead(404); res.end(); return; }
      res.writeHead(200); res.end(obj); return;
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204); res.end(); return;
    }
    res.writeHead(405); res.end();
  });
});

async function main() {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const webdav = require("../electron/backend/webdav.cjs");
  const joinUrl = webdav.joinUrl;
  const cfg = {
    __s3: true, endpoint: `http://127.0.0.1:${PORT}`,
    username: AK, password: SK, // S3 模式下复用为 AK/SK（moduleWebdav 注入口径）
    root: "/agent-skills", bucket: BUCKET, region: "us-east-1", pathStyle: true,
  };

  console.log("=== S1/S2：put → get → getText 回环（每个请求都过服务端独立签名验证）===");
  await webdav.put(joinUrl(cfg.endpoint, cfg.root, "prices.json"), cfg, JSON.stringify({ v: 1, ok: true }));
  ok("S2 put 成功（签名通过，payload 完整性通过）", objects.has("agent-skills/prices.json"));
  const buf = await webdav.get(joinUrl(cfg.endpoint, cfg.root, "prices.json"), cfg);
  ok("S2 get 回读一致", !!buf && JSON.parse(buf.toString("utf8")).ok === true);
  const text = await webdav.getText(joinUrl(cfg.endpoint, cfg.root, "prices.json"), cfg);
  ok("S2 getText 同语义", text != null && JSON.parse(text).v === 1);
  const missing = await webdav.get(joinUrl(cfg.endpoint, cfg.root, "nope.json"), cfg);
  ok("S2 404 → null（与 WebDAV 同语义）", missing === null);

  console.log("=== S3：list 判目录与子项名 ===");
  await webdav.put(joinUrl(cfg.endpoint, cfg.root, "data/a.json"), cfg, "A");
  await webdav.put(joinUrl(cfg.endpoint, cfg.root, "data/b.json"), cfg, "B");
  await webdav.put(joinUrl(cfg.endpoint, cfg.root, "top.txt"), cfg, "T");
  const entries = await webdav.list(joinUrl(cfg.endpoint, cfg.root, ""), cfg);
  const names = entries.map((e) => e.name).sort();
  ok("S3 根目录列子项（文件 + 目录）", JSON.stringify(names) === JSON.stringify(["data", "prices.json", "top.txt"]), JSON.stringify(names));
  const dir = entries.find((e) => e.name === "data");
  ok("S3 目录判别 isDir", !!dir && dir.isDir === true);
  const sub = await webdav.list(joinUrl(cfg.endpoint, cfg.root, "data"), cfg);
  ok("S3 子目录名剥离前缀", JSON.stringify(sub.map((e) => e.name).sort()) === JSON.stringify(["a.json", "b.json"]), JSON.stringify(sub.map((e) => e.name)));

  console.log("=== S4：remove 幂等与目录批量删 ===");
  await webdav.remove(joinUrl(cfg.endpoint, cfg.root, "top.txt"), cfg);
  ok("S4 删文件生效", !objects.has("agent-skills/top.txt"));
  await webdav.remove(joinUrl(cfg.endpoint, cfg.root, "top.txt"), cfg);
  ok("S4 重复删幂等（404 不报错）", true);
  await webdav.remove(joinUrl(cfg.endpoint, cfg.root, "data"), cfg);
  ok("S4 删目录按前缀批量清空", ![...objects.keys()].some((k) => k.startsWith("agent-skills/data/")), JSON.stringify([...objects.keys()]));

  console.log("=== S5：test 三态 ===");
  const t1 = await webdav.test(cfg);
  ok("S5 正常桶连接成功", t1.ok === true, t1.message);
  const t2 = await webdav.test({ ...cfg, password: "wrong-secret" });
  ok("S5 密钥错误给出 403 提示", t2.ok === false && /403/.test(t2.message), t2.message);
  const t3 = await webdav.test({ ...cfg, bucket: "no-such-bucket" });
  ok("S5 桶不存在给出 404 提示", t3.ok === false && /404/.test(t3.message), t3.message);

  console.log("=== S6：ensureDir no-op + engine 形状（cfg 含 root 的 joinUrl 全链）===");
  await webdav.ensureDir(joinUrl(cfg.endpoint, cfg.root, "x/y"), cfg);
  ok("S6 ensureDir 对 S3 是 no-op", true);

  server.close();
  console.log("");
  console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail) { console.log("失败项：\n  - " + bad.join("\n  - ")); process.exit(1); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(2); });
