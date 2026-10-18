import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";

// Electron 前端配置：dev 端口 1420（与 electron/main.cjs 的加载地址一致）
// base 用相对路径，便于 Electron 通过 file:// 加载打包后的 index.html
export default defineConfig({
  plugins: [
    vue(),
    // Element Plus 按需注册：模板里的 <el-*> 自动引入组件与各自样式，替代原来的
    // app.use(ElementPlus) 全量注册 + index.css 全量样式（那份 CSS 单文件 361,258 字节，
    //   覆盖 element-plus/es/components 下 124 个组件目录，而本仓库模板里用到的 el-* 标签只有 18 个（不含不渲染 DOM 的 el-config-provider）。
    // directives: false —— 全库没用 v-loading / ElInfiniteScroll 等指令式组件（自测第 ③ 段扫）。
    // dirs: [] —— 关掉默认的 src/components 递归扫描：不关它，插件会把 34 个本地组件
    // （Sidebar / Drawer / Heatmap 这类通用名）一并登记成全局组件，与显式 import 重名时
    // 静默换实现。实测产物字节不变，这条纯粹是不引入那层歧义。
    Components({
      resolvers: [ElementPlusResolver({ directives: false })],
      dirs: [],
      dts: "src/components.d.ts",
    }),
  ],
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: ["es2021", "chrome100"],
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        tray: fileURLToPath(new URL("./tray.html", import.meta.url)),
      },
    },
  },
});
