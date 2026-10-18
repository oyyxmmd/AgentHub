// 阿里云无痕验证（滑块）求解器 —— 从 AutoClaw 客户端渲染层逐条移植
// （参照 agent2api ui/aliyun-captcha.js 的 solve 分支；静默铸造 mintTraceless 为
//   参照项目 ZCode 领取专用，AgentHub 无此场景，未移植）。
//
// 用途：AutoClaw 国际版网页登录前强制过一道风控滑块，拿到不透明 verifyParam
// 才能向上游换授权地址。SDK 从 o.alicdn.com 加载——主窗口 CSP 必须放行（issue #105：
// 自 v1.0.0 起 script-src 'self' 一直拦着该域，脚本加载即报「验证码组件加载失败」，
// 国际版 OAuth 因此从未走通过）。需放行的域与护栏见 index.html 的 CSP 注释。
//
// 一次只允许一个验证码流程（SDK 客户端是模块级的）：靠代际号让后发起的一轮
// 作废前一轮，迟到的回调对照代际号丢弃。

const ALIYUN_CAPTCHA_SCRIPT_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const SCRIPT_ID = "aliyun-captcha-sdk";
const ELEMENT_ID = "aliyun-captcha-element";
const BUTTON_ID = "aliyun-captcha-trigger";

const SCRIPT_LOAD_TIMEOUT_MS = 40000;
const INIT_TIMEOUT_MS = 40000;
const VERIFY_TIMEOUT_MS = 120000;
// SDK 初始化后至少等 2.1s 再点触发按钮（预热没完成时点击无效，客户端实测值）
const MINIMUM_WARMUP_MS = 2100;
// 初始化结果最多复用 19 分钟（超过重建，避免实例内部状态过期）
const INITIALIZATION_MAX_AGE_MS = 19 * 60000;

export class CaptchaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaError";
  }
}
export class CaptchaCancelledError extends CaptchaError {
  constructor() {
    super("已取消验证码");
    this.name = "CaptchaCancelledError";
  }
}

interface CaptchaConfig {
  region: string;
  prefix: string;
  sceneId: string;
}

type SdkInstance = { destroy?: () => void } | null;

declare global {
  interface Window {
    AliyunCaptchaConfig?: { region: string; prefix: string };
    initAliyunCaptcha?: (options: Record<string, unknown>) => void;
  }
}

let scriptLoadPromise: Promise<void> | null = null;
let initializationPromise: Promise<void> | null = null;
let initializationKey = "";
let initializationGeneration = 0;
let initializedAt = 0;
let captchaInstance: SdkInstance = null;
let pendingVerification: {
  generation: number;
  instance: SdkInstance;
  request: (verifyParam: string) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
  settled: boolean;
} | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** 阿里云只认短码语言（cn/tw/en/…），传 zh-CN 会被当成不认识回落英文，必须在这里归一 */
function resolveAliyunCaptchaLanguage(language: string): string {
  const normalized = String(language || "").trim().replace(/_/g, "-").toLowerCase();
  if (normalized === "zh-tw" || normalized.startsWith("zh-hant")) return "tw";
  if (normalized.startsWith("zh")) return "cn";
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("ko")) return "ko";
  if (normalized.startsWith("ar")) return "ar";
  if (normalized.startsWith("de")) return "de";
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("fr")) return "fr";
  if (normalized.startsWith("it")) return "it";
  if (normalized.startsWith("pt")) return "pt";
  if (normalized.startsWith("ru")) return "ru";
  if (normalized.startsWith("th")) return "th";
  if (normalized.startsWith("tr")) return "tr";
  if (normalized.startsWith("vi")) return "vi";
  return "en";
}

const currentLanguage = () => document.documentElement.lang || "zh-CN";

function getInitAliyunCaptcha() {
  const value = window.initAliyunCaptcha;
  return typeof value === "function" ? value : null;
}

function removeCaptchaElements() {
  document.getElementById(ELEMENT_ID)?.remove();
  document.getElementById(BUTTON_ID)?.remove();
}

/** 作废当前实例（配置变了 / 失败要重建时调） */
function invalidateInitialization() {
  const instance = captchaInstance;
  initializationGeneration += 1;
  captchaInstance = null;
  initializationPromise = null;
  initializedAt = 0;
  removeCaptchaElements();
  try { instance?.destroy?.(); } catch { /* 实例已不可用 */ }
}

/**
 * 备好滑块容器与触发按钮：element 是滑块面板落点，button 是「点它才弹」的触发器。
 * 按钮做成 1×1 透明且 pointer-events:none——用户看不到点不到，触发完全由代码控制，
 * 不会出现「用户自己点出两个滑块」。
 */
function ensureCaptchaElements(): HTMLButtonElement {
  let element = document.getElementById(ELEMENT_ID);
  if (!element) {
    element = document.createElement("div");
    element.id = ELEMENT_ID;
    element.style.position = "relative";
    element.style.zIndex = "2147483000";
    document.body.appendChild(element);
  }
  let button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (!button) {
    button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.tabIndex = -1;
    button.setAttribute("aria-hidden", "true");
    button.style.position = "fixed";
    button.style.width = "1px";
    button.style.height = "1px";
    button.style.opacity = "0";
    button.style.pointerEvents = "none";
    button.style.overflow = "hidden";
    document.body.appendChild(button);
  }
  return button;
}

/** SDK 脚本加载。window.AliyunCaptchaConfig 必须在加载**之前**设好（SDK 读它定站点），
 *  设晚了的表现是「验证码弹出来但一直转圈」 */
function loadAliyunCaptchaScript(config: CaptchaConfig): Promise<void> {
  window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix };
  if (getInitAliyunCaptcha()) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    const script = (existing as HTMLScriptElement) || document.createElement("script");
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };
    const fail = (error: CaptchaError) => {
      cleanup();
      scriptLoadPromise = null;
      script.remove();
      reject(error);
    };
    const onLoad = () => {
      cleanup();
      if (getInitAliyunCaptcha()) resolve();
      else fail(new CaptchaError("验证码组件加载异常，请重试"));
    };
    const onError = () => fail(new CaptchaError("验证码组件加载失败，请检查网络后重试"));
    timer = window.setTimeout(() => fail(new CaptchaError("验证码组件加载超时，请检查网络后重试")), SCRIPT_LOAD_TIMEOUT_MS);
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    if (!existing) {
      script.id = SCRIPT_ID;
      script.async = true;
      script.src = ALIYUN_CAPTCHA_SCRIPT_URL;
      document.head.appendChild(script);
    }
  });
  return scriptLoadPromise;
}

function settlePending(pending: NonNullable<typeof pendingVerification>, outcome: { error?: Error; value?: unknown }): boolean {
  if (pendingVerification !== pending || pending.settled) return false;
  pending.settled = true;
  window.clearTimeout(pending.timer);
  if (outcome.error) pending.reject(outcome.error);
  else pending.resolve(outcome.value);
  return true;
}

/** SDK 拿到验证串 → 交给调用方去干它那件事；返回 {captchaResult, bizResult} 决定 SDK 收不收滑块 */
async function captchaVerifyCallback(generation: number, captchaVerifyParam: string): Promise<{ captchaResult: boolean; bizResult: boolean }> {
  const pending = pendingVerification;
  if (!pending || pending.generation !== generation) return { captchaResult: false, bizResult: false };
  if (typeof captchaVerifyParam !== "string" || captchaVerifyParam.length === 0) {
    settlePending(pending, { error: new CaptchaError("验证码校验失败，请重试") });
    return { captchaResult: false, bizResult: false };
  }
  try {
    const result = await pending.request(captchaVerifyParam);
    if (pendingVerification !== pending || pending.settled) {
      return { captchaResult: true, bizResult: true };
    }
    settlePending(pending, { value: result });
    return { captchaResult: true, bizResult: true };
  } catch (error) {
    settlePending(pending, { error: error instanceof Error ? error : new CaptchaError(String(error || "验证码校验失败")) });
    return { captchaResult: false, bizResult: false };
  }
}

/** 初始化 SDK 实例：同配置 19 分钟内复用；配置变了或过期重建 */
function initializeAliyunCaptcha(config: CaptchaConfig): Promise<void> {
  const language = resolveAliyunCaptchaLanguage(currentLanguage());
  const key = `${config.region}:${config.prefix}:${config.sceneId}:${language}`;
  if (initializationPromise && initializationKey === key) {
    const inFlight = initializedAt === 0;
    const fresh = Date.now() - initializedAt < INITIALIZATION_MAX_AGE_MS;
    if (inFlight || fresh) return initializationPromise;
    invalidateInitialization();
  }
  if (initializationKey && initializationKey !== key) invalidateInitialization();
  initializationKey = key;
  const generation = ++initializationGeneration;
  initializationPromise = (async () => {
    await loadAliyunCaptchaScript(config);
    ensureCaptchaElements();
    const initAliyunCaptcha = getInitAliyunCaptcha();
    if (!initAliyunCaptcha) throw new CaptchaError("验证码组件不可用，请重试");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let boundInstance: SdkInstance = null;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new CaptchaError("验证码组件初始化超时，请重试"));
      }, INIT_TIMEOUT_MS);
      const settle = (callback: () => void): boolean => {
        if (settled) return false;
        settled = true;
        window.clearTimeout(timer);
        callback();
        return true;
      };
      try {
        initAliyunCaptcha({
          SceneId: config.sceneId,
          mode: "popup",
          element: `#${ELEMENT_ID}`,
          button: `#${BUTTON_ID}`,
          captchaVerifyCallback: (param: string) => captchaVerifyCallback(generation, param),
          onBizResultCallback: () => {},
          getInstance: (instance: SdkInstance) => {
            boundInstance = instance;
            if (generation !== initializationGeneration) {
              try { instance?.destroy?.(); } catch { /* 忽略 */ }
              return;
            }
            if (!settle(() => {
              captchaInstance = instance;
              initializedAt = Date.now();
              resolve();
            })) {
              try { instance?.destroy?.(); } catch { /* 忽略 */ }
            }
          },
          slideStyle: { width: 360, height: 40 },
          language,
          onError: (error: { message?: string }) => {
            const pending = pendingVerification;
            if (pending && pending.generation === generation && pending.instance === boundInstance) {
              settlePending(pending, { error: new CaptchaError((error && error.message) || "验证码校验失败，请重试") });
              return;
            }
            if (settled) {
              if (generation === initializationGeneration && (!boundInstance || captchaInstance === boundInstance)) {
                invalidateInitialization();
              }
              return;
            }
            settle(() => reject(new CaptchaError((error && error.message) || "验证码组件不可用，请重试")));
          },
        });
      } catch (error) {
        settle(() => reject(new CaptchaError((error instanceof Error && error.message) || "验证码组件不可用，请重试")));
      }
    });
    if (!captchaInstance) throw new CaptchaError("验证码组件不可用，请重试");
  })();
  initializationPromise.catch(() => {
    // 初始化失败不要把失败的 promise 缓存住（下一次要能重来）
    if (initializationPromise) initializationPromise = null;
  });
  return initializationPromise;
}

async function waitForWarmup() {
  const remaining = MINIMUM_WARMUP_MS - (Date.now() - initializedAt);
  if (remaining > 0) await sleep(remaining);
}

/**
 * 走一次完整验证码：初始化 → 预热 → 弹滑块 → 用户拖 → 拿串交给调用方。
 * request(verifyParam)：调用方注入的「用这个串去干那件事」，resolve 出来的值原样成为
 * solve() 的返回值。120 秒超时只包「拖滑块 + 那一次请求」——等登录回调这类长流程
 * 必须放在 solve() 返回之后，否则会被验证码超时误杀（三方状态错乱，参照实现实证的坑）。
 */
export async function solveCaptcha(config: CaptchaConfig, request: (verifyParam: string) => Promise<unknown>): Promise<unknown> {
  await initializeAliyunCaptcha(config);
  await waitForWarmup();
  const button = ensureCaptchaElements();
  const instance = captchaInstance;
  if (!instance) throw new CaptchaError("验证码组件不可用，请重试");
  const generation = initializationGeneration;
  return new Promise<unknown>((resolve, reject) => {
    const pending = {
      generation,
      instance,
      request,
      resolve,
      reject,
      timer: 0,
      settled: false,
    };
    pending.timer = window.setTimeout(() => {
      settlePending(pending, { error: new CaptchaError("验证码校验超时，请重试") });
    }, VERIFY_TIMEOUT_MS);
    pendingVerification = pending;
    button.click();
  });
}

/** 用户取消：把等待中的那次落定为「已取消」并作废实例。有等待返回 true */
export function cancelCaptcha(): boolean {
  const pending = pendingVerification;
  if (!pending) return false;
  const cancelled = settlePending(pending, { error: new CaptchaCancelledError() });
  if (cancelled) invalidateInitialization();
  return cancelled;
}

export const isCaptchaBusy = () => pendingVerification !== null;
