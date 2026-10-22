<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { loadConfig, proxyGrowthLog, proxyPinnedAccountSet, proxyPool, proxyPreferBuiltinSet, proxyStatsOverview } from "../api/ipc";
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

/** 内置优先总闸（proxy.preferBuiltin）：只有开启时才允许内置渠道参与自动路由。
 *  走独立 IPC（proxy_prefer_builtin_set）而不是整份配置保存——托盘与主窗口各持配置快照，
 *  整份提交会互相冲掉（后保存的一方用旧快照覆盖先保存的一方）。 */
const preferBuiltin = ref(false);
const preferBusy = ref(false);
const preferErr = ref("");

/** 开关的无障碍标签 */
function preferLabel(): string {
  return preferBuiltin.value ? "关闭内置优先" : "开启内置优先";
}

/** 切换内置优先：失败时回滚，不留下假的已开启状态 */
async function togglePreferBuiltin() {
  if (preferBusy.value) return;
  const old = preferBuiltin.value;
  const next = !old;
  preferBuiltin.value = next;
  preferBusy.value = true;
  preferErr.value = "";
  try {
    const r = await proxyPreferBuiltinSet(next);
    if (r && r.ok === false) {
      preferBuiltin.value = old;
      preferErr.value = r.message || "保存失败";
    }
  } catch (e) {
    preferBuiltin.value = old;
    preferErr.value = String((e as Error).message || e);
  } finally {
    preferBusy.value = false;
  }
}

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
  // 托盘只要「今日」口径：显式传今日 00:00 ~ 现在（上游统计已区间化，缺省跨度可能不是今天）
  const dayStart = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const [pool, log, stats, cfg] = await Promise.all([
    proxyPool().catch(() => null),
    proxyGrowthLog().catch(() => null),
    proxyStatsOverview({ from: dayStart, to: Date.now() }).catch(() => null),
    loadConfig().catch(() => null),
  ]);
  channels.value = pool || [];
  // 内置优先总闸：读配置里的 proxy.preferBuiltin（maskConfig 只脱敏 webdav 密码，
  // proxy 段完整返回）。读不到就保持当前值不动。
  if (cfg && cfg.proxy) preferBuiltin.value = cfg.proxy.preferBuiltin === true;
  usage.value = stats
    ? { req: Number(stats.summary?.req) || 0, tokens: Number(stats.summary?.totalTokens) || 0 }
    : null;
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

    <section class="card routing">
      <div class="card-title">
        内置渠道启用
        <span class="title-side" :class="preferBuiltin ? 'on' : ''">{{ preferBuiltin ? "内置优先" : "仅自定义" }}</span>
      </div>
      <div class="routing-body">
        <span class="routing-desc">只有开启时才允许内置渠道参与自动路由；关闭时只走自定义提供商。</span>
        <button
          class="switch"
          :class="{ on: preferBuiltin }"
          role="switch"
          :aria-checked="preferBuiltin"
          :aria-label="preferLabel()"
          :disabled="preferBusy"
          @click="togglePreferBuiltin"
        ></button>
      </div>
      <div v-if="preferErr" class="routing-err">{{ preferErr }}</div>
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

/* 模型路由优先级开关：托盘是独立 HTML 入口，不加载主窗口的 global.css，
   故此处自带一份与主窗口 .switch 同形的样式（40×22 胶囊 + 16px 圆钮） */
.routing .title-side.on { color: #34c759; font-weight: 600; }
.routing-body { display: flex; align-items: center; gap: 10px; }
.routing-desc { flex: 1; min-width: 0; font-size: 11px; line-height: 1.45; color: var(--sub); }
.routing-err { margin-top: 6px; font-size: 10.5px; color: #ff453a; }
.switch {
  width: 40px;
  height: 22px;
  flex: none;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--line);
  position: relative;
  cursor: pointer;
  padding: 0;
  transition: background 0.2s ease, border-color 0.2s ease;
}
.switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: transform 0.2s ease;
}
.switch.on { background: #34c759; border-color: #34c759; }
.switch.on::after { transform: translateX(18px); }
.switch:disabled { opacity: 0.55; cursor: default; }

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
