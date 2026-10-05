<p align="center">
  <img src="./logo.png" alt="AgentHub Logo" width="128" />
</p>

# AgentHub —— Agent 中控台（个人增强 Fork）

> 把「技能、用量、额度、记忆」收进一个桌面应用：本地运行的 Electron + Vue 3 中控台，自己不带模型，把你在各家 AI 编程工具里的技能、token 用量、订阅额度、Agent 记忆统一管起来。

---

## > **本 Fork 的修改**（相对上游 [HUIdada1/AgentHub](https://github.com/HUIdada1/AgentHub)）

| 修改 | 说明 |
| --- | --- |
| **WorkBuddy CN 积分任务自动化** | 参考 [Buddy Switch](https://github.com/NextAgentX/trae-workbuddy-switch) 接入四类成长任务：**猫猫旅行**（状态机自动派猫/领奖）、**夜猫子**（23:00–08:00 窗口内自动补事件领奖）、**活跃地图**（对话事件连发上报 + 连登奖励链：礼包/补偿/补签/兑换/抽奖）、**开学季**（任务链 + 转盘）。每类独立开关（配置 · 反代网关 · 定时），15 分钟自动调度 + 号池页手动执行，执行记录在「任务日志」弹窗可查，落盘持久化，正常态静默幂等 |
| **Trae SOLO CN OAuth 登录修复** | 对齐 Buddy Switch 的 Rust 实现：读本机官方客户端 icube 设备身份（DeviceID/MachineID/EC P-256 公钥）、SOLO 安装包版本三处同值（授权 URL + 兑换体）、`Result.AccessToken` 信封解析、四变体 × 多域兑换链、回调参数反复 percent-decode、完整请求/响应诊断日志（`[trae-oauth]`） |
| **Trae 模型目录完整拉取** | `get_detail_param` 按 `function` 键逐键拉取合并（`solo_work_lite` + `solo_agent` 并集，修复只回 1 个模型的问题），条目记录来源键，出站 `functionForModel` 优先回查 catalog 条目 |
| **macOS（Apple Silicon）支持** | electron-builder dmg/zip 目标（仅 arm64、跳过签名），`build/icon.icns` 由 logo 生成；首次打开需右键「打开」绕过 Gatekeeper 或 `xattr -cr /Applications/AgentHub.app` |

---

## 四大板块

| 板块 | 一句话 |
| --- | --- |
| **技能仓库** | 把散落在各工具的 Skill 收进中央库，一处维护、一键分发（软链接挂载） |
| **用量统计** | 汇总 20 个数据源的 token 用量与费用，按天/项目/模型看趋势 |
| **反代网关** | 把已登录的订阅额度包成 OpenAI 兼容 API（`http://127.0.0.1:9527/v1`），给任何客户端用；号池五态管理、自动换号、冷却、多机 WebDAV 同步 |
| **记忆中枢** | 本地 Markdown 记忆库 + MCP 服务，让 Agent 记住项目与偏好 |

**反代网关渠道**：Trae SOLO CN / WorkBuddy CN / WorkBuddy AI / 商汤小浣熊 / ZCode（智谱）/ Qoder CN / Qoder International——号池、签到、策略各渠道独立；添加账号支持 OAuth 登录、本机客户端导入、JSON/ZIP 文件、粘贴 JSON 四种方式。

> Qoder 渠道依赖本机安装的客户端（签名由客户端内置 wasm 生成）；每日领 Credits 同理。Trae 不支持「切到 IDE」（登录态为设备绑定的加密信封）。

---

## 快速开始

```bash
# 环境：Node >= 18
npm install
npm run dev              # 桌面端开发（Electron + Vite HMR）
npm run build            # 类型检查 + 前端构建

# macOS arm64 打包（dmg + zip，产物在 release/）
npx electron-builder --mac --publish never
```

- 账号 token 经系统级加密（macOS Keychain / Windows DPAPI）落盘，只在主进程流转；网关 API Key 只存 SHA-256 哈希
- 所有请求只发往对应服务的官方接口与你自己的 WebDAV 服务器

## 免责声明

本项目为**开源学习研究项目**，仅供个人在已合法订阅相应服务的前提下，于本地环境调用自有账号额度。使用者不得用于任何违反目标服务条款、侵犯第三方权益或商业转售的用途；因使用本项目产生的一切后果由使用者自行承担。本项目与 Trae、WorkBuddy、腾讯、商汤、智谱等公司无任何关联。

## 致谢

- 原项目：**沐辉**（[@HUIdada1](https://github.com/HUIdada1)）的 [AgentHub](https://github.com/HUIdada1/AgentHub)（MIT License）
- 积分任务与 Trae OAuth 实现参考：[NextAgentX/trae-workbuddy-switch](https://github.com/NextAgentX/trae-workbuddy-switch)（Buddy Switch）

License: [MIT](./LICENSE)
