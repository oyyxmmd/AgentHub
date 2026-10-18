// 远程网关目标状态（桌面连远程 Docker 版）：模块级响应式单例，UI 与传输入口共用。
// 读取不走 ipc.ts 的 call()——call() 自己要判定远程模式，反向依赖会成环；这里直接用 preload 桥。
import { reactive } from "vue";
import type { RemoteTarget } from "../types";

export const remoteState = reactive({
  ready: false,
  activeId: "local",
  targets: [] as RemoteTarget[],
});

export function remoteActive(): boolean {
  return remoteState.ready && remoteState.activeId !== "local";
}

export function activeTarget(): RemoteTarget | undefined {
  return remoteState.targets.find((t) => t.id === remoteState.activeId);
}

export function activeTargetName(): string {
  return activeTarget()?.alias || "本机";
}

/** 拉取/刷新目标列表：启动、增删改、切换后调用 */
export async function refreshRemoteState(): Promise<void> {
  const bridge = window.agenthub;
  if (!bridge) return; // 非 Electron（Web 控制台 / 纯预览）没有本机目标概念
  try {
    const r = (await bridge.invoke("remote_targets_list")) as { activeId?: string; targets?: RemoteTarget[] } | null;
    if (r && Array.isArray(r.targets)) {
      remoteState.activeId = String(r.activeId || "local");
      remoteState.targets = r.targets;
      remoteState.ready = true;
    }
  } catch {
    /* 主进程异常时保持现状：远程特性不可用不影响本机使用 */
  }
}
