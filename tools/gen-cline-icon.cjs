// Cline 双渠道图标生成器：自绘「终端窗 + 提示符」意象（CLI 工具的通用符号），
// 256×256 PNG（与其它渠道图标同尺寸）。两个池共用同一图形，右下角池角标区分：
// cline_free.png = FREE（绿）/ cline_pass.png = PASS（紫）。
//
// 为什么用脚本自绘：图形自行设计（方案 §11：斜杠 + 圆的 CLI 意象，加池角标与品牌色解耦），
// 本项目图标资产是入库 PNG；脚本留仓库，改形状/配色可复现。3×3 超采样出抗锯齿边缘。
//
// 用法：node tools/gen-cline-icon.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 256;
const BLUE = [66, 120, 250, 255]; // 主色（终端窗，靛蓝）
const BLUE_DEEP = [40, 84, 200, 255]; // 提示符与光标（深一档）
// 池角标底：FREE 绿 / PASS 紫（与品牌色解耦，方案 §11）
const BADGE_FREE = [34, 150, 94, 235];
const BADGE_PASS = [124, 82, 214, 235];

/** 3×5 像素字模（1=着色） */
const GLYPHS = {
  F: ["1111", "1000", "1110", "1000", "1000"],
  R: ["1110", "1001", "1110", "1010", "1001"],
  E: ["1111", "1000", "1110", "1000", "1111"],
  P: ["1110", "1001", "1110", "1000", "1000"],
  A: ["0110", "1001", "1111", "1001", "1001"],
  S: ["0111", "1000", "0110", "0001", "1110"],
};

function inCircle(px, py, cx, cy, r) {
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** 圆角矩形（椭圆角） */
function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) return true;
  return px >= x + r && px <= x + w - r;
}

/** 线段距离（点到线段的最短距离，用于画斜线笔画） */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 渲染一个渠道图标：badge = "FREE"（绿底）/ "PASS"（紫底） */
function render(badge) {
  const out = Buffer.alloc(SIZE * SIZE * 4, 0);
  // 终端窗：圆角方块
  const win = { x: 42, y: 56, w: 172, h: 144, r: 22 };
  // 标题条分隔线（画一条窄带）
  const barY = 56 + 34;
  // 提示符 ">"（两段斜线）与光标 "_"（横条）
  const promptA = { x1: 74, y1: 116, x2: 98, y2: 138 };
  const promptB = { x1: 98, y1: 138, x2: 74, y2: 160 };
  const cursor = { x: 112, y: 152, w: 40, h: 10, r: 3 };
  const badgeW = 14 + String(badge).length * 4 * 4;
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
          if (inRoundedRect(px, py, win.x, win.y, win.w, win.h, win.r)) color = BLUE;
          // 标题条（窗顶 34px 深色带）
          if (inRoundedRect(px, py, win.x, win.y, win.w, 34, win.r) && py <= barY) color = BLUE_DEEP;
          // 三个窗口圆点（标题条上的装饰）
          for (let i = 0; i < 3; i++) {
            if (inCircle(px, py, win.x + 22 + i * 20, win.y + 17, 5)) color = [230, 238, 255, 255];
          }
          // 提示符与光标（窗内深色）
          if (distToSegment(px, py, promptA.x1, promptA.y1, promptA.x2, promptA.y2) <= 5) color = BLUE_DEEP;
          if (distToSegment(px, py, promptB.x1, promptB.y1, promptB.x2, promptB.y2) <= 5) color = BLUE_DEEP;
          if (inRoundedRect(px, py, cursor.x, cursor.y, cursor.w, cursor.h, cursor.r)) color = BLUE_DEEP;
          // 池角标（FREE 绿底 / PASS 紫底）
          if (inRoundedRect(px, py, badgeX, badgeY, badgeW, badgeH, 8)) color = badge === "FREE" ? BADGE_FREE : BADGE_PASS;
          const gx = Math.floor((px - badgeX - 7) / glyphScale);
          const gy = Math.floor((py - badgeY - 6) / glyphScale);
          if (gy >= 0 && gy < 5) {
            let cursorIdx = 0;
            for (const ch of String(badge)) {
              const rows = GLYPHS[ch];
              if (gx >= cursorIdx && gx < cursorIdx + rows[0].length && rows[gy][gx - cursorIdx] === "1") color = [255, 255, 255, 255];
              cursorIdx += rows[0].length + 1;
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

// ===== 最小 PNG 写入器（IHDR/IDAT/IEND + zlib，与 gen-autoclaw-icon.cjs 同款） =====

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
fs.writeFileSync(path.join(dir, "cline_free.png"), encodePng(render("FREE"), SIZE));
fs.writeFileSync(path.join(dir, "cline_pass.png"), encodePng(render("PASS"), SIZE));
console.log("Cline 图标已生成：cline_free.png / cline_pass.png");
