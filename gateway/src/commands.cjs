// 容器形态的命令清单与门控。
//
// 事实源是桌面注册表本身：register() 只依赖 ipcMain.handle 一个 API（实测 72 处、无其它），
// 传一个只实现 handle 的收集器即可拿到全量 { 命令 → handler }，不需要把 72 条 handler
// 抽出来重构（那是对已发布核心的高风险改动）。
// 本文件只补充"容器形态能不能用"这层判定：read 只读监视 / write 有副作用 / deny 容器不可用。
"use strict";

const path = require("node:path");

const PROXY_DIR = path.join(__dirname, "..", "..", "electron", "backend", "proxy");
const proxyIndex = require(path.join(PROXY_DIR, "index.cjs"));

/** 只读命令（无副作用）：监视面板与只读令牌都依赖这份判定 */
const READ = new Set([
  "proxy_status",
  "proxy_keys_list",
  "proxy_pool",
  "proxy_channel_list",
  "proxy_models",
  "proxy_rules_list",
  "proxy_oplog_list",
  "proxy_oplog_ops",
  "proxy_recent",
  "proxy_stats_overview",
  "proxy_stats_detail",
  "proxy_stats_top",
  "proxy_vault_status",
  "proxy_provider_list",
  "proxy_poolsync_status",
  "proxy_checkin_status",
  "proxy_scan",
  "proxy_autoclaw_captcha_config",
]);

const SERVICE_CONTROL_REASON = "网关在容器里由编排管理，不能从界面启停——请用 docker restart 或 compose 命令";
const ZCODE_DEVICE_REASON = "ZCode 设备指纹相关操作需要本机客户端，容器里不可用";
const NO_GUI_REASON = "容器没有桌面环境，无法打开目录——数据在宿主机的 ./gateway-data";

/** 容器形态不可用：值面向用户（原因 + 替代路径），前端提示与服务端 403 共用同一份文案 */
const DENY = {
  proxy_start: SERVICE_CONTROL_REASON,
  proxy_stop: SERVICE_CONTROL_REASON,
  proxy_restart: SERVICE_CONTROL_REASON,
  proxy_open_data_dir: NO_GUI_REASON,
  proxy_open_rules_dir: NO_GUI_REASON,
  proxy_account_import_file: "容器无法弹出文件选择框——请用「粘贴 JSON 导入」或管理 API 的 /api/accounts/import",
  proxy_oauth_begin: "OAuth 回环回调在容器里不可达——请用「粘贴回调地址」完成授权，或改用号池同步",
  proxy_ccswitch_status: "CC Switch 是本机客户端，容器里不可用",
  proxy_ccswitch_register: "CC Switch 是本机客户端，容器里不可用",
  proxy_ide_status: "IDE 切号需要本机客户端，容器里不可用",
  proxy_ide_switch: "IDE 切号需要本机客户端，容器里不可用",
  proxy_oplog_export: "容器里不能导出到本机目录——请到桌面版导出，或直接读宿主机数据目录",
  proxy_zcode_claim_mode: ZCODE_DEVICE_REASON,
  proxy_zcode_device_repair: ZCODE_DEVICE_REASON,
  proxy_zcode_device_status: ZCODE_DEVICE_REASON,
  proxy_zcode_restore_mid: ZCODE_DEVICE_REASON,
  proxy_zcode_switch_rollback: ZCODE_DEVICE_REASON,
  proxy_zcode_solve_captcha: "人机校验需要图形环境，容器里无法弹窗——请在桌面版号池页手动领取",
};

function modeOf(cmd) {
  if (DENY[cmd]) return "deny";
  return READ.has(cmd) ? "read" : "write";
}

/** 全量命令表。register 首行会执行 setUsageRetention(settings())（幂等，需要配置已可读），
 *  调用时机放在 boot() 之后 */
function collectCommands() {
  const commands = new Map();
  proxyIndex.register({ handle: (cmd, fn) => commands.set(cmd, fn) });
  return commands;
}

module.exports = { collectCommands, modeOf, READ, DENY };
