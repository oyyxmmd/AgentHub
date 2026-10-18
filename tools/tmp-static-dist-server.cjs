// 极简静态 dist 服务器：供 tools/window-mode-main-e2e.cjs 喂真实 main.cjs 用。
// 用法：node tools/tmp-static-dist-server.cjs <port>
// 行为：把 dist/ 目录当站点根目录提供；主进程经 VITE_DEV_SERVER_URL 指到它即可
// 加载构建产物，不必真的起 vite（vite 启动慢且依赖 dev 依赖树）。
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.argv[2]) || 1421;
const ROOT = path.join(__dirname, "..", "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const server = http.createServer((req, res) => {
  try {
    // SPA：无后缀或路径不存在时回退 index.html（前端路由走 hash，其实用不到，但稳妥）
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    let file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`static dist server on http://127.0.0.1:${PORT} (root=${ROOT})`);
});
