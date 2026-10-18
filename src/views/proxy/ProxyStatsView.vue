<!-- 反代网关 · 用量统计（方案《反代网关-用量统计增强方案.md》）
     口径：不建日聚合冗余表，全部由 usage_requests 流水直查 GROUP BY；流水保留期可配
     （设置 · 反代网关「余额历史 / 请求流水保留」，默认 90 天），本页「清理」按当前值立即删一轮。
     时间区间统摄全页：KPI / 趋势 / 排行 / 各 Key / 明细全部吃同一个 { from, to }。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyStatsOverview, ProxyStatsDetail, ProxyStatsDim, ProxyStatsKeyRow } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtK, fmtMs, fmtTime, fmtDate, fmtAgo, channelName, statusCls } from "./format";
import { coalesceAsync } from "../../utils/timing";
import { toast as ElMessage } from "../../utils/toast";
import StatsTrendChart from "../../components/proxy/StatsTrendChart.vue";
import StatsDonutChart from "../../components/proxy/StatsDonutChart.vue";

const app = useAppStore();

// ===== 时间区间 =====
const PRESETS = [
  { key: "today", label: "今天" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "90d", label: "近 90 天" },
  { key: "custom", label: "自定义" },
] as const;
type Preset = (typeof PRESETS)[number]["key"];

const DAY_MS = 86400000;
const preset = ref<Preset>("7d");
const customRange = ref<[string, string] | null>(null);

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dateInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 当前生效区间（毫秒闭区间）：档位或自定义日期变化时自动重算 */
const range = computed<{ from: number; to: number }>(() => {
  const now = Date.now();
  if (preset.value === "custom") {
    const c = customRange.value;
    if (c && c[0] && c[1]) {
      const f = new Date(`${c[0]}T00:00:00`).getTime();
      const t = new Date(`${c[1]}T23:59:59.999`).getTime();
      return { from: Math.min(f, t), to: Math.max(f, t) };
    }
    return { from: dayStart(now) - 6 * DAY_MS, to: now };
  }
  const days = preset.value === "today" ? 1 : preset.value === "7d" ? 7 : preset.value === "30d" ? 30 : 90;
  const from = dayStart(now) - (days - 1) * DAY_MS;
  // 「今天」档到此刻为止；其余档到今天 23:59:59.999（含当天全部流水）
  const to = days === 1 ? now : dayStart(now) + DAY_MS - 1;
  return { from, to };
});

const rangeLabel = computed(() => {
  const f = dateInput(range.value.from);
  const t = dateInput(range.value.to);
  return f === t ? f : `${f} ~ ${t}`;
});

function pickPreset(p: Preset) {
  // 首次切到自定义时给个「近 7 天」的初值，避免选择器空着
  if (p === "custom" && !customRange.value) {
    const now = Date.now();
    customRange.value = [dateInput(dayStart(now) - 6 * DAY_MS), dateInput(now)];
  }
  preset.value = p;
}
function pickCustomRange(v: [string, string] | null) {
  if (v && v[0] && v[1]) {
    customRange.value = v;
    preset.value = "custom";
  }
}

// ===== 维度 / 指标 / 排序 =====
const DIMS = [
  { value: "channel", label: "渠道" },
  { value: "model", label: "模型" },
  { value: "key", label: "Key" },
  { value: "account", label: "账号" },
] as const;
const dim = ref<ProxyStatsDim>("channel");
const topBy = ref<"req" | "tokens">("req");
const metric = ref<"req" | "tokens" | "success" | "latency">("req");
const dimLabel = computed(() => DIMS.find((d) => d.value === dim.value)?.label || "维度");

// ===== 数据 =====
const ov = ref<ProxyStatsOverview | null>(null);
const detail = ref<ProxyStatsDetail | null>(null);
const page = ref(1);
const pageSize = 15;
const err = ref("");
const filters = reactive({ key: "", model: "", channel: "", status: "" });

const s = computed(() => ov.value?.summary);
const successCls = computed(() => ((s.value?.successRate ?? 100) < 99 ? "err" : "acc"));
/** 缓存命中率 = 缓存读 ÷ 输入（缓存读是 prompt_tokens 的子集，不能与输入并列进总量） */
const cacheHit = computed(() => {
  const v = ov.value?.summary;
  if (!v || !v.promptTokens) return 0;
  return Math.round((v.cacheReadTokens / v.promptTokens) * 1000) / 10;
});

const channelOptions = computed(() => (ov.value?.tops.channel || []).map((r) => ({ id: r.name, label: channelName(r.name) })));

const topRows = computed(() => {
  const rows = [...(ov.value?.tops[dim.value] || [])];
  const key = topBy.value;
  rows.sort((a, b) => (key === "tokens" ? b.tokens - a.tokens : b.req - a.req));
  const total = rows.reduce((sum, r) => sum + (key === "tokens" ? r.tokens : r.req), 0) || 1;
  return rows.slice(0, 10).map((r) => ({
    ...r,
    label: dim.value === "channel" ? channelName(r.name) : r.name || "（未命名）",
    pct: Math.round(((key === "tokens" ? r.tokens : r.req) / total) * 1000) / 10,
  }));
});

const keyRows = computed(() => [...(ov.value?.keys || [])].sort((a, b) => b.tokens - a.tokens));

const totalPages = computed(() => Math.max(1, Math.ceil((detail.value?.total || 0) / pageSize)));

const rateCls = (r: number) => (r < 95 ? "rate-bad" : r < 99 ? "rate-warn" : "");

// ===== 取数 =====
async function refresh() {
  const { from, to } = range.value;
  try {
    ov.value = await api.proxyStatsOverview({ from, to, granularity: "auto" });
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function loadDetail() {
  const { from, to } = range.value;
  try {
    detail.value = await api.proxyStatsDetail({
      from,
      to,
      page: page.value,
      pageSize,
      key: filters.key || undefined,
      model: filters.model || undefined,
      channel: filters.channel || undefined,
      status: filters.status || undefined,
    });
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function reload() {
  await Promise.all([refresh(), loadDetail()]);
}

function goPage(p: number) {
  page.value = Math.min(totalPages.value, Math.max(1, p));
  loadDetail();
}

// ===== 明细筛选 =====
const detailRef = ref<HTMLElement | null>(null);
let searchTimer = 0;

function applyFilter() {
  page.value = 1;
  loadDetail();
}
function resetFilters() {
  filters.key = "";
  filters.model = "";
  filters.channel = "";
  filters.status = "";
  applyFilter();
}
/** 从各 Key 用量表下钻：把 Key 名灌进明细搜索框并滚过去 */
function drillToKey(k: ProxyStatsKeyRow) {
  filters.key = k.name || k.keyId;
  filters.channel = "";
  filters.status = "";
  page.value = 1;
  loadDetail();
  detailRef.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ===== 清理流水：范围二选一（仅超期=按设置页保留期删旧 / 全部=清空整表），不可恢复所以先问一道 =====
const cleanOpen = ref(false);
const cleanScope = ref<"expired" | "all">("expired");
const cleaning = ref(false);
function openClean() {
  cleanScope.value = "expired"; // 每次打开回默认档，防上次选的「全部」被顺手确认
  cleanOpen.value = true;
}
async function doCleanup() {
  cleaning.value = true;
  try {
    const all = cleanScope.value === "all";
    const r = await api.proxyStatsCleanup(undefined, all);
    ElMessage.success(
      all
        ? `已清空全部流水 ${fmtInt(r.deleted)} 条`
        : `已清理保留期（${app.config.proxy.usageRetentionDays} 天）之前的流水 ${fmtInt(r.deleted)} 条`,
    );
    cleanOpen.value = false;
    page.value = 1;
    await reload();
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    cleaning.value = false;
  }
}

/** 本页是否处于前台：页面经 v-show 保活，事件刷新只在激活时跑，切走即停 */
const active = computed(() => app.activeModule === "proxy" && app.activePage === "stats");

// 事件合流：概览 + 明细一起拉，1s 窗口合并防重入
const scheduleRefresh = coalesceAsync(() => Promise.all([refresh(), loadDetail()]), 1000);

// 区间变化：回到第 1 页并整体重拉
watch(range, () => {
  page.value = 1;
  scheduleRefresh();
});
// 文本搜索防抖 300ms（每次敲键都打一次 IPC 太浪费）
watch([() => filters.key, () => filters.model], () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(applyFilter, 300);
});
watch([() => filters.channel, () => filters.status], applyFilter);

watch(active, (on) => {
  if (on) scheduleRefresh();
  else scheduleRefresh.cancel();
});

let offEvent: (() => void) | undefined;

onMounted(() => {
  reload();
  // 请求流水变化（后端已节流为每 2s 至多一条）驱动本页刷新，无需轮询；
  // 明细/趋势/排行全部实时直查 usage_requests 流水，事件即变更信号
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "proxy" || p.type !== "request") return;
    if (!active.value) return;
    scheduleRefresh();
  });
});

onUnmounted(() => {
  window.clearTimeout(searchTimer);
  scheduleRefresh.cancel();
  if (offEvent) offEvent();
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <!-- 顶部筛选栏：档位 + 自定义区间 + 生效范围（sticky，滚动只发生在下方内容区） -->
      <div class="stats-filters">
        <div class="chips">
          <button v-for="p in PRESETS" :key="p.key" class="chip" :class="{ active: preset === p.key }" @click="pickPreset(p.key)">
            {{ p.label }}
          </button>
        </div>
        <el-date-picker
          v-if="preset === 'custom'"
          :model-value="customRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="~"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          popper-class="glass-popper"
          class="f-date-range"
          @update:model-value="pickCustomRange"
        />
        <span class="range-hint">{{ rangeLabel }} · {{ ov?.range.granularity === "hour" ? "按小时" : "按天" }}</span>
        <div class="spacer"></div>
        <button class="btn btn-sm" @click="reload"><i class="ph ph-arrows-clockwise"></i> 刷新</button>
        <button class="btn btn-sm" @click="openClean"><i class="ph ph-broom"></i> 清理</button>
      </div>

      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>

      <!-- KPI：区间口径（与下方所有模块同一区间） -->
      <div class="kpis kpis-6">
        <div class="kpi" :title="`成功 ${fmtInt(s?.ok || 0)} · 失败 ${fmtInt(s?.err || 0)}`">
          <span>总请求</span><b class="acc">{{ fmtInt(s?.req || 0) }}</b>
        </div>
        <div class="kpi" :title="`输入 ${fmtInt(s?.promptTokens || 0)} + 输出 ${fmtInt(s?.completionTokens || 0)}`">
          <span>总 Token</span><b>{{ fmtK(s?.totalTokens || 0) }}</b>
        </div>
        <div class="kpi" :title="`成功 ${fmtInt(s?.ok || 0)} / 共 ${fmtInt(s?.req || 0)} 次请求`">
          <span>成功率</span><b :class="successCls">{{ (s?.successRate ?? 100).toFixed(1) }}%</b>
        </div>
        <div class="kpi" :title="`P50 ${fmtMs(s?.ttftP50 || 0)} · 平均 ${fmtMs(s?.ttftAvg || 0)} · 总耗时均值 ${fmtMs(s?.latencyAvg || 0)}`">
          <span>平均 TTFT</span><b>{{ fmtMs(s?.ttftAvg || 0) }}</b>
        </div>
        <div class="kpi" :title="`缓存读 ${fmtInt(s?.cacheReadTokens || 0)} · 缓存命中率 ${cacheHit}%（缓存读为输入的子集）`">
          <span>输入 Token</span><b>{{ fmtK(s?.promptTokens || 0) }}</b>
        </div>
        <div class="kpi" :title="`缓存写 ${fmtInt(s?.cacheCreationTokens || 0)}`">
          <span>输出 Token</span><b>{{ fmtK(s?.completionTokens || 0) }}</b>
        </div>
      </div>

      <!-- 趋势：多指标切换 + 点上数值 + 悬停看板 -->
      <div style="margin-top: 12px">
        <StatsTrendChart :points="ov?.series || []" :metric="metric" :granularity="ov?.range.granularity || 'day'" @change-metric="metric = $event" />
      </div>

      <!-- Token 构成 / 请求状态 -->
      <div class="grid-2" style="margin-top: 12px">
        <div class="card anim">
          <div class="card-title">Token 构成 <span class="right">缓存命中率 {{ cacheHit }}%</span></div>
          <StatsDonutChart :data="ov?.tokenMix || []" :palette="['--accent', '--info']" unit="token" center-label="总 Token" />
        </div>
        <div class="card anim">
          <div class="card-title">请求状态 <span class="right">共 {{ fmtInt(s?.req || 0) }} 次</span></div>
          <StatsDonutChart
            :data="ov?.status || []"
            :palette="['--accent', '--warn', '--danger', '--text-3']"
            center-label="成功率"
            :center-value="(s?.successRate ?? 100).toFixed(1) + '%'"
          />
        </div>
      </div>

      <!-- 用量占比 TOP：维度 × 排序双切换，含请求/响应 token 分列 -->
      <div class="card anim" style="margin-top: 12px">
        <div class="card-title">
          用量占比 TOP
          <div class="chips" style="margin-left: 8px">
            <button v-for="d in DIMS" :key="d.value" class="chip" :class="{ active: dim === d.value }" @click="dim = d.value">{{ d.label }}</button>
          </div>
          <div class="chips" style="margin-left: 12px">
            <button class="chip" :class="{ active: topBy === 'req' }" @click="topBy = 'req'">按请求</button>
            <button class="chip" :class="{ active: topBy === 'tokens' }" @click="topBy = 'tokens'">按 Token</button>
          </div>
          <span class="right">TOP 10</span>
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <tbody>
              <tr>
                <th style="text-align: left">{{ dimLabel }}</th>
                <th style="text-align: left; width: 32%">占比（{{ topBy === "tokens" ? "Token" : "请求" }}）</th>
                <th>请求</th><th>请求 Tok</th><th>响应 Tok</th><th>总 Tok</th><th>成功率</th><th>平均 TTFT</th>
              </tr>
              <tr v-for="r in topRows" :key="r.name">
                <td>{{ r.label }}</td>
                <td>
                  <div class="ratio">
                    <div class="ratio-track"><div class="ratio-fill" :style="{ width: Math.min(100, r.pct) + '%' }"></div></div>
                    <span class="num">{{ r.pct }}%</span>
                  </div>
                </td>
                <td class="mono">{{ fmtInt(r.req) }}</td>
                <td class="mono">{{ fmtK(r.promptTokens) }}</td>
                <td class="mono">{{ fmtK(r.completionTokens) }}</td>
                <td class="mono">{{ fmtK(r.tokens) }}</td>
                <td class="mono" :class="rateCls(r.successRate)">{{ r.successRate.toFixed(1) }}%</td>
                <td class="mono">{{ fmtMs(r.ttftAvg) }}</td>
              </tr>
              <tr v-if="!topRows.length">
                <td colspan="8" class="empty-cell">当前时间区间暂无请求数据</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 各 Key 用量：一眼看出哪把 Key 在烧 Token，点「筛选」直接下钻到明细 -->
      <div class="card anim" style="margin-top: 12px">
        <div class="card-title">各 Key 用量 <span class="right">按总 Token 倒序 · 共 {{ keyRows.length }} 把</span></div>
        <div class="tbl-wrap">
          <table class="tbl">
            <tbody>
              <tr>
                <th style="text-align: left">Key</th><th>请求</th><th>请求 Tok</th><th>响应 Tok</th><th>总 Tok</th><th>成功率</th><th>平均 TTFT</th><th>最近使用</th><th></th>
              </tr>
              <tr v-for="k in keyRows" :key="k.keyId">
                <td>{{ k.name || "（未命名）" }}</td>
                <td class="mono">{{ fmtInt(k.req) }}</td>
                <td class="mono">{{ fmtK(k.promptTokens) }}</td>
                <td class="mono">{{ fmtK(k.completionTokens) }}</td>
                <td class="mono">{{ fmtK(k.tokens) }}</td>
                <td class="mono" :class="rateCls(k.successRate)">{{ k.successRate.toFixed(1) }}%</td>
                <td class="mono">{{ fmtMs(k.ttftAvg) }}</td>
                <td class="mono">{{ fmtAgo(k.lastTs) }}</td>
                <td><button class="btn btn-sm" @click="drillToKey(k)">筛选</button></td>
              </tr>
              <tr v-if="!keyRows.length">
                <td colspan="9" class="empty-cell">当前时间区间暂无 Key 用量</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 请求明细：Key / 模型模糊搜索 + 渠道 / 状态过滤 + 筛选汇总 -->
      <div ref="detailRef" class="card anim" style="margin-top: 12px">
        <div class="card-title">
          请求明细
          <span class="right">{{ fmtInt(detail?.total || 0) }} 条 · 第 {{ page }}/{{ totalPages }} 页</span>
        </div>
        <div class="detail-filters">
          <el-input v-model="filters.key" placeholder="搜索 Key 名 / ID" clearable class="f-input" popper-class="glass-popper" />
          <el-input v-model="filters.model" placeholder="搜索模型" clearable class="f-input" popper-class="glass-popper" />
          <el-select v-model="filters.channel" placeholder="全部渠道" clearable class="f-el-select" popper-class="glass-popper">
            <el-option value="" label="全部渠道" />
            <el-option v-for="c in channelOptions" :key="c.id" :value="c.id" :label="c.label" />
          </el-select>
          <el-select v-model="filters.status" placeholder="全部状态" clearable class="f-el-select" popper-class="glass-popper">
            <el-option value="" label="全部状态" />
            <el-option value="ok" label="成功 2xx" />
            <el-option value="4xx" label="客户端 4xx" />
            <el-option value="5xx" label="服务端 5xx" />
            <el-option value="other" label="无响应" />
          </el-select>
          <button class="btn btn-sm" @click="resetFilters">重置</button>
          <span class="detail-agg">{{ detail?.agg ? `命中 ${fmtInt(detail.agg.req)} 条 · 输入 ${fmtK(detail.agg.promptTokens)} · 输出 ${fmtK(detail.agg.completionTokens)} · 合计 ${fmtK(detail.agg.tokens)}` : "" }}</span>
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <tbody>
              <tr><th>时间</th><th>模型</th><th>渠道</th><th>KEY</th><th>账号</th><th>状态</th><th>请求 Tok</th><th>缓存命中</th><th>响应 Tok</th><th>TTFT</th><th>耗时</th></tr>
              <tr v-for="r in detail?.rows || []" :key="r.id">
                <td class="mono">
                  <el-tooltip :content="fmtDate(r.ts)" placement="top">
                    <span>{{ fmtTime(r.ts) }}</span>
                  </el-tooltip>
                </td>
                <td class="mono">{{ r.model || "-" }}</td>
                <td>{{ channelName(r.channel) }}</td>
                <td class="mono">{{ r.keyName || "-" }}</td>
                <td>{{ r.accountName || "-" }}</td>
                <td>
                  <el-tooltip :content="r.error" :disabled="!r.error" placement="top">
                    <span class="tag" :class="statusCls(r.status)">{{ r.status || "-" }}</span>
                  </el-tooltip>
                </td>
                <td class="mono">{{ fmtInt(r.promptTokens) }}</td>
                <td class="mono">
                  <el-tooltip v-if="r.cacheReadTokens" :content="`缓存读 ${fmtInt(r.cacheReadTokens)} / 输入 ${fmtInt(r.promptTokens)}${r.cacheCreationTokens ? ` / 缓存写 ${fmtInt(r.cacheCreationTokens)}` : ''}`" placement="top">
                    <span>{{ r.promptTokens ? Math.round((r.cacheReadTokens / r.promptTokens) * 100) + "%" : "-" }}</span>
                  </el-tooltip>
                  <span v-else>-</span>
                </td>
                <td class="mono">{{ fmtInt(r.completionTokens) }}</td>
                <td class="mono">{{ fmtMs(r.ttftMs) }}</td>
                <td class="mono">{{ fmtMs(r.latencyMs) }}</td>
              </tr>
              <tr v-if="!(detail?.rows || []).length">
                <td colspan="11" class="empty-cell">当前筛选条件下没有请求明细（改一下筛选或点「重置」）</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <button class="btn btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
          <button class="btn btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
        </div>
      </div>

      <!-- 清理确认弹窗：删的是不可恢复的历史，范围与后果都写明白 -->
      <Teleport to="body">
        <div v-if="cleanOpen" class="p-mask" @click.self="cleanOpen = false">
          <div class="p-dlg glass">
            <div class="p-title">清理请求流水</div>
            <div class="chips" style="margin-bottom: 8px">
              <button class="chip" :class="{ active: cleanScope === 'expired' }" @click="cleanScope = 'expired'">仅超期流水</button>
              <button class="chip" :class="{ active: cleanScope === 'all' }" @click="cleanScope = 'all'">全部流水</button>
            </div>
            <div class="set-desc">
              <template v-if="cleanScope === 'expired'">
                将删除保留期（设置页当前为 {{ app.config.proxy.usageRetentionDays }} 天）之前的全部请求流水，此操作不可恢复。
              </template>
              <template v-else>
                将清空<b>整张请求流水表</b>（含当前筛选范围之外的历史记录），此操作不可恢复。
              </template>
            </div>
            <div class="p-actions">
              <button class="btn" @click="cleanOpen = false">取消</button>
              <button class="btn btn-primary danger-solid" :disabled="cleaning" @click="doCleanup">{{ cleaning ? "清理中…" : cleanScope === "all" ? "全部清空" : "确认清理" }}</button>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  </section>
</template>

<style scoped>
/* 筛选栏固定在页面顶部：滚动只发生在下方内容区（对齐操作日志页的筛选栏配方） */
.stats-filters {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 14px;
  background: var(--glass-a);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--glass-bd);
  border-radius: 14px;
  box-shadow: var(--glass-shadow);
}
.stats-filters .spacer {
  flex: 1;
}
.range-hint {
  font-size: 11.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
/* el 组件模板根是多节点结构，scoped 的 data-v 透传不到根上，必须 :deep 穿透 */
.stats-filters :deep(.f-date-range) {
  width: 260px;
}
.stats-filters :deep(.f-date-range .el-input__wrapper),
.stats-filters :deep(.f-date-range.el-date-editor) {
  min-height: 34px;
  font-size: 12.5px;
}

.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}

/* 明细筛选行 */
.detail-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.detail-filters :deep(.f-input) {
  width: 180px;
}
.detail-filters :deep(.f-el-select) {
  width: 140px;
}
.detail-filters :deep(.f-input .el-input__wrapper),
.detail-filters :deep(.f-el-select .el-select__wrapper) {
  min-height: 30px;
  font-size: 12.5px;
}
.detail-agg {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}

/* 成功率低于阈值时着色（TOP / Key 表共用） */
.rate-warn {
  color: var(--warn);
}
.rate-bad {
  color: var(--danger);
}

.empty-cell {
  text-align: center;
  color: var(--text-3);
  padding: 18px 0;
}

.pager {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
