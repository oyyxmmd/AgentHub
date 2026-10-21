// 反代网关 · 同 body 请求去重排队（防风控的**行为层**手段，与请求头指纹无关）
//
// ── 为什么需要它 ────────────────────────────────────────────
// 客户端（Claude Code / Codex / 各类 SDK）在上游超时、断流、5xx 时会**立刻重发同一份 body**。
// 网关此时若让第 2、3 个请求并行打到上游，上游看到的是「同一个账号、同一份内容、几百毫秒内
// 连发三次」——这正是反代识别最典型的特征。更糟的是：WorkBuddy 的 11128（渠道白名单拦截）
// 失败后会**给拦截窗口续期**，重试风暴把「一次偶发拦截」滚成「整段时间全拦」。
//
// 本模块只做一件事：相同 body 的第 2、3 个请求，等第 1 个结束再发（不合并响应，各自独立）。
// 它不减少请求数，只把并发重试抹成串行节奏 —— 上游看到的是「客户端慢一点」，不是「机器在刷」。
//
// ── 实现取舍 ──────────────────────────────────────────────────
// 多线程实现需要「置位与登记谁先到」的双标志来覆盖竞态；Node 是单线程事件循环，
// `Map.get` 与 `Map.set` 之间不插入 await 就天然原子，一个 Promise 足够 ——
// 再加双标志反而多一层无用的状态机。
//
// ── 语义边界（三条，都是刻意选的）──────────────────────────────
//   1. **只等一个**：第 2、3 个请求等的是「当时表里的那一个」，它结束后各自开跑，
//      不做多级排队。多级排队会让长尾随并发数线性放大，而防风控只需要「别同时打」。
//   2. **有等待上限**：到点无条件放行。宁可让上游多接一个并发，也不能让用户因为
//      一个卡住的前序请求被无限期挂住（45s 上限）。
//   3. **槽位持到请求结束**：不是「拿到响应头」就放行。流式响应要等正文下发完才释放，
//      否则「重试请求」会与「仍在流式输出的上一个请求」并发打到上游 —— 那正是要防的事。
"use strict";
const crypto = require("node:crypto");

/** 等待上限（毫秒）：到点无条件放行，宁可多接一个并发也不无限期挂住 */
const DEFAULT_WAIT_MS = 45000;
/** 表项上限：极端流量下（全是不重复的 body）不让这张表无界增长。到顶即不排队，直接放行 */
const MAX_ENTRIES = 2000;

/** key → { done: Promise, resolve, startedAt } */
const table = new Map();

/** 空槽位（不需要排队时返回它，调用方无需判空） */
const NOOP_SLOT = Object.freeze({ key: "", waitedMs: 0, queued: false, release() {} });

/**
 * 请求体指纹：sha256(序列化后的原始 body)。
 *
 * 为什么取**原始** body 而不是某家适配器处理后的副本：去重回答的是「客户端是不是在重发
 * 同一件事」。适配器改写（模型名映射、内容脱敏、思考等级注入）是网关自己的加工，同一份
 * 客户端输入必然得到同一份加工结果，用原始体做键最省事，也不必关心此刻选了哪家。
 */
function bodyKey(body) {
  try {
    return crypto.createHash("sha256").update(JSON.stringify(body === undefined ? null : body)).digest("hex");
  } catch {
    return ""; // 循环引用等异常体：不排队（宁可少一层保护，也不能在这里抛错）
  }
}

/** 可等待的延时（超时即放行）。
 *  ⚠ 定时器**必须**是 ref 状态，不能 unref：等待去重时这个 timer 可能就是进程里唯一
 *  保持事件循环的东西，unref 后进程会在到期前静默退出（自测里踩到过，退出码还是 0，
 *  没有任何报错——这类「什么都没发生」的失败最难查）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 占位：如有同 key 在途，先等它（最多 waitMs），再占位。
 *
 * @param {string} key            bodyKey() 的结果；空串 = 不排队
 * @param {object} [opts]
 * @param {number} [opts.waitMs]  等待上限
 * @param {(info:{waitedMs:number,inflightMs:number})=>void} [opts.onWait] 真的等了才回调（日志用）
 * @returns {Promise<{key:string,waitedMs:number,queued:boolean,release:()=>void}>}
 */
async function acquire(key, opts) {
  if (!key) return NOOP_SLOT;
  const options = opts || {};
  const waitMs = Number(options.waitMs) > 0 ? Math.min(Number(options.waitMs), 300000) : DEFAULT_WAIT_MS;

  // ── 第一段：同步读表（读与下面的 set 之间不插 await，故不存在「都看到空」的竞态）
  const prev = table.get(key);
  let waitedMs = 0;
  if (prev) {
    const inflightMs = Math.max(0, Date.now() - prev.startedAt);
    const began = Date.now();
    // 只等这一个：它结束或到点，都放行
    await Promise.race([prev.done, sleep(waitMs)]);
    waitedMs = Date.now() - began;
    if (typeof options.onWait === "function") {
      try {
        options.onWait({ waitedMs, inflightMs });
      } catch {
        /* 日志回调失败不影响排队 */
      }
    }
  }

  // ── 第二段：占位。等待期间可能已被别人占住（多个等待者同时醒来），此时**不再等第二轮**——
  // 直接放行。理由见文件头「只等一个」：二级排队会让长尾随并发数放大，而防风控只需串行化一次。
  if (table.size >= MAX_ENTRIES) return { key, waitedMs, queued: false, release() {} };
  if (table.has(key)) return { key, waitedMs, queued: false, release() {} };

  let resolveDone = null;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const entry = { done, resolve: resolveDone, startedAt: Date.now() };
  table.set(key, entry);

  let released = false;
  return {
    key,
    waitedMs,
    queued: true,
    /** 释放槽位（幂等）：表项仍指向自己才删除——后来的同 key 请求可能已覆盖过它 */
    release() {
      if (released) return;
      released = true;
      if (table.get(key) === entry) table.delete(key);
      entry.resolve();
    },
  };
}

/** 当前在途条数（/status 与自测用） */
function size() {
  return table.size;
}

/** 清空（仅自测/停机用；运行中清空会让在途请求的 release 变成空操作，不影响正确性） */
function clear() {
  for (const [, entry] of table) {
    try {
      entry.resolve();
    } catch {
      /* 已 resolve */
    }
  }
  table.clear();
}

module.exports = { bodyKey, acquire, size, clear, DEFAULT_WAIT_MS, MAX_ENTRIES };
