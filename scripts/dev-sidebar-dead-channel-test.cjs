// 侧栏「渠道额度」死渠道隐藏闸
//  ① 纯函数 isUnusableChannel：两个条件缺一不可、长期有效永不算死、边界取「<= now」
//  ② 接线钉：列表 / 空态 / 卡片计数三处都必须认可见集合，漏一处就会出现
//     「写着 14 个渠道，下面只列 11 行」这类自相矛盾的界面
// 跑法：node scripts/dev-sidebar-dead-channel-test.cjs（纯 Node、不联网、零副作用）
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SIDEBAR = "src/components/Sidebar.vue";

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? `：${detail}` : "")); console.log(`FAIL  ${name}${detail ? `：${detail}` : ""}`); }
}

/** 转译并加载 TS 纯函数模块。必须 bundle 而不是 transform：裸 transform 会把相对依赖原样
 *  留在产物里，从临时目录 require 必炸。临时文件名每次唯一：require 按路径缓存。 */
let loadSeq = 0;
function loadModule(rel) {
  const { outputFiles: [{ text: code }] } = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    write: false,
  });
  const tmp = path.join(os.tmpdir(), `channel-health-${process.pid}-${loadSeq++}.cjs`);
  fs.writeFileSync(tmp, code);
  try {
    return require(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

function main() {
  const { isUnusableChannel } = loadModule("src/views/proxy/channelHealth.ts");
  const DAY = 86400000;
  const NOW = 1_800_000_000_000; // 固定时钟：判据吃 now 参数，所以边界可以精确到毫秒
  const S = (totalCredits, earliestExpire) => ({ totalCredits, earliestExpire });

  // ===== ① 两个条件缺一不可 =====
  check("① 有号已过期 且 在线余额合计 0 ⇒ 判为死渠道",
    isUnusableChannel(S(0, NOW - DAY), NOW) === true);
  check("② 已过期但还有余额 ⇒ 不能藏（只看过期会把仍有可用号的渠道整条藏掉）",
    isUnusableChannel(S(5120, NOW - DAY), NOW) === false, String(isUnusableChannel(S(5120, NOW - DAY), NOW)));
  check("③ 余额 0 但没有任何号过期 ⇒ 不能藏（「还没刷过额度」的号池合计也是 0，藏掉就是渠道凭空消失）",
    isUnusableChannel(S(0, NOW + DAY), NOW) === false, String(isUnusableChannel(S(0, NOW + DAY), NOW)));
  check("④ 长期有效（earliestExpire=0）且余额 0 ⇒ 不能藏——0 是「没有到期时间」不是「1970 年就过期」",
    isUnusableChannel(S(0, 0), NOW) === false, String(isUnusableChannel(S(0, 0), NOW)));

  // ===== ② 边界与口径 =====
  check("⑤ 到期时刻**正好等于** now ⇒ 算过期（与 pool.deriveAccountCredits 的 expiresAt <= now 同口径）",
    isUnusableChannel(S(0, NOW), NOW) === true);
  check("⑥ 差 1 毫秒才到期 ⇒ 还不算死（窗口边界不能被四舍五入吃掉）",
    isUnusableChannel(S(0, NOW + 1), NOW) === false);

  // ===== ③ 反向对照：混合池里只藏该藏的 =====
  const pool = [
    { id: "dead1", summary: S(0, NOW - 3 * DAY) },
    { id: "alive-credit", summary: S(900, NOW - 3 * DAY) },
    { id: "alive-future", summary: S(0, NOW + 2 * DAY) },
    { id: "forever", summary: S(0, 0) },
    { id: "dead2", summary: S(0, NOW - 1) },
  ];
  const visible = pool.filter((c) => !isUnusableChannel(c.summary, NOW)).map((c) => c.id);
  check("⑦ 五条里精确藏掉两条死渠道、留下三条（恒真/恒假的过滤器在这里都会红）",
    visible.join(",") === "alive-credit,alive-future,forever", visible.join(","));

  // ===== ④ 接线钉：判据对了但视图没接上一样白搭 =====
  const sb = fs.readFileSync(path.join(ROOT, SIDEBAR), "utf8");
  check("⑧ 列表遍历 visibleChannels，不再遍历 channels（漏这一处就是「计数说有 14 个、下面只列 11 行」）",
    /v-for="c in visibleChannels"/.test(sb) && !/v-for="c in channels"/.test(sb));
  check("⑨ 空态判据也认可见集合（不是 channels.length）——否则全藏掉时什么都不显示，连一句解释都没有",
    /v-if="!visibleChannels\.length"/.test(sb));
  check("⑩ 空态文案区分「全部被藏了」与「号池还没接入」两种空（都写同一句会让人以为数据丢了）",
    /channels\.length \? "无可用余额渠道/.test(sb) && /号池尚未接入或加载中/.test(sb));
  check("⑪ 卡片头的「N 个渠道」走 visibleChannels（与列表同源，两处各算一份迟早对不上）",
    /visibleChannels\.value\.length \? `\$\{visibleChannels\.value\.length\} 个渠道`/.test(sb));
  check("⑫ 判据吃的是纯函数、且传的是当次渲染取的 now（组件里另抄一份、或把时钟传成常量，上面那些都抓不到）",
    /isUnusableChannel\(c\.summary, now\)/.test(sb) && /from "\.\.\/views\/proxy\/channelHealth"/.test(sb));

  console.log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK 侧栏死渠道闸全过"}（共 ${pass + failures.length} 项）`);
  if (failures.length) process.exit(1);
}

try { main(); } catch (e) { console.error("闸自身异常:", e); process.exit(1); }
