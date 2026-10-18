// Web 托管形态的传输层：浏览器里同源调 POST /api/rpc。
// 与桌面 IPC 同契约（{cmd,args} → {ok,...} 数据 / {ok:false,message} 错误），
// 超时看门狗由 ipc.ts 的 call() 统一维护，这里只负责传输与登录态。
const TOKEN_KEY = "agenthub.adminToken";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return ""; // 隐私模式下 localStorage 不可用：本次会话内可用，刷新后需重登
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 同上 */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 同上 */
  }
}

let authLostReloading = false;
/** 令牌失效：清掉并回登录页。并发请求会同时撞 401，用一次性闸防重复 reload */
function handleAuthLost(): never {
  clearToken();
  if (!authLostReloading) {
    authLostReloading = true;
    window.location.reload();
  }
  throw new Error("登录已失效，请重新输入管理令牌");
}

export async function webInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch("/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ cmd, args: args || {} }),
    });
  } catch (e) {
    throw new Error(`无法连接网关：${(e as Error).message || e}`);
  }
  if (res.status === 401) handleAuthLost();
  const data = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) throw new Error((data && data.message) || `命令 ${cmd} 执行失败（HTTP ${res.status}）`);
  return data;
}
