// 积分日历页的行过滤与排序：纯函数，与渲染解耦（scripts/dev-expiry-rows-test.cjs 直接断言）
import type { ProxyAccount, ProxyCreditPackage } from "../../types";

export interface ExpiryRow {
  key: string;
  channelId: string;
  channelDisplay: string;
  accountName: string;
  pkg: ProxyCreditPackage;
  /** 账号级聚合行（该渠道上游不拆包）：总额列不编数字，渲染成「—」 */
  aggregate?: boolean;
}

/** 状态筛选；usable = 有余额（排除已用完），是页面默认档 */
export type ExpiryStatusFilter = "usable" | "all" | "ok" | "soon" | "expired" | "used";
export type ExpirySortKey = "expiryAsc" | "expiryDesc" | "remainDesc" | "remainAsc";

export const STATUS_OPTIONS: { value: ExpiryStatusFilter; label: string }[] = [
  { value: "usable", label: "有余额" },
  { value: "all", label: "全部" },
  { value: "ok", label: "生效中" },
  { value: "soon", label: "即将到期" },
  { value: "expired", label: "已过期" },
  { value: "used", label: "已用完" },
];

export const SORT_OPTIONS: { value: ExpirySortKey; label: string }[] = [
  { value: "expiryAsc", label: "到期时间 升序" },
  { value: "expiryDesc", label: "到期时间 降序" },
  { value: "remainDesc", label: "剩余额度 降序" },
  { value: "remainAsc", label: "剩余额度 升序" },
];

export type ExpiryState = "expired" | "soon" | "used" | "ok";

/** 已用完 = 剩余为 0；-1 是「不限」哨兵，绝不能当成 0 */
export const isUsedUp = (pkg: ProxyCreditPackage) => pkg.remaining === 0;

/** 状态归类：过期 > 即将到期 > 已用完 > 生效中（过期且余额为 0 的包仍算「已过期」，那是更该看到的信息） */
export function statusOf(pkg: ProxyCreditPackage): ExpiryState {
  if (pkg.expired) return "expired";
  if (pkg.expiringSoon) return "soon";
  if (isUsedUp(pkg)) return "used";
  return "ok";
}

/** 已过期多少天（不足一天按 0）；未过期或长期有效返回 -1 */
export function expiredDays(pkg: ProxyCreditPackage, now: number): number {
  if (!pkg.expiresAt || pkg.expiresAt > now) return -1;
  return Math.floor((now - pkg.expiresAt) / 86400000);
}

/** 陈旧过期阈值（天）：过期满 2 天（含）的包退出日历默认视图。
 *  刚过期一天内仍留在列表——那正是该催用户去用的；三天前的过期包只剩刷屏价值。 */
export const STALE_EXPIRED_DAYS = 2;
const STALE_EXPIRED_MS = STALE_EXPIRED_DAYS * 86400000;

/** 陈旧过期 = 过期时刻距今 ≥ 2 天。按 expiresAt 重算而不读 pkg.expired：
 *  后者是主进程派生的一次性快照，页面常驻时会比 expiresAt 慢一整个刷新周期。 */
export function isStaleExpired(pkg: ProxyCreditPackage, now: number): boolean {
  return !!pkg.expiresAt && now - pkg.expiresAt >= STALE_EXPIRED_MS;
}

/** 已过期（含刚过期与陈旧过期）：历史档的入选判据 */
export function isExpiredPkg(pkg: ProxyCreditPackage, now: number): boolean {
  return !!pkg.expiresAt && pkg.expiresAt <= now;
}

/** 剩余额度排序键：-1（不限）视为最大 */
const remainKey = (pkg: ProxyCreditPackage) => (pkg.remaining === -1 ? Number.POSITIVE_INFINITY : pkg.remaining);
/** 到期排序键：0（长期有效）视为最大，故升序时排在最后 */
const expiryKey = (pkg: ProxyCreditPackage) => pkg.expiresAt || Number.POSITIVE_INFINITY;

function byExpiry(a: ExpiryRow, b: ExpiryRow, dir: 1 | -1): number {
  const ea = expiryKey(a.pkg);
  const eb = expiryKey(b.pkg);
  // 两个长期包（都是 Infinity）相减得 NaN，所以先比不相等再相减
  if (ea !== eb) return dir * (ea - eb);
  // 同到期一律按剩余降序（升/降序共用同一个第二关键字，免得降序把次序也翻过来）
  return remainKey(b.pkg) - remainKey(a.pkg);
}

export interface ExpiryFilter {
  status: ExpiryStatusFilter;
  /** "all" = 不限渠道 */
  channelId: string;
  sort: ExpirySortKey;
  /** 历史过期档：只看全部已过期（含默认视图里被自动隐藏的陈旧过期），status 维度让位 */
  history?: boolean;
}

export function applyExpiryFilter(rows: ExpiryRow[], f: ExpiryFilter, now: number = Date.now()): ExpiryRow[] {
  const out = rows.filter((r) => {
    if (f.channelId !== "all" && r.channelId !== f.channelId) return false;
    if (f.history) return isExpiredPkg(r.pkg, now);
    // 过期满 2 天的退出日历默认视图（含「已过期」档——那是同一批行，切档不该把它们召回来）
    if (isStaleExpired(r.pkg, now)) return false;
    if (f.status === "all") return true;
    if (f.status === "usable") return !isUsedUp(r.pkg);
    return statusOf(r.pkg) === f.status;
  });
  out.sort((a, b) => {
    switch (f.sort) {
      case "expiryDesc":
        return byExpiry(a, b, -1);
      case "remainDesc":
        return remainKey(b.pkg) - remainKey(a.pkg) || byExpiry(a, b, 1);
      case "remainAsc":
        return remainKey(a.pkg) - remainKey(b.pkg) || byExpiry(a, b, 1);
      default:
        return byExpiry(a, b, 1);
    }
  });
  return out;
}

export function countByState(rows: ExpiryRow[]): Record<ExpiryState, number> & { total: number } {
  const out = { expired: 0, soon: 0, used: 0, ok: 0, total: rows.length };
  for (const r of rows) out[statusOf(r.pkg)]++;
  return out;
}

/** 聚合行的包名：与逐包行区分开，避免用户把它当成一个真实的包 */
export const AGGREGATE_PKG_NAME = "账号额度汇总";

/** 账号级聚合行：该渠道上游不拆包（只有一个聚合余额数）时，按账号出一条进日历。
 *  覆盖 catpaw / cline 双池 / autoclaw 双区 / raccoon / modelscope
 *  这些「有积分或额度、但适配器产不出 packages」的渠道（2026-10-12）。
 *  2026-10-13：lobster 与 qoder 两家已从这条路上出去——上游同一条响应里就带逐包与到期，
 *  适配器现在产得出 packages（两者互斥，所以不会重复计数）。
 *
 *  只用已经落库的账号级字段，不碰任何上游字段名，所以新渠道零改造即被覆盖。
 *  - 跳过 creditsAt=0 的账号：那是建号默认值，从未刷过额度，列出来是假数据
 *  - total = -1 表示「上游不给总额」，渲染成「—」；与 remaining = -1 的「不限」哨兵是两回事
 *  - 无到期时间照实落 0 → 显示「长期」，排序仍按现有口径排到最后 */
export function aggregateRow(
  channelId: string,
  channelDisplay: string,
  acc: Pick<ProxyAccount, "id" | "name" | "credits" | "creditsAt" | "expiresAt">,
): ExpiryRow | null {
  if (!acc.creditsAt) return null;
  const remaining = Number(acc.credits);
  if (!Number.isFinite(remaining)) return null;
  return {
    key: `${acc.id}:agg`,
    channelId,
    channelDisplay,
    accountName: acc.name || "（未命名）",
    aggregate: true,
    pkg: { code: "", name: AGGREGATE_PKG_NAME, total: -1, used: 0, remaining, expiresAt: Number(acc.expiresAt) || 0 },
  };
}
