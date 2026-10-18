// echarts 按需注册入口：折线图 + 饼/环形图 + 直角坐标系网格 + 提示框 + 图例（含滚动图例）+ canvas 渲染器。
// 所有图表一律从本文件 import，不要再 `import * as echarts from "echarts"` —— 那会把全量包
// （实测 5.6.0 min 后 1009 KB / gzip 332 KB，见本 PR 的体积对照）整块拉进首屏 chunk。
//
// LegendScrollComponent 是冗余项而非义务：lib/component/legend/install.js 里 LegendComponent
// 自己就 use(installLegendScroll)，所以只注册 LegendComponent 也能解析 legend.type "scroll"。
// 显式那行刻意保留：两种写法注册集完全相同、installLegendScroll.js 反正会进图，删它省不下字节，
// 而它把「这里要滚动图例」写在了名字里——别当「未使用」清掉。
//
// 全库无 registerTheme、无 graphic option、无 mark* / dataZoom / title 组件：
// sync/Heatmap.vue 与 memory/MemoryHeatmap.vue 是纯 DOM 格子，积分日历的时间轴档与见底曲线档
// 分别是纯 DOM 与内联 SVG，都不碰 echarts。PieChart 由反代网关用量统计页的
// 「Token 构成 / 请求状态」两个环形图使用。新增图表类型时才往上面的 use([...]) 里加。
import * as echarts from "echarts/core";
import { LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, LegendScrollComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([LineChart, PieChart, GridComponent, LegendComponent, LegendScrollComponent, TooltipComponent, CanvasRenderer]);

// 图表用到的三个入口：init（实例）、graphic.LinearGradient（面积渐变）、ECharts（实例类型）。
// echarts/core 确实导出 graphic（含 LinearGradient），不是从全量包里侥幸拿到的。
export const init = echarts.init;
export const graphic = echarts.graphic;
export type ECharts = echarts.ECharts;
