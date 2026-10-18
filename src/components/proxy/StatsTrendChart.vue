<script setup lang="ts">
// 反代网关 · 用量统计：请求趋势折线（多指标切换 + 点上数值 + 玻璃悬停看板）
// 指标由父组件持有（emit change-metric），本组件只负责渲染。
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from "vue";
import { graphic, init, type ECharts } from "../../utils/echarts";
import { useAppStore } from "../../stores/app";
import { glassTooltip, tooltipCard, type TooltipParam } from "../../utils/chart-tooltip";
import type { ProxyStatsPoint } from "../../types";
import { fmtInt, fmtK, fmtMs } from "../../views/proxy/format";

type TrendMetric = "req" | "tokens" | "success" | "latency";

const props = defineProps<{ points: ProxyStatsPoint[]; metric: TrendMetric; granularity: "hour" | "day" }>();
const emit = defineEmits<{ (e: "change-metric", m: TrendMetric): void }>();

const ui = useAppStore();
const el = ref<HTMLDivElement | null>(null);
let chart: ECharts | null = null;

const METRICS: { key: TrendMetric; label: string }[] = [
  { key: "req", label: "请求数" },
  { key: "tokens", label: "Token" },
  { key: "success", label: "成功率" },
  { key: "latency", label: "延迟" },
];

/** 取 :root 上的 CSS 变量（canvas 不认 var()，必须解析成实色） */
function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** 数值缩写：随指标切换（成功率带 %，延迟走 ms/s） */
function fmtByMetric(metric: TrendMetric, v: number): string {
  if (metric === "success") return Number(v).toFixed(1) + "%";
  if (metric === "latency") return fmtMs(Number(v));
  return fmtK(Number(v));
}

interface SeriesDef {
  name: string;
  data: number[];
  color: string;
}

/** 指标 → 序列定义（两序列时第二根用 info/warn 区分，单序列只画一根） */
function seriesFor(metric: TrendMetric, points: ProxyStatsPoint[]): SeriesDef[] {
  const accent = cssVar("--accent", "#44e07f");
  const info = cssVar("--info", "#5c9dff");
  const warn = cssVar("--warn", "#e5b454");
  const danger = cssVar("--danger", "#f26d6d");
  if (metric === "req") {
    return [
      { name: "成功", data: points.map((p) => p.ok), color: accent },
      { name: "失败", data: points.map((p) => p.err), color: danger },
    ];
  }
  if (metric === "tokens") {
    return [
      { name: "输入 Token", data: points.map((p) => p.promptTokens), color: accent },
      { name: "输出 Token", data: points.map((p) => p.completionTokens), color: info },
    ];
  }
  if (metric === "success") {
    return [{ name: "成功率", data: points.map((p) => p.successRate), color: accent }];
  }
  return [
    { name: "TTFT 均值", data: points.map((p) => p.ttftAvg), color: accent },
    { name: "总耗时均值", data: points.map((p) => p.latencyAvg), color: warn },
  ];
}

function render() {
  if (!chart || !el.value) return;
  const points = props.points || [];
  const metric = props.metric;
  const gridColor = cssVar("--border", "rgba(15,23,42,0.08)");
  const textColor = cssVar("--text-3", "#85919f");
  // 点少时直接在点上标数值（issue 第 2 条：x 轴每个点要能看到 y 轴数值）；点多了靠悬停
  const showLabel = points.length > 0 && points.length <= 20;
  const defs = seriesFor(metric, points);

  chart.clear();
  chart.setOption({
    animation: ui.config.fx,
    animationDuration: 500,
    animationDurationUpdate: 450,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicInOut",
    grid: { left: 58, right: 20, top: showLabel ? 26 : 14, bottom: 26 },
    tooltip: {
      ...glassTooltip(),
      formatter: (params: TooltipParam | TooltipParam[]) => {
        const list = Array.isArray(params) ? params : [params];
        const p = list[0];
        if (!p) return "";
        const pt = points[p.dataIndex];
        if (!pt) return "";
        const rows = [
          { label: "请求数", value: fmtInt(pt.req) + " 次" },
          { label: "成功 / 失败", value: `${fmtInt(pt.ok)} / ${fmtInt(pt.err)}` },
          { label: "输入 Token", value: fmtInt(pt.promptTokens) },
          { label: "输出 Token", value: fmtInt(pt.completionTokens) },
          { label: "成功率", value: pt.successRate.toFixed(1) + "%" },
          { label: "TTFT 均值", value: fmtMs(pt.ttftAvg) },
          { label: "总耗时均值", value: fmtMs(pt.latencyAvg) },
        ];
        return tooltipCard(pt.label, rows);
      },
    },
    xAxis: {
      type: "category",
      data: points.map((p) => (props.granularity === "hour" ? p.label.slice(11) : p.label.slice(5))),
      boundaryGap: false,
      axisLine: { lineStyle: { color: gridColor } },
      axisTick: { show: false },
      axisLabel: { color: textColor, fontSize: 10.5, interval: "auto" },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: textColor, fontSize: 10.5, formatter: (v: number) => fmtByMetric(metric, v) },
      splitLine: { lineStyle: { color: gridColor } },
    },
    series: defs.map((d, i) => ({
      name: d.name,
      type: "line",
      data: d.data,
      smooth: true,
      symbol: "circle",
      symbolSize: 5,
      showSymbol: points.length <= 60,
      lineStyle: { width: 2.1, color: d.color },
      itemStyle: { color: d.color },
      areaStyle:
        i === 0
          ? {
              color: new graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: d.color + "3d" },
                { offset: 1, color: d.color + "00" },
              ]),
            }
          : undefined,
      label: {
        show: showLabel,
        position: "top",
        fontSize: 9.5,
        color: textColor,
        formatter: (p: { value?: number | string }) => fmtByMetric(metric, Number(p.value) || 0),
      },
    })),
  });
}

let resizeObserver: ResizeObserver | null = null;
const onResize = () => chart?.resize();

onMounted(() => {
  if (!el.value) return;
  nextTick(() => {
    if (!el.value) return;
    chart = init(el.value);
    render();
    resizeObserver = new ResizeObserver(() => chart?.resize());
    resizeObserver.observe(el.value);
  });
  window.addEventListener("resize", onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  resizeObserver?.disconnect();
  chart?.dispose();
  chart = null;
});

watch(() => props.points, () => nextTick(render), { deep: true });
watch(() => props.metric, () => nextTick(render));
watch(() => props.granularity, () => nextTick(render));
watch(() => ui.isDark, () => nextTick(render));
watch(() => ui.config.fx, () => nextTick(render));
</script>

<template>
  <div class="card anim">
    <div class="card-title">
      请求趋势
      <div class="chips" style="margin-left: 8px">
        <button v-for="m in METRICS" :key="m.key" class="chip" :class="{ active: metric === m.key }" @click="emit('change-metric', m.key)">
          {{ m.label }}
        </button>
      </div>
      <span class="right">{{ granularity === "hour" ? "按小时" : "按天" }} · 悬停查看数值</span>
    </div>
    <div ref="el" class="trend-chart"></div>
  </div>
</template>

<style scoped>
.trend-chart {
  width: 100%;
  height: 268px;
}
</style>
