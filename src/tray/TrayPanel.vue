<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { proxyGrowthLog, proxyPinnedAccountSet, proxyPool, proxyStatsOverview } from "../api/ipc";
import type { ProxyAccount, ProxyChannelView, ProxyGrowthLogEntry } from "../types";

/** 托盘弹出面板（iStat Menus 风格）：今日用量 / 任务状态 / 网关调度账号 / 账号积分。
 *  账号行点击即切换该渠道的网关指定账号（一次点击完成，切换后「网关调度」立即刷新）；
 *  数据全部复用现有 IPC，窗口由主进程定位到托盘图标下方，失焦自动隐藏 */

const loading = ref(true);
const channels = ref<ProxyChannelView[]>([]);
const usage = ref<{ req: number; tokens: number } | null>(null);
const todayTasks = ref<Record<string, { ok: number; total: number; at: string }>>({});
/** 正在写回的账号 id（行内转圈防重复点击） */
const switchingId = ref("");

const TASK_META: { key: string; label: string }[] = [
  { key: "checkin", label: "签到" },
  { key: "travel", label: "旅行" },
  { key: "cat", label: "夜猫" },
  { key: "activity", label: "活跃" },
  { key: "school", label: "开学" },
];

/** 有可用账号的渠道（关闭渠道不出现在托盘，天然被 proxyPool 过滤） */
const pinnableChannels = computed(() =>
  channels.value.filter((ch) => (ch.accounts || []).some((a) => a.hasToken && a.status !== "disabled"))
);

/** 各渠道当前被网关调度的账号名（pinned 优先；未指定时显示策略首号——与选号口径一致的近似值） */
const gatewayAccounts = computed(() => {
  const map: Record<string, string> = {};
  for (const ch of channels.value) {
    const accs = (ch.accounts || []).filter((a) => a.hasToken && a.status === "online");
    if (!accs.length) { map[ch.id] = ""; continue; }
    if (ch.pinnedAccountId) {
      const p = accs.find((a) => a.id === ch.pinnedAccountId);
      map[ch.id] = p ? p.name || p.uid || "" : "";
      continue;
    }
    // 未指定：按渠道策略近似取下一号（expire_first=先到期 / credit_first=余额最高 / round_robin=最久未用）
    const sorted = [...accs];
    if (ch.poolStrategy === "credit_first") sorted.sort((a, b) => (Number(b.credits) || 0) - (Number(a.credits) || 0));
    else if (ch.poolStrategy === "round_robin") sorted.sort((a, b) => (Number(a.lastUsed) || 0) - (Number(b.lastUsed) || 0));
    else sorted.sort((a, b) => (Number(a.expiresAt) || Infinity) - (Number(b.expiresAt) || Infinity));
    map[ch.id] = sorted[0] ? sorted[0].name || sorted[0].uid || "" : "";
  }
  return map;
});

function pinnedName(ch: ProxyChannelView): string {
  const acc = (ch.accounts || []).find((a) => a.id === ch.pinnedAccountId);
  return acc ? acc.name || acc.uid || "" : "";
}

/** 点击账号行 = 一键把网关调度切到这个账号；点当前指定账号 = 取消指定恢复策略调度 */
async function switchAccount(ch: ProxyChannelView, acc: ProxyAccount) {
  if (switchingId.value) return;
  switchingId.value = acc.id;
  const next = ch.pinnedAccountId === acc.id ? "" : acc.id;
  try {
    const r = await proxyPinnedAccountSet(ch.id, next);
    if (r && (r as { ok?: boolean }).ok === false) return;
  } catch { /* 写入失败保留现状 */ }
  finally {
    switchingId.value = "";
  }
  await refresh();
}

function fmt(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toLocaleString("zh-CN");
}

async function refresh() {
  loading.value = true;
  const day = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const [pool, log, stats] = await Promise.all([
    proxyPool().catch(() => null),
    proxyGrowthLog().catch(() => null),
    proxyStatsOverview().catch(() => null),
  ]);
  channels.value = pool || [];
  usage.value = stats ? { req: Number(stats.today?.req) || 0, tokens: Number(stats.today?.tokens) || 0 } : null;
  // 当日各任务最近一次执行（rows 新在前：当日首遇即最新）
  const latest: Record<string, { ok: number; total: number; at: string }> = {};
  for (const e of log?.rows || [] as ProxyGrowthLogEntry[]) {
    const dt = new Date(e.ts);
    const ds = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    if (ds !== day || latest[e.action]) continue;
    latest[e.action] = { ok: e.okCount, total: e.total, at: `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}` };
  }
  todayTasks.value = latest;
  loading.value = false;
}

function taskState(t?: { ok: number; total: number }) {
  if (!t) return "idle";
  if (t.ok >= t.total && t.total > 0) return "ok";
  if (t.ok > 0) return "partial";
  return "fail";
}

function openMain() {
  void window.agenthub?.invoke("open_main_window");
}

onMounted(() => {
  refresh();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", () => {});
});
</script>

<template>
  <div class="panel">
    <header>
      <span class="logo">⬢ AgentHub</span>
      <span class="badge" :class="loading ? 'dim' : 'ok'">{{ loading ? "…" : "运行中" }}</span>
    </header>

    <div class="usage card">
      <div class="metric">
        <div class="num">{{ usage ? fmt(usage.req) : "—" }}</div>
        <div class="lbl">今日请求</div>
      </div>
      <div class="divider"></div>
      <div class="metric">
        <div class="num">{{ usage ? fmt(usage.tokens) : "—" }}</div>
        <div class="lbl">今日 token</div>
      </div>
    </div>

    <section class="card">
      <div class="card-title">今日任务</div>
      <div class="pills">
        <span v-for="m in TASK_META" :key="m.key" class="pill" :class="taskState(todayTasks[m.key])">
          {{ m.label }} {{ todayTasks[m.key] ? `${todayTasks[m.key].ok}/${todayTasks[m.key].total}` : "—" }}
        </span>
      </div>
    </section>

    <section class="card grow">
      <div class="card-title">
        网关账号
        <span class="title-side">点账号行即切换调度</span>
      </div>
      <div class="accounts">
        <div v-if="!pinnableChannels.length" class="empty">暂无可用账号</div>
        <div v-for="ch in pinnableChannels" :key="ch.id" class="ch-group">
          <div class="ch-head">
            <span class="ch-name">{{ ch.display }}</span>
            <span class="gw-now" :title="ch.pinnedAccountId
              ? `已指定「${pinnedName(ch)}」：调度优先走它，该账号不可用时自动回落策略`
              : '未指定：按渠道策略自动选号'">
              调度 → <b>{{ gatewayAccounts[ch.id] || "无可用账号" }}</b>
            </span>
          </div>
          <div
            v-for="a in ch.accounts.filter((x) => x.hasToken && x.status !== 'disabled')"
            :key="a.id"
            class="acc-row"
            :class="{ pinned: ch.pinnedAccountId === a.id, busy: switchingId === a.id }"
            :title="ch.pinnedAccountId === a.id ? '当前网关调度账号，点击取消指定（恢复策略调度）' : '点击切换：网关调度优先走这个账号'"
            @click="switchAccount(ch, a)"
          >
            <span class="pick-mark">{{ ch.pinnedAccountId === a.id ? "✓" : "" }}</span>
            <span class="dot" :class="a.status === 'online' ? 'on' : 'cool'"></span>
            <span class="acc-name">{{ a.name || a.uid }}</span>
            <span v-if="switchingId === a.id" class="switching">切换中…</span>
            <span class="acc-credits">{{ (Number(a.credits) || 0).toLocaleString("zh-CN") }}</span>
          </div>
        </div>
      </div>
    </section>

    <footer>
      <button @click="openMain">打开主界面</button>
    </footer>
  </div>
</template>

<style>
:root { color-scheme: light dark; }
html, body { margin: 0; height: 100%; }
body {
  font-family: -apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: transparent;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}
#app { height: 100%; }
@media (prefers-color-scheme: dark) {
  .panel { --bg: #232428; --card: rgba(255, 255, 255, 0.06); --txt: #f2f2f4; --sub: #98989f; --line: rgba(255,255,255,0.08); }
}
@media (prefers-color-scheme: light) {
  .panel { --bg: #f5f5f7; --card: rgba(0, 0, 0, 0.045); --txt: #1d1d1f; --sub: #7a7a80; --line: rgba(0,0,0,0.07); }
}
</style>

<style scoped>
.panel {
  height: 100vh;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--bg);
  color: var(--txt);
  /* 透明窗口上的悬浮圆角面板（窗口四周露出桌面） */
  border-radius: 12px;
  overflow: hidden;
}
header { display: flex; align-items: center; justify-content: space-between; }
.logo { font-weight: 700; font-size: 14px; letter-spacing: 0.2px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; }
.badge.ok { color: #34c759; background: rgba(52, 199, 89, 0.14); }
.badge.dim { color: var(--sub); background: var(--card); }

.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.usage { display: flex; align-items: center; }
.metric { flex: 1; text-align: center; }
.metric .num { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }
.metric .lbl { font-size: 11px; color: var(--sub); margin-top: 2px; }
.divider { width: 1px; height: 30px; background: var(--line); }

.card-title { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 600; color: var(--sub); margin-bottom: 8px; }
.title-side { font-weight: 500; font-variant-numeric: tabular-nums; }

.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { font-size: 11px; padding: 3px 9px; border-radius: 999px; background: var(--bg); border: 1px solid var(--line); color: var(--sub); font-variant-numeric: tabular-nums; }
.pill.ok { color: #34c759; border-color: rgba(52, 199, 89, 0.4); }
.pill.partial { color: #ff9f0a; border-color: rgba(255, 159, 10, 0.4); }
.pill.fail { color: #ff453a; border-color: rgba(255, 69, 58, 0.4); }

.grow { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.accounts { flex: 1; overflow-y: auto; min-height: 0; }
.ch-group { margin-bottom: 6px; }
.ch-group:last-child { margin-bottom: 0; }
.ch-head { display: flex; align-items: center; gap: 6px; padding: 3px 0 2px; }
.ch-name { font-size: 11px; font-weight: 600; color: var(--sub); flex: none; }
.gw-now { flex: 1; min-width: 0; text-align: right; font-size: 10px; color: var(--sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-now b { color: var(--txt); font-weight: 600; }
.acc-row { display: flex; align-items: center; gap: 7px; padding: 5px 4px; font-size: 12.5px; border-bottom: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
.acc-row:hover { background: var(--card); }
.acc-row:last-child { border-bottom: none; }
.acc-row.pinned .acc-name { color: #34c759; font-weight: 600; }
.acc-row.busy { opacity: 0.55; pointer-events: none; }
.pick-mark { width: 12px; flex: none; font-size: 11px; color: #34c759; font-weight: 700; text-align: center; }
.switching { font-size: 10px; color: var(--sub); flex: none; }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.dot.on { background: #34c759; }
.dot.cool { background: #ff9f0a; }
.acc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; }
.acc-credits { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
.empty { color: var(--sub); font-size: 12px; text-align: center; padding: 18px 0; }

footer { display: flex; }
footer button {
  flex: 1;
  padding: 8px 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
  color: var(--txt);
  font-size: 13px;
  cursor: pointer;
}
footer button:hover { background: var(--bg); }
footer button:active { opacity: 0.7; }
</style>
