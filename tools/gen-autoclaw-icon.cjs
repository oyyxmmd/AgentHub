// AutoClaw 双渠道图标生成器：自绘「爪印」意象（大掌垫 + 三趾垫，青蓝主色），
// 256×256 PNG（与其它渠道图标同尺寸）。两地共用同一图形，右下角地区角标区分：
// autoclaw.png = CN / autoclaw_intl.png = INTL（深色圆角底 + 3×5 像素字模白字）。
//
// 为什么用脚本自绘：图形自行设计不与上游一致，且本项目图标资产是
// 入库 PNG；脚本留仓库，改形状/配色可复现。3×3 超采样出抗锯齿边缘。
//
// 用法：node tools/gen-autoclaw-icon.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 256;
const TEAL = [36, 158, 186, 255]; // 主色（青蓝）
const TEAL_DEEP = [24, 122, 148, 255]; // 趾垫内圈（深一档）
const BADGE_BG = [30, 41, 59, 235]; // 角标底（深灰蓝，微透明）
const BADGE_FG = [255, 255, 255, 255]; // 角标文字

/** 3×5 像素字模（1=着色） */
const GLYPHS = {
  C: ["011", "100", "100", "100", "011"],
  N: ["1001", "1101", "1011", "1001", "1001"],
  I: ["111", "010", "010", "010", "111"],
  T: ["111", "010", "010", "010", "010"],
  L: ["100", "100", "100", "100", "111"],
};

function inCircle(px, py, cx, cy, r) {
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** 圆角矩形（椭圆角）：内缩 radius 的四分之一圆检验 */
function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) return true;
  return px >= x + r && px <= x + w - r;
}

/** 渲染一个渠道图标：claw = 爪印；badge = "CN" / "INTL"（null 不画角标） */
function render(badge) {
  const out = Buffer.alloc(SIZE * SIZE * 4, 0);
  const toe = [
    { cx: 84, cy: 86, r: 30 },
    { cx: 128, cy: 66, r: 32 },
    { cx: 172, cy: 86, r: 30 },
  ];
  const palm = { cx: 128, cy: 158, rx: 64, ry: 54 };
  const badgeW = badge ? 14 + String(badge).length * 4 * 4 : 0; // 4px/字模像素 + 7px 内边距 ×2
  const badgeH = 5 * 4 + 12;
  const badgeX = SIZE - badgeW - 10;
  const badgeY = SIZE - badgeH - 10;
  const glyphScale = 4;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let acc = [0, 0, 0, 0];
      let samples = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3;
          const py = y + (sy + 0.5) / 3;
          samples += 1;
          let color = null;
          for (const t of toe) {
            if (inCircle(px, py, t.cx, t.cy, t.r)) color = TEAL;
          }
          if (((px - palm.cx) / palm.rx) ** 2 + ((py - palm.cy) / palm.ry) ** 2 <= 1) color = TEAL;
          // 趾垫内圈（同形缩小 55%，给爪印一点层次）
          for (const t of toe) {
            if (inCircle(px, py, t.cx, t.cy - 2, t.r * 0.55)) color = TEAL_DEEP;
          }
          if (((px - palm.cx) / (palm.rx * 0.6)) ** 2 + (((py - palm.cy) - 8) / (palm.ry * 0.55)) ** 2 <= 1) color = TEAL_DEEP;
          if (badge && inRoundedRect(px, py, badgeX, badgeY, badgeW, badgeH, 8)) color = BADGE_BG;
          if (badge) {
            // 角标文字：字模逐像素点亮（整体居中在角标内）
            const gx = Math.floor((px - badgeX - 7) / glyphScale);
            const gy = Math.floor((py - badgeY - 6) / glyphScale);
            if (gy >= 0 && gy < 5) {
              let cursor = 0;
              for (const ch of String(badge)) {
                const rows = GLYPHS[ch];
                if (gx >= cursor && gx < cursor + rows[0].length && rows[gy][gx - cursor] === "1") color = BADGE_FG;
                cursor += rows[0].length + 1;
              }
            }
          }
          if (color) acc = acc.map((v, i) => v + color[i]);
        }
      }
      const offset = (y * SIZE + x) * 4;
      out[offset] = Math.round(acc[0] / samples);
      out[offset + 1] = Math.round(acc[1] / samples);
      out[offset + 2] = Math.round(acc[2] / samples);
      out[offset + 3] = Math.round(acc[3] / samples);
    }
  }
  return out;
}

// ===== 最小 PNG 写入器（IHDR/IDAT/IEND + zlib，避免为一张图标引依赖） =====

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) table[n] = c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, "..", "src", "assets", "channels");
fs.writeFileSync(path.join(dir, "autoclaw.png"), encodePng(render("CN"), SIZE));
fs.writeFileSync(path.join(dir, "autoclaw_intl.png"), encodePng(render("INTL"), SIZE));
console.log("AutoClaw 图标已生成：autoclaw.png / autoclaw_intl.png");
