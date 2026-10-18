// 服务端能力清单（Web 托管形态的单一事实源）：
//   - 判定"这是网关托管的 Web UI 还是纯前端预览（dev:web）"——前者走 RPC，后者走 mock
//   - 板块裁剪：只渲染服务端声明支持的模块（容器形态只有 proxy）
//   - 命令门控：deny 命令在 call() 层统一拦下，文案由服务端下发（前端不重复维护）
export type CommandMode = "read" | "write" | "deny";

export interface CommandCaps {
  mode: CommandMode;
  reason?: string;
}

export interface Caps {
  platform: string;
  version: string;
  modules: string[];
  features: Record<string, boolean>;
  commands: Record<string, CommandCaps>;
}

let caps: Caps | null = null;

export function isWebTransport(): boolean {
  return caps !== null;
}

/** 探测网关托管形态：3 秒超时；纯静态预览（无后端）或接口不可用时返回 null 走 mock */
export async function probeCaps(): Promise<Caps | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch("/api/capabilities", { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<Caps> & { ok?: boolean };
    if (!data || data.ok !== true || !Array.isArray(data.modules) || !data.commands) return null;
    caps = data as Caps;
    return caps;
  } catch {
    return null; // 非 JSON / 网络失败：按"无后端"处理
  }
}

export function moduleEnabled(key: string): boolean {
  return !caps || caps.modules.includes(key);
}

/** deny 命令的拦截文案：命中返回原因（调用层直接抛），未命中返回 null */
export function denyReason(cmd: string): string | null {
  const c = caps?.commands[cmd];
  return c && c.mode === "deny" ? c.reason || "该操作在容器形态不可用" : null;
}
