// 反代网关 · 渠道「还能不能用」的判据（侧栏渠道额度卡片用它决定要不要列出来）
// 单独成模块而不是写在组件里：这条判据错了会**静默藏掉一个可用渠道**，
// 藏在模板里就只能靠肉眼看，落成纯函数才能拿数字喂着测。

/** 侧栏要藏的「死渠道」：号池里**有账号已经过期**，且**在线账号余额合计为 0**。
 *
 * 两个条件缺一不可：
 * - 只看过期 ⇒ 一个渠道里只要有一个号过期就把整条藏掉，而它可能还有可用号（`earliestExpire`
 *   是「最早的那个」，是 some 语义的最小值，不是「全都过期」）。
 * - 只看余额 0 ⇒ 把「还没刷过额度」的号池（`totalCredits` 初值就是 0）也藏掉，
 *   用户看到的是渠道凭空消失，而不是「额度用完了」。
 *
 * `earliestExpire === 0` 表示池里没有任何账号带到期时间（长期有效），永不算死。
 * 无限额度哨兵（`credits === -1`）不进 `totalCredits` 求和，所以「全无限」的渠道
 * 合计也是 0 —— 但它要么没到期（`earliestExpire` 为 0 或未来）要么真过期，两种都判得对。
 *
 * `now` 由调用方传入（不在这个函数里读时钟）：一次渲染只取一次时刻，
 * 也让判据可测——写死 Date.now() 就没法稳定地构造「刚好过期 1 毫秒」这一格。 */
export function isUnusableChannel(
  summary: { totalCredits: number; earliestExpire: number },
  now: number
): boolean {
  return summary.earliestExpire > 0 && summary.earliestExpire <= now && summary.totalCredits === 0;
}
