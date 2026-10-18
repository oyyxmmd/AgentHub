// 积分日历两档图形（泳道时间轴 / 见底曲线）的合并与几何：纯函数，与渲染解耦
// （scripts/dev-expiry-rows-test.cjs 的 L/N 节直接断言这里）。
//
// 为什么是泳道而不是逐包：同一渠道里「同包名同面值」的包成批出现，逐包画等于把表格再抄一遍；
// 按「渠道 × 包名 × 面值」合并后才看得见「哪几天集中掉」的形状。
//
// 为什么尺寸与 y 轴都只在渠道内归一：Token 渠道（zcode 家）与积分渠道的量级差好几个数量级，
// 单位不通就不该共轴、也不该共用一把点径尺。
import type { ExpiryRow } from "./expiryRows";
import { statusOf, type ExpiryState } from "./expiryRows";
import { pkgFallbackName } from "./format";

const DAY = 86400000;

/** 横轴窗口左界：过期满 20 天的点已经出窗（默认视图里也被 STALE_EXPIRED_DAYS 收起了） */
export const LANE_X_MIN = -20;
/** 横轴窗口右界：到期量集中在近处，再往右画只会把有用区间压扁 */
export const LANE_X_MAX = 45;
/** 出窗点（> LANE_X_MAX 或长期有效）统一落这里的绘图位 */
export const LANE_FAR_X = 52;
/** 轴右端，留出远期桶的余量 */
export const LANE_X_END = 58;
/** 点径上下限（px）：已用完的包也要看得见，所以最小档不是 0 */
export const LANE_DOT_MIN = 6;
export const LANE_DOT_MAX = 20;

/**
 * 轴刻度。标签不带「天」字：窄窗口（本仓 minWidth 920）下轨道只有 ~380px，
 * 每 10 天一格约 38px，写成「−20 天」会与相邻刻度压字。单位由档位说明那行统一交代。
 */
export const LANE_TICKS: { x: number; label: string; today?: boolean }[] = [
  { x: LANE_X_MIN, label: `−${-LANE_X_MIN}` },
  { x: -10, label: "−10" },
  { x: 0, label: "今天", today: true },
  { x: 10, label: "10" },
  { x: 20, label: "20" },
  { x: 30, label: "30" },
  { x: 40, label: "40" },
  { x: LANE_FAR_X, label: "远期" },
];

/**
 * 本地日历日的「天序号」：取本地的年月日，再落回 UTC 零点。
 * 这样两天之差就是精确的整天数，不用凑时区也不用 round——
 * 直接对本地零点做毫秒差的话，跨夏令时的那天是 23/25 小时，整条轴会偏一格。
 */
function dayIndex(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * 距今天数按**日历日**算；长期有效（expiresAt=0）为 null。
 * 不能按「距此刻几个 24 小时」四舍五入：那样同一批包的并桶结果会随打开页面的时刻漂移
 * （真实号池实测 110↔120 个点），还会把不同日历日到期的包误并成一簇——
 * 用户看的「哪天到期」是日历日，不是小时数。
 */
export function laneDayOffset(expiresAt: number, now: number): number | null {
  if (!expiresAt) return null;
  return (dayIndex(expiresAt) - dayIndex(now)) / DAY;
}

/** 绘图位与「是否出窗」：长期有效与超过右界的都折进远期桶 */
export function laneX(day: number | null): { x: number; far: boolean } {
  if (day === null || day > LANE_X_MAX) return { x: LANE_FAR_X, far: true };
  // 左界之外照实落在轴起点，不折进远期桶——「很久以前就过期」和「很久以后才过期」不是一回事
  return { x: Math.max(day, LANE_X_MIN), far: false };
}

/** 绘图位 → 归一坐标（0~1）。SVG 与百分比布局共用同一把尺，两档因此不会各算各的错位 */
export function laneNormX(x: number): number {
  return (x - LANE_X_MIN) / (LANE_X_END - LANE_X_MIN);
}

/** 绘图位 → 百分比（0~100）。viewBox 宽恰好是 100，所以 SVG 内也用它，别塞归一值 */
export function lanePct(x: number): number {
  return laneNormX(x) * 100;
}

/** 状态紧急度：同一天到期的包聚合成一个点时，取最紧急的那个态 */
const STATE_RANK: Record<ExpiryState, number> = { expired: 0, soon: 1, used: 2, ok: 3 };

export interface LaneDot {
  /** 绘图位（天） */
  x: number;
  /** 是否折进了远期桶 */
  far: boolean;
  /** 同一泳道同一绘图位上的所有包：像素级重叠的点互相挡住 tooltip，所以合并成一个点 */
  rows: ExpiryRow[];
  /** 并了几个包：>1 时点上加圈标记，具体数字走 tooltip（角标文字在密集行会连成 ×2×2×2 一串，读不出来） */
  count: number;
  /** 这几个包的剩余合计；含「不限」时为 null */
  sum: number | null;
  size: number;
  state: ExpiryState;
  /** 含「不限」：尺寸钉到上限并加描边，不能当成 0 或当成一个真实数值 */
  unlimited: boolean;
}

export interface ExpiryLane {
  key: string;
  channelId: string;
  channelDisplay: string;
  /** 包名（缺名时回落渠道占位名，与表格同口径） */
  pkgName: string;
  /** 面值；-1 = 上游不给总额（账号级聚合行也是这一档） */
  total: number;
  /** 该泳道并了几个包（= 各点 count 之和） */
  pkgCount: number;
  dots: LaneDot[];
  /** 该行合计剩余；含「不限」点时为 null（加不出一个有意义的数） */
  sum: number | null;
  /** 该行最近的到期绘图位，只作排序次关键字 */
  nearestX: number;
  /** 单日最大并包数：密集行的 ×N 角标会连成一片读不出，所以「哪天堆了多少」改在标签列报这一个数 */
  maxCount: number;
}

/** 泳道键：渠道 × 包名 × 面值。面值必须在键里——同名不同面值的包是两批钱，合成一行就看不出谁先掉。 */
function laneKeyOf(r: ExpiryRow): string {
  return `${r.channelId}|${r.pkg.name || ""}|${r.pkg.total}`;
}

/**
 * 把（已过滤的）日历行折成泳道。传入的 rows 就是表格正在显示的那一批 ⇒
 * 渠道筛选、状态筛选、历史档对图同样生效，两档图形与表格同源。
 * 排序档对图形不生效是刻意的：泳道按「并了几个包」排，图形内部另有自己的坐标语义。
 */
export function buildExpiryLanes(rows: ExpiryRow[], now: number = Date.now()): ExpiryLane[] {
  const lanes = new Map<string, { lane: ExpiryLane; byX: Map<number, LaneDot> }>();
  for (const r of rows) {
    const key = laneKeyOf(r);
    const pos = laneX(laneDayOffset(r.pkg.expiresAt, now));
    let entry = lanes.get(key);
    if (!entry) {
      entry = {
        lane: { key, channelId: r.channelId, channelDisplay: r.channelDisplay, pkgName: r.pkg.name || pkgFallbackName(r.channelId), total: r.pkg.total, pkgCount: 0, dots: [], sum: 0, nearestX: pos.x, maxCount: 0 },
        byX: new Map(),
      };
      lanes.set(key, entry);
    }
    entry.lane.pkgCount++;
    const dot = entry.byX.get(pos.x);
    if (dot) {
      dot.rows.push(r);
      dot.count++;
      if (r.pkg.remaining === -1) dot.unlimited = true;
      if (dot.sum !== null && r.pkg.remaining >= 0) dot.sum += r.pkg.remaining;
      if (statusOf(r.pkg) !== dot.state && STATE_RANK[statusOf(r.pkg)] < STATE_RANK[dot.state]) dot.state = statusOf(r.pkg);
    } else {
      entry.byX.set(pos.x, {
        x: pos.x, far: pos.far, rows: [r], count: 1,
        sum: r.pkg.remaining === -1 ? null : Math.max(0, r.pkg.remaining),
        size: 0, state: statusOf(r.pkg), unlimited: r.pkg.remaining === -1,
      });
    }
    if (pos.x < entry.lane.nearestX) entry.lane.nearestX = pos.x;
  }

  // 尺子按「点」建，不按「包」：聚合后一个点装的是同一天所有包的余量之和，
  // 拿单包峰值当分母会让 61 个同日包的那个点算出 sqrt>1，直接冲出 LANE_DOT_MAX（实测 48px）。
  // 点越大越互相挡—— tooltip 悬不到正是聚合要解决的问题，用包峰值定尺等于把它造回来。
  // -1（不限）不进最大值：一个不限包会把整渠道压成最小档。
  const chMax = new Map<string, number>();
  for (const { lane, byX } of lanes.values()) {
    for (const d of byX.values()) {
      if (d.unlimited || d.sum === null) continue;
      chMax.set(lane.channelId, Math.max(chMax.get(lane.channelId) || 0, d.sum));
    }
  }

  const out: ExpiryLane[] = [];
  for (const { lane, byX } of lanes.values()) {
    const max = chMax.get(lane.channelId) || 1;
    lane.dots = [...byX.values()]
      .map((d) => {
        // sqrt 而非线性：同一渠道里最大与最小包差几个数量级时，线性会让小点彻底看不见。
        // 「不限」不必再特判尺寸：v 已钉成该渠道峰值，sqrt(1) 恰好落在 LANE_DOT_MAX——
        // 两处都钉一次就是冗余分支，变异对照会因为它俩互相兜底而打不红。
        const v = d.unlimited || d.sum === null ? max : d.sum;
        const size = LANE_DOT_MIN + (LANE_DOT_MAX - LANE_DOT_MIN) * Math.sqrt(Math.max(0, v) / max);
        return { ...d, size: Math.round(size * 10) / 10 };
      })
      .sort((a, b) => a.x - b.x);
    let sum: number | null = 0;
    for (const d of lane.dots) {
      if (d.unlimited || d.sum === null) sum = null;
      else if (sum !== null) sum += d.sum;
    }
    lane.sum = sum;
    lane.maxCount = lane.dots.reduce((m, d) => (d.count > m ? d.count : m), 0);
    out.push(lane);
  }
  // 包多的行在上（那才是刷屏来源），同数量按最近到期升序
  out.sort((a, b) => b.pkgCount - a.pkgCount || a.nearestX - b.nearestX);
  return out;
}

/* ================= 见底曲线档 =================
 * 回答的是时间轴答不了的另一个问题：「哪天腰斩、什么时候见底」。
 * y = 该渠道在 x 那天之后还剩多少，所以一条从左上往右下掉的台阶就是「余量被到期吃掉」的过程。
 * 各渠道单位不通 ⇒ 只能做小倍图（每渠道一根自己的 y 尺），绝不能叠进同一张图。
 */

export interface DecayPoint {
  /** 绘图位（天），已按远期桶折叠 */
  x: number;
  /** 该点之后的剩余量（渠道自己的单位） */
  y: number;
  /**  viewBox 单位（0~100）：几何在这里算完，视图只管画，判据也在这里断言 */
  px: number;
  py: number;
  /** 这一步掉掉的量（起点与收口点为 0） */
  dropped: number;
}

export interface DecaySeries {
  channelId: string;
  display: string;
  /** 起始总量（含长期有效与已过期）；unlimited 时为 null */
  total: number | null;
  count: number;
  /** 该渠道内有「不限」包 ⇒ 剩余量加不出总数，画曲线就是编数字，交视图出文字态 */
  unlimited: boolean;
  /**
   * 长期有效（expiresAt=0）那部分永远不会到期，是曲线的地板。
   * 把它当成「远期桶里到期」会念出「见底在 45 天以后」这种假话，所以它不参与扣减。
   */
  floor: number;
  pts: DecayPoint[];
  /** 现在手里还有多少（按时刻算，未过期的都算，含长期有效）；与曲线在 x=0 的取值可以差一天 */
  atToday: number | null;
  /** 首次掉到半数的天数（负=已经腰斩过）；不可能腰斩为 null */
  halfAt: number | null;
  /** 首次归零的天数（负=早就空了）；有长期地板 ⇒ 永远不为 0，null */
  zeroAt: number | null;
}

export function buildDecaySeries(rows: ExpiryRow[], now: number = Date.now()): DecaySeries[] {
  const byCh = new Map<string, ExpiryRow[]>();
  for (const r of rows) {
    if (!byCh.has(r.channelId)) byCh.set(r.channelId, []);
    byCh.get(r.channelId)!.push(r);
  }
  const out: DecaySeries[] = [];
  for (const [channelId, rs] of byCh) {
    const display = rs[0].channelDisplay;
    const count = rs.length;
    if (rs.some((r) => r.pkg.remaining === -1)) {
      out.push({ channelId, display, total: null, count, unlimited: true, floor: 0, pts: [], atToday: null, halfAt: null, zeroAt: null });
      continue;
    }
    const total = rs.reduce((s, r) => s + Math.max(0, r.pkg.remaining), 0);
    const floor = rs.filter((r) => !r.pkg.expiresAt).reduce((s, r) => s + Math.max(0, r.pkg.remaining), 0);
    // 同一天到期的包合并成一步 ⇒ 台阶数 = 唯一到期日数，不是包数
    const byX = new Map<number, number>();
    for (const r of rs) {
      if (!r.pkg.expiresAt) continue; // 长期有效不参与扣减
      const { x } = laneX(laneDayOffset(r.pkg.expiresAt, now));
      byX.set(x, (byX.get(x) || 0) + Math.max(0, r.pkg.remaining));
    }
    const xs = [...byX.keys()].sort((a, b) => a - b);
    const raw: Omit<DecayPoint, "px" | "py">[] = [{ x: LANE_X_MIN, y: total, dropped: 0 }];
    let acc = total;
    for (const x of xs) {
      const d = byX.get(x) || 0;
      acc = Math.max(0, acc - d);
      raw.push({ x, y: acc, dropped: d });
    }
    // 收口到轴右端，否则曲线会在最后一个到期日就断掉，看不出「之后一直是这个量」
    if (raw[raw.length - 1].x < LANE_X_END) raw.push({ x: LANE_X_END, y: acc, dropped: 0 });
    const maxY = total || 1;
    // 「今天还剩多少」按**时刻**算，不从台阶上取：台阶的 x 是四舍五入到天，
    // 今天之内几小时后到期的包会被算进 x=0 那一级，于是把「现在还有」念成「今天之后还有」。
    const atToday = rs.reduce((s, r) => (r.pkg.expiresAt && r.pkg.expiresAt <= now ? s : s + Math.max(0, r.pkg.remaining)), 0);
    let halfAt: number | null = null;
    let zeroAt: number | null = null;
    for (const p of raw) {
      if (!p.dropped) continue; // 起点与收口点不算「掉」，否则 total=0 的渠道会被判成刚起步就归零
      if (halfAt === null && total > 0 && p.y <= total / 2) halfAt = p.x;
      if (zeroAt === null && p.y === 0 && floor === 0) zeroAt = p.x;
    }
    out.push({
      channelId, display, total, count, unlimited: false, floor, atToday, halfAt, zeroAt,
      pts: raw.map((p) => ({ ...p, px: lanePct(p.x), py: (1 - p.y / maxY) * 100 })),
    });
  }
  // 有真实余量的渠道排前面（先看最值钱的什么时候见底）；「不限」画不出曲线，排最后
  out.sort((a, b) => Number(a.unlimited) - Number(b.unlimited) || (b.total || 0) - (a.total || 0) || b.count - a.count);
  return out;
}

/**
 * 台阶线的 path 数据：每个顶点是「这一步之后剩多少」，所以先水平走到那天再垂直掉下去（step-after）。
 * 反过来先垂直再水平，等于把掉点提前一天画。
 */
export function decayPath(s: DecaySeries): string {
  if (s.pts.length < 2) return "";
  const n = (v: number) => Math.round(v * 100) / 100;
  let d = `M${n(s.pts[0].px)} ${n(s.pts[0].py)}`;
  for (let i = 1; i < s.pts.length; i++) d += ` L${n(s.pts[i].px)} ${n(s.pts[i - 1].py)} L${n(s.pts[i].px)} ${n(s.pts[i].py)}`;
  return d;
}

/** 曲线下方填充：沿台阶线走到右端，再回到基线闭合 */
export function decayAreaPath(s: DecaySeries): string {
  const line = decayPath(s);
  if (!line) return "";
  const first = s.pts[0];
  const last = s.pts[s.pts.length - 1];
  const n = (v: number) => Math.round(v * 100) / 100;
  return `${line} L${n(last.px)} 100 L${n(first.px)} 100 Z`;
}
