<script setup lang="ts">
// 反代网关 · 用量统计：通用环形图（Token 构成 / 请求状态共用）
// 中心数值用 HTML 覆盖层画——echarts 的 graphic/title 组件没注册，也省一次按需注册的包体积。
import { onMounted, onBeforeUnmount, ref, watch, nextTick, computed } from "vue";
import { init, type ECharts } from "../../utils/echarts";
import { useAppStore } from "../../stores/app";
import { glassTooltip } from "../../utils/chart-tooltip";
import { fmtInt, fmtK } from "../../views/proxy/format";

const props = defineProps<{
  /** 数据项；color 缺省时按 palette 顺序取 */
  data: { name: string; value: number; color?: string }[];
  /** CSS 变量名序列（如 ["--accent","--info"]），组件内解析成实色 */
  palette?: string[];
  centerLabel?: string;
  centerValue?: string;
  /** 数值展示口径：int = 千分位；token = K/M 缩写 */
  unit?: "int" | "token";
}>();

const ui = useAppStore();
const el = ref<HTMLDivElement | null>(null);
let chart: ECharts | null = null;

const DEFAULT_PALETTE = ["--accent", "--info", "--warn", "--danger"];
const PALETTE_FALLBACK = ["#44e07f", "#5c9dff", "#e5b454", "#f26d6d"];

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** 每项解析出实色：显式 color 优先，否则按调色板轮转 */
const items = computed(() =>
  (props.data || []).map((d, i) => {
    const vars = props.palette && props.palette.length ? props.palette : DEFAULT_PALETTE;
    const vname = vars[i % vars.length];
    const fallback = PALETTE_FALLBACK[i % PALETTE_FALLBACK.length];
    return { ...d, color: d.color || cssVar(vname, fallback) };
  }),
);

const total = computed(() => items.value.reduce((s, d) => s + (d.value || 0), 0));
const fmtVal = (v: number) => (props.unit === "token" ? fmtK(v) : fmtInt(v));

function render() {
  if (!chart || !el.value) return;
  const list = items.value.filter((d) => d.value > 0);
  const gridColor = cssVar("--border", "rgba(15,23,42,0.08)");
  const sum = list.reduce((s, d) => s + d.value, 0) || 1;

  chart.clear();
  chart.setOption({
    animation: ui.config.fx,
    animationDuration: 500,
    tooltip: {
      ...glassTooltip(),
      trigger: "item",
      formatter: (p: { name?: string; value?: number; color?: string }) => {
        const v = Number(p.value) || 0;
        const pct = ((v / sum) * 100).toFixed(1);
        return (
          `<div style="min-width:140px"><div style="display:flex;align-items:center;gap:8px;font-size:12px">` +
          `<i style="width:7px;height:7px;border-radius:50%;background:${p.color}"></i>` +
          `<span style="color:var(--text-2)">${p.name}</span>` +
          `<b style="margin-left:auto;font-variant-numeric:tabular-nums">${fmtVal(v)}</b></div>` +
          `<div style="text-align:right;font-size:11px;color:var(--text-3);margin-top:2px">占比 ${pct}%</div></div>`
        );
      },
    },
    series: [
      {
        type: "pie",
        radius: ["58%", "80%"],
        center: ["50%", "50%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: gridColor, borderWidth: 1.5 },
        label: { show: false },
        labelLine: { show: false },
        emphasis: { scale: true, scaleSize: 4 },
        data: list.map((d) => ({ name: d.name, value: d.value, itemStyle: { color: d.color } })),
      },
    ],
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

watch(items, () => nextTick(render), { deep: true });
watch(() => ui.isDark, () => nextTick(render));
watch(() => ui.config.fx, () => nextTick(render));
</script>

<template>
  <div class="donut-wrap">
    <div class="donut-chart-box">
      <div ref="el" class="donut-chart"></div>
      <div class="donut-center">
        <template v-if="total > 0">
          <b>{{ centerValue ?? fmtVal(total) }}</b>
          <span>{{ centerLabel ?? "合计" }}</span>
        </template>
        <span v-else class="donut-empty">暂无数据</span>
      </div>
    </div>
    <ul class="donut-legend">
      <li v-for="d in items" :key="d.name">
        <i :style="{ background: d.color }"></i>
        <span class="lg-name">{{ d.name }}</span>
        <b class="lg-val">{{ fmtVal(d.value) }}</b>
        <span class="lg-pct">{{ total ? ((d.value / total) * 100).toFixed(1) + "%" : "0%" }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.donut-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.donut-chart-box {
  position: relative;
  width: 150px;
  height: 150px;
  flex: none;
}
.donut-chart {
  width: 100%;
  height: 100%;
}
.donut-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  gap: 2px;
}
.donut-center b {
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.4px;
  color: var(--text);
}
.donut-center span {
  font-size: 10.5px;
  color: var(--text-3);
}
.donut-empty {
  font-size: 11px;
  color: var(--text-3);
}
.donut-legend {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-width: 150px;
}
.donut-legend li {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  padding: 3px 0;
}
.donut-legend i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.lg-name {
  color: var(--text-2);
}
.lg-val {
  margin-left: auto;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--text);
}
.lg-pct {
  width: 46px;
  text-align: right;
  font-family: var(--font-mono);
  color: var(--text-3);
}
</style>
