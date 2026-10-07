<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { proxyGrowthLog, proxyIdeStatus, proxyPool, proxyStatsOverview } from "../api/ipc";
import type { ProxyChannelView, ProxyGrowthLogEntry } from "../types";

/** 托盘弹出面板（iStat Menus 风格）：今日用量 / 任务状态 / 当前节点 / 账号积分。
 *  数据全部复用现有 IPC，窗口由主进程定位到托盘图标下方，失焦自动隐藏 */

const loading = ref(true);
const channels = ref<ProxyChannelView[]>([]);
const usage = ref<{ req: number; tokens: number } | null>(null);
const currentNode = ref("");
const todayTasks = ref<Record<string, { ok: number; total: number; at: string }>>({});

const TASK_META: { key: string; label: string }[] = [
  { key: "checkin", label: "签到" },
  { key: "travel", label: "旅行" },
  { key: "cat", label: "夜猫" },
  { key: "activity", label: "活跃" },
  { key: "school", label: "开学" },
];

const accounts = computed(() => {
  const rows: { name: string; channel: string; credits: number; online: boolean }[] = [];
  for (const ch of channels.value) {
    for (const a of ch.accounts || []) {
      if (!a.hasToken || a.status === "disabled") continue;
      rows.push({ name: a.name || a.uid || "", channel: ch.display || ch.id, credits: Number(a.credits) || 0, online: a.status === "online" });
    }
  }
  return rows.sort((x, y) => y.credits - x.credits);
});

const totalCredits = computed(() => accounts.value.reduce((s, a) => s + a.credits, 0));

function fmt(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toLocaleString("zh-CN");
}

async function refresh() {
  loading.value = true;
  const day = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const [pool, log, ide, stats] = await Promise.all([
    proxyPool().catch(() => null),
    proxyGrowthLog().catch(() => null),
    proxyIdeStatus().catch(() => null),
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
  if (ide?.currentUid) {
    let node = "";
    for (const ch of channels.value) {
      const acc = (ch.accounts || []).find((a) => a.uid === ide.currentUid);
      if (acc) { node = `${acc.name || acc.uid}（${ch.display || ch.id}）`; break; }
    }
    currentNode.value = node || ide.currentUid;
  } else {
    currentNode.value = "";
  }
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
      <div v-if="currentNode" class="node">当前节点：<b>{{ currentNode }}</b></div>
      <div v-else class="node dim">当前节点：未设置</div>
    </section>

    <section class="card grow">
      <div class="card-title">
        账号积分
        <span class="title-side">合计 {{ fmt(totalCredits) }}</span>
      </div>
      <div class="accounts">
        <div v-if="!accounts.length" class="empty">暂无可用账号</div>
        <div v-for="a in accounts" :key="a.name + a.channel" class="acc-row">
          <span class="dot" :class="a.online ? 'on' : 'cool'"></span>
          <span class="acc-name" :title="`${a.name}（${a.channel}）`">{{ a.name }}</span>
          <span class="acc-channel">{{ a.channel }}</span>
          <span class="acc-credits">{{ a.credits.toLocaleString("zh-CN") }}</span>
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

.node { margin-top: 8px; font-size: 12px; color: var(--sub); }
.node b { color: var(--txt); font-weight: 600; }
.node.dim { opacity: 0.7; }

.grow { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.accounts { flex: 1; overflow-y: auto; min-height: 0; }
.acc-row { display: flex; align-items: center; gap: 7px; padding: 5px 0; font-size: 12.5px; border-bottom: 1px solid var(--line); }
.acc-row:last-child { border-bottom: none; }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.dot.on { background: #34c759; }
.dot.cool { background: #ff9f0a; }
.acc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
.acc-channel { color: var(--sub); font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
