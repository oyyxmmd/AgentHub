<!-- 反代网关 · 自定义提供商：把第三方中转站 / 自建端点接进网关。
     一个提供商 = 一个上游端点 + 若干把 API Key（Key 走号池轮转与冷却）；模型以 `标识/模型名` 形态被客户端调用。
     与「号池」页的分工：这里管端点本身（地址、Key 集合、模型清单、连通性），号池页管各渠道账号的运行状态 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyProvider, ProxyProviderKey, ProxyProviderModel, ProxyProviderModelRow, ProxyProviderTestResult } from "../../types";
import { ACCOUNT_STATUS, fmtAgo } from "./format";
import { useAppStore } from "../../stores/app";

const app = useAppStore();
const rows = ref<ProxyProvider[]>([]);
const err = ref("");
const busy = ref(false);
const routing = ref({ saving: false, message: "" });

/** 开关的无障碍标签放脚本里算。模板属性里写 `cond ? 'A' : 'B'` 的三元，
 *  后面的 `:disabled="…"` 会被属性解析器吞进同一个表达式，报出的列号完全对不上原文。 */
function preferBuiltinLabel(): string {
  return app.config.proxy.preferBuiltin ? "关闭内置优先" : "开启内置优先";
}

/** 内置优先总闸：只有显式开启时才允许内置渠道参与自动路由；关闭时只走自定义提供商。
 *  显式 slug/model 始终直达自定义，不受此开关影响。
 *
 *  走独立 IPC（proxy_prefer_builtin_set）而不是整份配置保存：这个字段的写入口有两处
 *  （本页面与托盘面板），两边各持自己的配置快照。走整份提交时后保存的一方会用旧快照
 *  把先保存的一方冲掉——开关「自己弹回来」。收口到后端读改写后，两边改的都是同一份磁盘值。 */
async function setPreferBuiltin(on: boolean) {
  if (routing.value.saving) return;
  const old = app.config.proxy.preferBuiltin;
  app.config.proxy.preferBuiltin = on;
  routing.value = { saving: true, message: "" };
  try {
    const r = await api.proxyPreferBuiltinSet(on);
    routing.value = { saving: false, message: r && r.ok === false ? r.message || "保存失败" : "已保存，立即生效" };
    if (r && r.ok === false) app.config.proxy.preferBuiltin = old;
  } catch (e) {
    app.config.proxy.preferBuiltin = old;
    routing.value = { saving: false, message: String((e as Error).message || e) };
  }
}

// 系统级加密不可用时不阻断（与内置渠道凭据同一降级策略），但必须把「明文落盘」说清楚
const vault = ref<{ encrypted: boolean; driver: string; dataDir: string } | null>(null);

async function refresh() {
  try {
    const r = await api.proxyProviderList();
    if (r.ok === false) {
      err.value = r.message || "读取提供商列表失败";
      return;
    }
    rows.value = r.providers || [];
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
  vault.value = await api.proxyVaultStatus().catch(() => vault.value);
}

// ===== 新建 / 编辑表单 =====
// 模型清单的唯一真相是 modelRows（结构化表格）：它一旦有第二个可编辑源，
// 「从上游拉取」就会把已写的元数据整段抹平成裸名（曾经的真实行为）。
const formOpen = ref(false);
const editingId = ref("");
const form = ref({
  id: "",
  display: "",
  baseUrl: "",
  keysText: "",
  extraHeadersText: "",
  extraBodyText: "",
  enabled: true,
  /** 路由优先级：0 = 普通，越大越优先（同名裸模型多家命中时唯一最高者胜出） */
  priority: 0,
});
const formErr = ref("");
const testResult = ref<ProxyProviderTestResult | null>(null);
const testing = ref(false);

const isEdit = computed(() => !!editingId.value);

/** 档位词表必须与后端 util.EFFORT_LEVELS 同源，漂移由 scripts/test-provider-ui.cjs 断言守住 */
const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CAPS = [
  { key: "images", label: "视觉" },
  { key: "tools", label: "工具" },
  { key: "reasoning", label: "思考" },
] as const;

type ModelRow = {
  /** 行身份：与模型名解耦——重命名、导入合并都会换名，勾选态与逐行测试结果挂在名字上就会错位 */
  _rid: number;
  model: string;
  upstream: string;
  aliases: string[];
  proxyModel: string;
  contextLength: string;
  maxOutputTokens: string;
  rate: string;
  caps: Record<string, boolean>;
  efforts: string[];
};

let rowSeq = 0;

/** 空行：给"添加模型"用 */
function blankRow(): ModelRow {
  return { _rid: ++rowSeq, model: "", upstream: "", aliases: [], proxyModel: "", contextLength: "", maxOutputTokens: "", rate: "", caps: {}, efforts: [] };
}

/** 存库形状 → 表格行（字符串简写与历史缺字段都在这一步补齐，写回时再统一收敛） */
function toRow(m: ProxyProviderModel): ModelRow {
  const o = typeof m === "string" ? { model: m } : m || { model: "" };
  return {
    _rid: ++rowSeq,
    model: String(o.model || ""),
    upstream: String(o.upstream || ""),
    aliases: Array.isArray(o.aliases) ? o.aliases.map(String) : [],
    proxyModel: String(o.proxyModel || ""),
    contextLength: o.contextLength ? String(o.contextLength) : "",
    maxOutputTokens: o.maxOutputTokens ? String(o.maxOutputTokens) : "",
    rate: o.rate != null ? String(o.rate) : "",
    caps: { ...((o.capabilities || {}) as Record<string, boolean>) },
    efforts: Array.isArray(o.reasoning?.supportedEfforts) ? [...o.reasoning!.supportedEfforts!] : [],
  };
}

const modelRows = ref<ModelRow[]>([]);

/** 表格行 → 存库条目：只写有值的键，避免 models_json 里堆一串 null/空数组 */
function rowToModel(r: ModelRow): ProxyProviderModel {
  const upstream = (r.upstream || "").trim();
  const out: Record<string, unknown> = { model: (r.model || "").trim() };
  if (upstream && upstream !== out.model) out.upstream = upstream;
  const aliases = (r.aliases || []).map((a) => String(a).trim()).filter((a) => a && a.toLowerCase() !== String(out.model).toLowerCase());
  if (aliases.length) out.aliases = [...new Set(aliases)];
  if ((r.proxyModel || "").trim()) out.proxyModel = r.proxyModel.trim();
  if (Number(r.contextLength) > 0) out.contextLength = Number(r.contextLength);
  if (Number(r.maxOutputTokens) > 0) out.maxOutputTokens = Number(r.maxOutputTokens);
  if (r.rate !== "" && !Number.isNaN(Number(r.rate))) out.rate = Number(r.rate);
  const caps: Record<string, boolean> = {};
  for (const c of CAPS) if (r.caps?.[c.key]) caps[c.key] = true;
  if (Object.keys(caps).length) out.capabilities = caps;
  if (r.efforts?.length) out.reasoning = { supportedEfforts: r.efforts };
  return out as ProxyProviderModelRow;
}

const modelNames = computed(() => modelRows.value.map((r) => (r.model || "").trim()).filter(Boolean));

/** 表格里的模型名重复会让"该名字映射到哪个上游真名"变成猜——保存前先在前端拦一道，
 *  后端的 normalizeModels 是去重静默丢，那不适合当交互反馈 */
const dupModels = computed(() => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const n of modelNames.value) {
    const k = n.toLowerCase();
    if (seen.has(k)) dup.add(n);
    seen.add(k);
  }
  return [...dup];
});

function parseJsonObject(text: string, label: string): Record<string, unknown> | string {
  const t = String(text || "").trim();
  if (!t) return {};
  try {
    const v = JSON.parse(t);
    if (!v || typeof v !== "object" || Array.isArray(v)) return `${label}必须是 JSON 对象`;
    return v as Record<string, unknown>;
  } catch (e) {
    return `${label}不是合法 JSON：${String((e as Error).message || e)}`;
  }
}

function keysFromText(): { key: string }[] {
  return String(form.value.keysText || "")
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((key) => ({ key }));
}

function openCreate() {
  editingId.value = "";
  form.value = { id: "", display: "", baseUrl: "", keysText: "", extraHeadersText: "", extraBodyText: "", enabled: true, priority: 0 };
  modelRows.value = [];
  rowTest.value = {};
  formErr.value = "";
  testResult.value = null;
  formOpen.value = true;
}

function openEdit(row: ProxyProvider) {
  editingId.value = row.id;
  form.value = {
    id: row.id,
    display: row.display,
    baseUrl: row.baseUrl,
    keysText: "",
    extraHeadersText: row.extraHeaders && Object.keys(row.extraHeaders).length ? JSON.stringify(row.extraHeaders, null, 2) : "",
    extraBodyText: row.extraBody && Object.keys(row.extraBody).length ? JSON.stringify(row.extraBody, null, 2) : "",
    enabled: row.enabled,
    priority: Number(row.priority) || 0,
  };
  modelRows.value = (row.models || []).map(toRow);
  rowTest.value = {};
  formErr.value = "";
  testResult.value = null;
  formOpen.value = true;
}

async function doSave() {
  if (busy.value) return;
  const models = modelRows.value.filter((r) => (r.model || "").trim()).map(rowToModel);
  if (dupModels.value.length) {
    formErr.value = `模型名重复：${dupModels.value.join("、")}（同名会说不清该映射到哪个上游真名）`;
    return;
  }
  const headers = parseJsonObject(form.value.extraHeadersText, "extraHeaders");
  if (typeof headers === "string") {
    formErr.value = headers;
    return;
  }
  const body = parseJsonObject(form.value.extraBodyText, "extraBody");
  if (typeof body === "string") {
    formErr.value = body;
    return;
  }
  busy.value = true;
  try {
    const input = {
      id: form.value.id.trim(),
      display: form.value.display.trim(),
      baseUrl: form.value.baseUrl.trim(),
      models,
      extraHeaders: headers as Record<string, string>,
      extraBody: body,
      enabled: form.value.enabled,
      priority: form.value.priority,
    };
    const keys = keysFromText();
    // 更新路径不回 keyIds（不做 Key 增删），标注成并集形状让下面那条去重提示对两条路径都成立
    const r: { ok: boolean; keyIds?: string[]; message?: string } = isEdit.value
      ? await api.proxyProviderUpdate(input)
      : await api.proxyProviderCreate({ ...input, keys });
    if (r.ok === false) {
      formErr.value = r.message || "保存失败";
      return;
    }
    formOpen.value = false;
    await refresh();
    const keyIds = Array.isArray(r.keyIds) ? r.keyIds : [];
    if (!isEdit.value && keys.length > keyIds.length) {
      // 同一把 Key 粘两遍时后端只收一把（按内容去重）：不说一声用户以为都存上了
      err.value = `已创建；${keys.length - keyIds.length} 把重复的 Key 被跳过（同一把只存一次）`;
    }
  } catch (e) {
    formErr.value = String((e as Error).message || e);
  } finally {
    busy.value = false;
  }
}

// ===== 逐模型：行操作 / 批量 / 连通性 =====
const rowSel = ref<Set<string>>(new Set());
const rowTest = ref<Record<string, { state: "testing" | "ok" | "fail"; ms?: number; message?: string; sample?: string }>>({});

function rowId(r: ModelRow) {
  return `r${r._rid}`;
}
// 浮层正文走 el-tooltip（上游既有口径）。这三条都可能为空，空串必须 :disabled——
// 原生 title 给空串是不显示，el-tooltip 给空串会飘出一个空玻璃泡，两档语义得对齐
const rowOkTip = (r: ModelRow) => rowTest.value[rowId(r)]?.sample || "";
const rowFailTip = (r: ModelRow) => rowTest.value[rowId(r)]?.message || "";
const testTip = computed(() =>
  testResult.value ? ((testResult.value.ok ? testResult.value.sample : testResult.value.message) || "") : "");
function addModelRow() {
  modelRows.value.push(blankRow());
}
function removeModelRow(r: ModelRow) {
  const i = modelRows.value.indexOf(r);
  if (i < 0) return;
  const id = rowId(r);
  modelRows.value.splice(i, 1);
  rowSel.value.delete(id);
  delete rowTest.value[id];
}
function toggleRow(r: ModelRow) {
  const id = rowId(r);
  if (rowSel.value.has(id)) rowSel.value.delete(id);
  else rowSel.value.add(id);
  rowSel.value = new Set(rowSel.value);
}
/** 别名输入框用逗号串承载，写回时切分去空去重——比让用户在表格里操作数组少一层歧义 */
function setAliases(r: ModelRow, text: string) {
  const list = String(text || "")
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  r.aliases = [...new Set(list)];
}
function setCap(r: ModelRow, key: string, on: boolean) {
  if (on) r.caps = { ...r.caps, [key]: true };
  else {
    const next = { ...r.caps };
    delete next[key];
    r.caps = next;
  }
}
const allSelected = computed(
  () => modelRows.value.length > 0 && modelRows.value.every((r) => (r.model || "").trim() ? rowSel.value.has(rowId(r)) : true),
);
function toggleAll() {
  if (allSelected.value) rowSel.value = new Set();
  else rowSel.value = new Set(modelRows.value.filter((r) => (r.model || "").trim()).map(rowId));
}

/** 批量设置：留空的字段不参与修改——"全选后顺手清了上下文"这种误操作代价太高 */
const batch = ref({ contextLength: "", maxOutputTokens: "", rate: "", images: "", tools: "", reasoning: "", efforts: [] as string[] });
function applyBatch() {
  const b = batch.value;
  const touched = b.contextLength || b.maxOutputTokens || b.rate || b.images || b.tools || b.reasoning || b.efforts.length;
  if (!touched) {
    formErr.value = "批量设置里至少要填一项（留空表示不修改）";
    return;
  }
  formErr.value = "";
  for (const r of modelRows.value) {
    if (!rowSel.value.has(rowId(r))) continue;
    if (b.contextLength) r.contextLength = b.contextLength;
    if (b.maxOutputTokens) r.maxOutputTokens = b.maxOutputTokens;
    if (b.rate) r.rate = b.rate;
    for (const [key, val] of [["images", b.images], ["tools", b.tools], ["reasoning", b.reasoning]] as const) {
      if (!val) continue;
      if (val === "1") r.caps = { ...r.caps, [key]: true };
      else delete r.caps[key];
    }
    if (b.efforts.length) r.efforts = [...b.efforts];
  }
}

/** 编辑态不重填 Key 时，从该提供商已存的 Key 里挑一把（明文不过渲染层）。
 *  Key 列表随 proxy_provider_list 一起回来：号池视图只按内置渠道迭代，提供商不在其中。 */
function poolKeysOf(id: string): ProxyProviderKey[] {
  return rows.value.find((p) => p.id === id)?.keys || [];
}

/** 单个模型探一次真实请求。Key 来源与"测试连接"一致：表单里现填的优先，
 *  编辑态不重填则从号池挑一把。刻意不做"批量测全部"——一次点下去就是 N 个真实计费请求，
 *  用户要的是按需验一个。 */
async function testOne(r: ModelRow) {
  const model = (r.model || "").trim();
  if (!model) return;
  const id = rowId(r);
  if (rowTest.value[id]?.state === "testing") return;
  const key = keysFromText()[0]?.key || "";
  if (!key && !isEdit.value) {
    formErr.value = "请先在「API Key」里填一把 Key 再测试";
    return;
  }
  if (!key) {
    keyPickList.value = poolKeysOf(editingId.value);
    if (!keyPickList.value.length) {
      formErr.value = "该提供商还没有可用的 Key，先在「Key 管理」里加一把";
      return;
    }
    keyPickId.value = keyPickList.value[0]?.id || "";
    keyPickRowId.value = id;
    keyPickModel.value = model;
    keyPickOpen.value = true;
    return;
  }
  await runRowTest(id, model, { key });
}

async function runRowTest(id: string, model: string, { key = "", accountId = "" }) {
  // 上一次「先填 Key 再测试」这类表单级错误属于上一个动作：新一轮探测一开始就该收掉，
  // 否则用户按提示补完 Key，顶上那条红字还在，看起来像没生效
  formErr.value = "";
  rowTest.value = { ...rowTest.value, [id]: { state: "testing" } };
  const headers = parseJsonObject(form.value.extraHeadersText, "extraHeaders");
  const body = parseJsonObject(form.value.extraBodyText, "extraBody");
  try {
    const r: ProxyProviderTestResult = await api.proxyProviderTest({
      id: form.value.id.trim(),
      accountId: accountId || undefined,
      baseUrl: form.value.baseUrl.trim(),
      key,
      model,
      extraHeaders: typeof headers === "string" ? {} : (headers as Record<string, string>),
      extraBody: typeof body === "string" ? {} : body,
    });
    rowTest.value = {
      ...rowTest.value,
      [id]: r.ok
        ? { state: "ok", ms: r.ms, sample: r.sample }
        : { state: "fail", ms: r.ms, message: r.message || "探测失败" },
    };
  } catch (e) {
    rowTest.value = { ...rowTest.value, [id]: { state: "fail", message: String((e as Error).message || e) } };
  }
}

/** 连通性探测（整店一次）：仍用列表里第一个模型，作用是"地址与 Key 通不通" */
async function doTest() {
  if (testing.value) return;
  const model = modelNames.value[0] || "";
  if (!model) {
    testResult.value = { ok: false, message: "请先添加至少一个模型" };
    return;
  }
  const keys = keysFromText();
  if (!keys[0]?.key) {
    if (!isEdit.value) {
      formErr.value = "请先在「API Key」里填一把 Key 再测试";
      return;
    }
    keyPickList.value = poolKeysOf(editingId.value);
    if (!keyPickList.value.length) {
      formErr.value = "该提供商还没有可用的 Key，先在「Key 管理」里加一把";
      return;
    }
    keyPickId.value = keyPickList.value[0]?.id || "";
    keyPickRowId.value = "";
    keyPickModel.value = "";
    keyPickOpen.value = true;
    return;
  }
  await runTest({ key: keys[0].key });
}

async function runTest({ key = "", accountId = "" }) {
  testing.value = true;
  testResult.value = null;
  formErr.value = "";
  try {
    const headers = parseJsonObject(form.value.extraHeadersText, "extraHeaders");
    const body = parseJsonObject(form.value.extraBodyText, "extraBody");
    testResult.value = await api.proxyProviderTest({
      id: form.value.id.trim(),
      accountId: accountId || undefined,
      baseUrl: form.value.baseUrl.trim(),
      key,
      model: modelNames.value[0] || "",
      extraHeaders: typeof headers === "string" ? {} : (headers as Record<string, string>),
      extraBody: typeof body === "string" ? {} : body,
    });
  } catch (e) {
    testResult.value = { ok: false, message: String((e as Error).message || e) };
  } finally {
    testing.value = false;
  }
}

// 编辑态测试连接的 Key 选择框（明文不出主进程，只回账号 id 与展示字段）
const keyPickOpen = ref(false);
const keyPickId = ref("");
const keyPickList = ref<ProxyProviderKey[]>([]);
// 从"某一行的测试按钮"进来时记住那一行（行 id + 模型名），选完 Key 直接续上那次探测；整店测试留空
const keyPickRowId = ref("");
const keyPickModel = ref("");
async function confirmKeyPick() {
  keyPickOpen.value = false;
  if (keyPickRowId.value) {
    const rid = keyPickRowId.value;
    const model = keyPickModel.value;
    keyPickRowId.value = "";
    keyPickModel.value = "";
    await runRowTest(rid, model, { accountId: keyPickId.value });
    return;
  }
  await runTest({ accountId: keyPickId.value });
}

// ===== 从上游拉取：三态 diff，勾选合并 =====
const importOpen = ref(false);
const importState = ref<"loading" | "ready" | "error">("loading");
const importErr = ref("");
const upstreamIds = ref<string[]>([]);
/** 拉取时从公开元数据目录（models.dev）补齐的模型元数据：模型 id → { contextLength, maxOutputTokens, ... } */
const upstreamMeta = ref<Record<string, { contextLength?: number; maxOutputTokens?: number; name?: string; capabilities?: Record<string, boolean> }>>({});
/** 厂商目录自带的映射（官方名 + 历史别名）：拉取时把 upstream/aliases 一并带进新行 */
const upstreamEntries = ref<Record<string, { model: string; upstream?: string; aliases?: string[]; name?: string; proxyModel?: string }>>({});
// 拉取时的地址签名：改过之后再结果就"过期"了，直接应用会拿旧清单配新地址
const importSig = ref("");
const selAdd = ref<Set<string>>(new Set());
const selDrop = ref<Set<string>>(new Set());

const importGroups = computed(() => {
  const cur = new Set(modelNames.value.map((s) => s.toLowerCase()));
  const up = new Set(upstreamIds.value.map((s) => s.toLowerCase()));
  return {
    added: upstreamIds.value.filter((id) => !cur.has(id.toLowerCase())),
    existing: upstreamIds.value.filter((id) => cur.has(id.toLowerCase())),
    removed: [...cur].filter((k) => !up.has(k)).map((k) => modelNames.value.find((m) => m.toLowerCase() === k) || k),
  };
});

function sigNow() {
  return form.value.baseUrl.trim();
}

async function openImport() {
  if (!isEdit.value) {
    formErr.value = "「从上游拉取」要先保存一次（拉取用号池里已存的 Key）";
    return;
  }
  formErr.value = "";
  importOpen.value = true;
  await doImport();
}

async function doImport() {
  importState.value = "loading";
  importErr.value = "";
  importSig.value = sigNow();
  try {
    const r = await api.proxyProviderFetchModels(editingId.value);
    if (r.ok === false) {
      importState.value = "error";
      importErr.value = r.message || "拉取失败";
      return;
    }
    upstreamIds.value = (r.models || []).map(String);
    upstreamMeta.value = r.metadata || {};
    upstreamEntries.value = r.modelEntries || {};
    const g = importGroups.value;
    // 新增默认不勾（用户可能只想看），已存在默认保持，下架默认保留——删除必须是显式动作
    selAdd.value = new Set();
    selDrop.value = new Set(g.removed);
    importState.value = "ready";
  } catch (e) {
    importState.value = "error";
    importErr.value = String((e as Error).message || e);
  }
}

// 模板里 ref 会自动解包，所以不能把 selAdd 当 Ref 传进函数——各自给一个显式切换器
function toggleAdd(id: string) {
  const s = new Set(selAdd.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selAdd.value = s;
}
function toggleDrop(id: string) {
  const s = new Set(selDrop.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selDrop.value = s;
}

function applyImport() {
  const keep = new Set(modelNames.value.map((s) => s.toLowerCase()));
  for (const id of importGroups.value.removed) {
    if (!selDrop.value.has(id)) keep.delete(id.toLowerCase());
  }
  const rows2 = modelRows.value.filter((r) => keep.has((r.model || "").trim().toLowerCase()));
  // 已存在的行：只把「空缺」的上下文/输出上限补上，绝不覆盖用户手填过的值——
  // 公开目录（models.dev）与上游真实能力可能有偏差，用户手填值优先。
  for (const r of rows2) {
    const key = (r.upstream || r.model || "").trim();
    const meta = upstreamMeta.value[key] || upstreamMeta.value[(r.model || "").trim()] || {};
    if (!Number(r.contextLength) && meta.contextLength) r.contextLength = String(meta.contextLength);
    if (!Number(r.maxOutputTokens) && meta.maxOutputTokens) r.maxOutputTokens = String(meta.maxOutputTokens);
  }
  for (const id of selAdd.value) {
    if (keep.has(id.toLowerCase())) continue;
    // 上游真名常带命名空间（Qwen/Qwen2.5-72B 这类），而客户端名不能含 /（那是 slug 分隔符）：
    // 拆成「末段当客户端名、完整 id 当上游真名」，拉下来即可保存；末段撞名交给上面的重复提示
    const slash = id.lastIndexOf("/");
    const meta = upstreamMeta.value[id] || {};
    const vendorEntry = upstreamEntries.value[id] || {};
    // 拉取时自动带上上下文/输出上限：上游 /v1/models 不给窗口，公开目录能补就补，补不到留空由用户手填
    const row: ModelRow = {
      ...blankRow(),
      model: slash > 0 ? id.slice(slash + 1) : id,
      ...(slash > 0 ? { upstream: id } : {}),
      ...(vendorEntry.upstream ? { upstream: vendorEntry.upstream } : {}),
      ...(Array.isArray(vendorEntry.aliases) && vendorEntry.aliases.length ? { aliases: [...vendorEntry.aliases] } : {}),
      ...(vendorEntry.proxyModel ? { proxyModel: vendorEntry.proxyModel } : {}),
      ...(meta.contextLength ? { contextLength: String(meta.contextLength) } : {}),
      ...(meta.maxOutputTokens ? { maxOutputTokens: String(meta.maxOutputTokens) } : {}),
      ...(meta.capabilities ? { caps: { ...meta.capabilities } } : {}),
    };
    rows2.push(row);
  }
  modelRows.value = rows2;
  rowSel.value = new Set();
  importOpen.value = false;
}

const importStale = computed(() => importState.value === "ready" && importSig.value !== sigNow());

// ===== Key 管理 =====
const keysOpen = ref(false);
const keysRow = ref<ProxyProvider | null>(null);
const keysList = ref<ProxyProviderKey[]>([]);
/** 每把 Key 的余额查询结果：按账号 id 存，避免一个 Key 的查询结果串到另一把 */
const keyBalances = ref<Record<string, { state: "loading" | "ok" | "fail"; text: string }>>({});
const newKey = ref({ name: "", key: "" });
const keyErr = ref("");
const keyBusy = ref(false);
async function openKeys(row: ProxyProvider) {
  keysRow.value = row;
  keyBalances.value = {};
  newKey.value = { name: "", key: "" };
  keyErr.value = "";
  await refresh();
  keysList.value = rows.value.find((p) => p.id === row.id)?.keys || [];
  keysOpen.value = true;
}
/** 查一把 Key 的官方余额：只读取，不改冷却、不写流水。
 *  DeepSeek / Kimi 有公开余额接口；其它端点会明确回 unsupported，界面如实显示。 */
async function queryKeyBalance(acc: ProxyProviderKey) {
  const row = keysRow.value;
  if (!row || keyBalances.value[acc.id]?.state === "loading") return;
  keyBalances.value = { ...keyBalances.value, [acc.id]: { state: "loading", text: "查询中…" } };
  try {
    const r = await api.proxyProviderBalance({ id: row.id, accountId: acc.id, baseUrl: row.baseUrl });
    keyBalances.value = {
      ...keyBalances.value,
      [acc.id]: r.ok
        ? { state: "ok", text: `${r.credits ?? 0} ${r.unit || ""}`.trim() }
        : { state: "fail", text: r.unsupported ? "该端点不支持余额查询" : (r.message || "查询失败") },
    };
  } catch (e) {
    keyBalances.value = { ...keyBalances.value, [acc.id]: { state: "fail", text: String((e as Error).message || e) } };
  }
}
async function reloadKeys(id: string) {
  await refresh();
  keysList.value = rows.value.find((p) => p.id === id)?.keys || [];
}
async function doAddKey() {
  if (!keysRow.value || keyBusy.value) return;
  keyBusy.value = true;
  keyErr.value = "";
  try {
    const r = await api.proxyProviderAddKey(keysRow.value.id, newKey.value.key.trim(), newKey.value.name.trim());
    if (r.ok === false) {
      keyErr.value = r.message || "添加失败";
      return;
    }
    newKey.value = { name: "", key: "" };
    await reloadKeys(keysRow.value.id);
  } catch (e) {
    keyErr.value = String((e as Error).message || e);
  } finally {
    keyBusy.value = false;
  }
}
// 移出 Key 不可逆（库里只有密文，界面无从还原），与模块内其余删除动作一样先过确认框
const keyDelOpen = ref(false);
const keyDelRow = ref<ProxyProviderKey | null>(null);
function askRemoveKey(acc: ProxyProviderKey) {
  keyDelRow.value = acc;
  keyDelOpen.value = true;
}
async function doRemoveKey() {
  if (!keysRow.value || !keyDelRow.value) return;
  const acc = keyDelRow.value;
  keyDelOpen.value = false;
  try {
    const r = await api.proxyProviderRemoveKey(acc.id);
    if (r.ok === false) keyErr.value = r.message || "移出失败";
    await reloadKeys(keysRow.value.id);
  } catch (e) {
    keyErr.value = String((e as Error).message || e);
  }
}

async function toggleEnabled(row: ProxyProvider) {
  try {
    await api.proxyProviderUpdate({ id: row.id, enabled: !row.enabled });
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

/** 一键切换「优先」：0 ↔ 9。用固定档 9 而不是 1，是为了让"多台都被手滑点过优先"
 *  时彼此同级 → 落回「歧义不猜」，而不是靠 1/2/3 的先后顺序静默选出一家。
 * 需要更细的档位时去编辑弹窗手填数字。 */
const PRIORITY_TOGGLE = 9;
/** 「优先」按钮的提示文案放脚本里算：写在模板属性里要跨行拼三元，Vue 的模板→TS 变换
 *  会在换行处把表达式截断，报一个指向别处的语法错（列号完全对不上原文）。 */
function priorityTip(p: ProxyProvider): string {
  return Number(p.priority) > 0
    ? "取消优先：同名裸模型命中多家时将不再由此家胜出"
    : "设为优先：与别家声明同一个裸模型名时优先走这家（多台同为最高优先仍不猜）";
}
async function togglePriority(row: ProxyProvider) {
  try {
    await api.proxyProviderUpdate({ id: row.id, priority: Number(row.priority) > 0 ? 0 : PRIORITY_TOGGLE });
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

// ===== 删除确认 =====
const delOpen = ref(false);
const delRow = ref<ProxyProvider | null>(null);
async function doDelete() {
  if (!delRow.value) return;
  try {
    const r = await api.proxyProviderDelete(delRow.value.id);
    if (r.ok === false) err.value = r.message || "删除失败";
    delOpen.value = false;
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

onMounted(refresh);
// 页面 v-show 保活：onMounted 只跑一次；切回本页时补一次刷新，Key 的运行态与别处改过的配置不停留在旧数据
watch(
  () => app.activeModule === "proxy" && app.activePage === "providers",
  (on) => {
    if (on) refresh();
  }
);
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>
      <div class="routing-card card">
        <div class="routing-info">
          <div class="card-title">内置渠道启用</div>
          <div class="set-desc">只有开启「内置优先」时才允许内置渠道参与自动路由；关闭时只走自定义提供商。显式 <span class="mono">标识/模型名</span> 始终直达自定义。</div>
          <div class="set-desc">
            自定义提供商声明同一个裸模型名时，由各家的<b>优先</b>标记消歧——只有<b>唯一最高</b>的那家胜出；同级不猜。
          </div>
          <div v-if="routing.message" class="set-desc routing-msg" :class="{ 'err-text': /失败|错误|超时/.test(routing.message) }" role="status">{{ routing.message }}</div>
        </div>
        <div class="routing-control">
          <span class="routing-state">{{ app.config.proxy.preferBuiltin ? "内置优先" : "仅自定义" }}</span>
          <button class="switch" :class="{ on: app.config.proxy.preferBuiltin }" role="switch" :aria-checked="app.config.proxy.preferBuiltin" :aria-label="preferBuiltinLabel()" :disabled="routing.saving" @click="setPreferBuiltin(!app.config.proxy.preferBuiltin)"></button>
        </div>
      </div>
      <div class="toolbar">
        <button class="btn btn-primary" @click="openCreate()">添加自定义提供商</button>
      </div>
      <div class="tbl-wrap" style="margin-top: 12px">
        <table class="tbl">
          <tbody>
            <tr><th>标识</th><th>名称</th><th>上游地址</th><th>Key</th><th>模型</th><th>状态</th><th>更新</th><th>操作</th></tr>
            <tr v-for="p in rows" :key="p.id">
              <td class="mono">{{ p.id }}</td>
              <td>{{ p.display }}</td>
              <el-tooltip :content="p.baseUrl" :disabled="!p.baseUrl" placement="top">
                <td class="mono url-cell">{{ p.baseUrl }}</td>
              </el-tooltip>
              <td class="mono num">{{ p.onlineCount ?? 0 }}/{{ p.keyCount ?? 0 }}</td>
              <td class="mono num">{{ p.models.length }}</td>
              <td>
                <span class="tag" :class="p.enabled ? 'tag-ok' : 'tag-dim'">{{ p.enabled ? "启用" : "已停用" }}</span>
                <span v-if="p.enabled && !(p.keyCount ?? 0)" class="tag tag-warn">无 Key</span>
                <span v-if="p.priority > 0" class="tag tag-info">优先 {{ p.priority }}</span>
              </td>
              <td class="mono">{{ fmtAgo(p.updatedAt) }}</td>
              <td>
                <button class="btn-link btn-sm" @click="openKeys(p)">Key 管理</button>
                <button class="btn-link btn-sm" @click="openEdit(p)">编辑</button>
                <el-tooltip :content="priorityTip(p)" placement="top">
                  <button class="btn-link btn-sm" @click="togglePriority(p)">{{ p.priority > 0 ? "取消优先" : "优先" }}</button>
                </el-tooltip>
                <button class="btn-link btn-sm" @click="toggleEnabled(p)">{{ p.enabled ? "停用" : "启用" }}</button>
                <button class="btn-link btn-sm danger" @click="delRow = p; delOpen = true">删除</button>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="8" style="text-align: center; color: var(--text-3); padding: 18px">
                还没有自定义提供商 —— 点上方「添加自定义提供商」接入中转站或自建端点；
                接好后客户端用 <span class="mono">标识/模型名</span> 调用即可，与其他渠道共用同一个网关地址
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top: 12px">
        <div class="card-title">接入约定</div>
        <div class="code">
          客户端把 base_url 指向本网关、填一把网关 Key，模型名写 <b>标识/模型名</b>（如 myrelay/gpt-4o）即可直达该提供商。<br />
          默认只走自定义提供商；只有显式开启「内置优先」后才允许内置渠道参与自动路由。
          多家自定义声明同名时看优先数字：唯一最高者胜出，同级不猜。<br />
          模型清单里的别名同样能请求（<span class="mono">标识/别名</span>），但不出现在 /v1/models。
        </div>
      </div>
    </div>

    <Teleport to="body">
      <!-- 新建 / 编辑 -->
      <div v-if="formOpen" class="p-mask" @click.self="formOpen = false">
        <div class="p-dlg glass form-dlg">
          <div class="form-head">
            <div class="form-head-main">
              <div class="form-head-icon"><i class="ph ph-plugs-connected"></i></div>
              <div class="form-head-copy">
                <div class="form-kicker">CUSTOM PROVIDER</div>
                <div class="p-title">{{ isEdit ? "编辑自定义提供商" : "添加自定义提供商" }}</div>
                <div class="form-subtitle">连接兼容 OpenAI Chat Completions 的第三方端点或自建网关</div>
              </div>
            </div>
            <div class="form-head-actions">
              <span class="form-state" :class="{ muted: !form.enabled }">
                <i class="ph" :class="form.enabled ? 'ph-check-circle' : 'ph-x-circle'"></i>
                {{ form.enabled ? "启用中" : "已停用" }}
              </span>
              <button class="icon-btn form-close" aria-label="关闭" @click="formOpen = false">
                <i class="ph ph-x"></i>
              </button>
            </div>
          </div>
          <div class="form-body">
            <div v-if="formErr" class="form-alert" role="alert">
              <i class="ph ph-warning-circle"></i>
              <span>{{ formErr }}</span>
            </div>

            <section class="form-section">
              <div class="form-section-head">
                <div class="form-section-icon"><i class="ph ph-fingerprint"></i></div>
                <div>
                  <h3>基础信息</h3>
                  <p>定义调用前缀与列表中的展示名称</p>
                </div>
              </div>
              <div class="f-grid">
                <label class="f-row">
                  <span class="f-label">标识 <span class="f-required">必填</span></span>
                  <input v-model="form.id" class="input mono f-input" :disabled="isEdit" placeholder="myslug" />
                  <span class="set-desc">模型名前缀（{{ form.id || "myslug" }}/gpt-4o），创建后不可改</span>
                </label>
                <label class="f-row">
                  <span class="f-label">显示名</span>
                  <input v-model="form.display" class="input f-input" placeholder="我的中转站" />
                  <span class="set-desc">只影响界面展示，留空则使用标识</span>
                </label>
              </div>
            </section>

            <section class="form-section">
              <div class="form-section-head">
                <div class="form-section-icon"><i class="ph ph-link"></i></div>
                <div>
                  <h3>上游端点</h3>
                  <p>网关会将请求发送到此地址</p>
                </div>
              </div>
              <label class="f-row endpoint-field">
                <span class="f-label">Base URL <span class="f-required">必填</span></span>
                <div class="f-control-icon">
                  <i class="ph ph-link"></i>
                  <input v-model="form.baseUrl" class="input mono f-input" placeholder="https://relay.example.com/v1" />
                </div>
                <span class="set-desc">填写到 <span class="mono">/v1</span> 为止，网关会自动补全 Chat Completions 路径</span>
              </label>
            </section>

            <section class="form-section model-section">
              <div class="form-section-head model-section-head">
                <div class="form-section-icon"><i class="ph ph-package"></i></div>
                <div>
                  <h3>模型清单 <span class="section-count">{{ modelRows.filter((r) => r.model).length }}</span></h3>
                  <p>配置可用模型、上游真名和推理能力</p>
                </div>
                <div class="models-bar">
                  <button class="btn btn-sm" @click="openImport">
                    <i class="ph ph-cloud-arrow-down"></i>
                    从上游拉取
                  </button>
                  <button class="btn btn-sm btn-primary-soft" @click="addModelRow">
                    <i class="ph ph-plus"></i>
                    添加模型
                  </button>
                  <label v-if="modelRows.length" class="m-selall">
                    <input type="checkbox" :checked="allSelected" @change="toggleAll" />
                    全选
                  </label>
                </div>
              </div>
              <div v-if="dupModels.length" class="inline-warning">
                <i class="ph ph-warning"></i>
                模型名重复：{{ dupModels.join("、") }}
              </div>

              <!-- 批量条紧贴工具条而不是压在列表末尾：它是「勾选之后的下一步」，
                   隔着一屏模型行放下面，勾完就看不见回来了 -->
              <div v-if="rowSel.size" class="m-batch">
                <span class="set-desc">已选 {{ rowSel.size }} 个 →</span>
                <label class="m-num">上下文<input v-model="batch.contextLength" class="input mono" type="number" placeholder="不改" /></label>
                <label class="m-num">最大输出<input v-model="batch.maxOutputTokens" class="input mono" type="number" placeholder="不改" /></label>
                <label class="m-num">倍率<input v-model="batch.rate" class="input mono" type="number" step="0.1" placeholder="不改" /></label>
                <label v-for="c in CAPS" :key="c.key" class="m-num">
                  {{ c.label }}
                  <el-select v-model="batch[c.key]" size="small" popper-class="glass-popper" class="m-cap-sel">
                    <el-option value="" label="不改" />
                    <el-option value="1" label="设为支持" />
                    <el-option value="0" label="设为不支持" />
                  </el-select>
                </label>
                <el-select v-model="batch.efforts" multiple collapse-tags size="small" popper-class="glass-popper" class="m-efforts" placeholder="档位（不改）">
                  <el-option v-for="e in EFFORT_LEVELS" :key="e" :value="e" :label="e" />
                </el-select>
                <button class="btn btn-sm" @click="applyBatch">应用到所选</button>
              </div>

              <div v-if="!modelRows.length" class="models-empty set-desc">
                <i class="ph ph-cube"></i>
                还没有模型 —— 点「添加模型」手填，或「从上游拉取」后勾选导入；留空也能用，带前缀的模型名原样透传给上游
              </div>

              <div v-for="(m, index) in modelRows" :key="m._rid" class="m-row" :class="{ on: rowSel.has(rowId(m)) }">
                <div class="m-row-head">
                  <label class="m-check-wrap">
                    <input type="checkbox" class="m-check" :checked="rowSel.has(rowId(m))" @change="toggleRow(m)" />
                    <span>模型 {{ index + 1 }}</span>
                  </label>
                  <span class="m-display-name mono">{{ m.model || "未命名模型" }}</span>
                  <span v-if="m.model" class="m-ready"><i class="ph ph-check"></i> 已配置</span>
                  <div class="m-row-actions">
                    <el-tooltip v-if="rowTest[rowId(m)]?.state === 'ok'" :content="rowOkTip(m)" :disabled="!rowOkTip(m)" placement="top">
                      <span class="tag tag-ok">可用 {{ rowTest[rowId(m)]?.ms }}ms</span>
                    </el-tooltip>
                    <el-tooltip v-else-if="rowTest[rowId(m)]?.state === 'fail'" :content="rowFailTip(m)" :disabled="!rowFailTip(m)" placement="top">
                      <span class="tag tag-warn m-fail">{{ (rowTest[rowId(m)]?.message || "").slice(0, 40) }}</span>
                    </el-tooltip>
                    <button class="icon-btn m-test-icon" :disabled="!m.model || rowTest[rowId(m)]?.state === 'testing'" aria-label="测试模型" @click="testOne(m)">
                      <i class="ph ph-lightning"></i>
                    </button>
                    <el-tooltip content="移除模型" placement="top">
                      <button class="icon-btn m-del" aria-label="移除模型" @click="removeModelRow(m)">
                        <i class="ph ph-trash"></i>
                      </button>
                    </el-tooltip>
                  </div>
                </div>
                <div class="m-line">
                  <label class="m-field m-name">
                    <span>模型名</span>
                    <input v-model="m.model" class="input mono" placeholder="gpt-4o" />
                  </label>
                  <label class="m-field m-up">
                    <span>上游真名</span>
                    <input v-model="m.upstream" class="input mono" placeholder="缺省同模型名" />
                  </label>
                  <label class="m-field m-alias">
                    <span>别名</span>
                    <input :value="m.aliases.join(', ')" class="input mono" placeholder="逗号分隔"
                           @input="setAliases(m, ($event.target as HTMLInputElement).value)" />
                  </label>
                  <label class="m-field m-proxy">
                    <span>代理模型名</span>
                    <input v-model="m.proxyModel" class="input mono" placeholder="覆盖平台名" />
                  </label>
                </div>
                <div class="m-line m-sub">
                  <label class="m-num">上下文<input v-model="m.contextLength" class="input mono" type="number" placeholder="128000" /></label>
                  <label class="m-num">最大输出<input v-model="m.maxOutputTokens" class="input mono" type="number" placeholder="4096" /></label>
                  <label class="m-num">倍率<input v-model="m.rate" class="input mono" type="number" step="0.1" placeholder="-" /></label>
                  <label v-for="c in CAPS" :key="c.key" class="m-cap">
                    <input type="checkbox" :checked="!!m.caps[c.key]" @change="setCap(m, c.key, ($event.target as HTMLInputElement).checked)" />
                    <span>{{ c.label }}</span>
                  </label>
                  <label class="m-efforts-wrap">
                    <span>思考档位</span>
                    <el-select v-model="m.efforts" multiple collapse-tags collapse-tags-tooltip size="small"
                               popper-class="glass-popper" class="m-efforts" placeholder="未限制">
                      <el-option v-for="e in EFFORT_LEVELS" :key="e" :value="e" :label="e" />
                    </el-select>
                  </label>
                </div>
              </div>
            </section>

            <div v-if="!isEdit" class="f-row">
              <div class="set-name"><i class="ph ph-key"></i> API Key</div>
              <textarea v-model="form.keysText" class="input mono f-input" rows="3" placeholder="sk-..."></textarea>
              <div class="set-desc">一行一把；多把自动轮转，被限流的那把单独冷却。可留空，之后在「Key 管理」里加</div>
            </div>

            <section class="form-section">
              <div class="form-section-head">
                <div class="form-section-icon"><i class="ph ph-sliders-horizontal"></i></div>
                <div>
                  <h3>高级请求配置</h3>
                  <p>按需追加请求头与请求体字段</p>
                </div>
              </div>
              <div class="f-grid advanced-grid">
                <label class="f-row">
                  <span class="f-label">自定义请求头</span>
                  <textarea v-model="form.extraHeadersText" class="input mono f-input" rows="3" placeholder='{ "X-Channel": "agenthub" }'></textarea>
                  <span class="set-desc">JSON 对象，选填；鉴权头由网关按 Key 生成，不能在这里覆盖</span>
                </label>
                <label class="f-row">
                  <span class="f-label">附加请求体字段</span>
                  <textarea v-model="form.extraBodyText" class="input mono f-input" rows="3" placeholder='{ "reasoning": { "effort": "high" } }'></textarea>
                  <span class="set-desc">JSON 对象，选填，深合并进上游请求体；不能覆盖 model / messages / prompt / stream</span>
                </label>
              </div>
            </section>

            <div class="routing-grid">
              <div class="f-inline">
                <div class="f-inline-info">
                  <div class="set-name"><i class="ph ph-check-circle"></i> 启用</div>
                  <div class="set-desc">停用后不再参与路由，带此前缀的请求会报模型不存在</div>
                </div>
                <el-switch v-model="form.enabled" />
              </div>
              <div class="f-inline priority-control">
                <div class="f-inline-info">
                  <div class="set-name"><i class="ph ph-sliders"></i> 路由优先级</div>
                  <div class="set-desc">
                    同名裸模型由唯一最高优先者胜出，同级不猜；列表中的「优先」按钮一键设为 {{ PRIORITY_TOGGLE }}。
                  </div>
                </div>
                <input
                  v-model.number="form.priority"
                  type="number"
                  min="0"
                  max="999"
                  step="1"
                  class="input mono priority-input"
                  placeholder="0"
                />
              </div>
            </div>
          </div>
          <!-- 操作条固定在弹窗底部：表单比视口高，按钮跟着滚走的话每次保存都要先滚到底 -->
          <div class="form-foot">
            <el-tooltip content="向上游发一次 max_tokens=16 的真实最小请求：会计费，但不改动号池 Key 的冷却状态" placement="top">
              <button class="btn form-test-btn" :disabled="testing" @click="doTest">
                <i class="ph ph-lightning"></i>
                {{ testing ? "测试中…" : "测试连接" }}
              </button>
            </el-tooltip>
            <el-tooltip v-if="testResult" :content="testTip" :disabled="!testTip" placement="top">
              <span class="set-desc f-foot-msg" :class="{ 'err-text': !testResult.ok }">
                <template v-if="testResult.ok">
                  通过 {{ testResult.ms }}ms · {{ testResult.finishReason || "-" }} · token {{ testResult.usage?.prompt_tokens ?? "?" }}/{{ testResult.usage?.completion_tokens ?? "?" }}
                </template>
                <template v-else>失败：{{ testResult.message }}<template v-if="testResult.status">（HTTP {{ testResult.status }}）</template></template>
              </span>
            </el-tooltip>
            <div class="form-foot-actions">
              <button class="btn" @click="formOpen = false">取消</button>
              <button class="btn btn-primary" :disabled="busy" @click="doSave">
                <i class="ph ph-check"></i>
                {{ busy ? "保存中…" : (isEdit ? "保存更改" : "创建提供商") }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Key 管理 -->
      <div v-if="keysOpen" class="p-mask" @click.self="keysOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">{{ keysRow?.display }} · API Key</div>
          <div v-if="vault && !vault.encrypted" class="set-row">
            <div class="set-info">
              <div class="set-name">系统加密不可用</div>
              <div class="set-desc err-text">本机 DPAPI / safeStorage 取不到密钥，Key 将<b>明文</b>写入 stats.db（与现有渠道账号同一策略）。换机器或重装系统前请先导出。</div>
            </div>
          </div>
          <div v-if="keyErr" class="set-row"><div class="set-info"><div class="set-desc err-text">{{ keyErr }}</div></div></div>
          <div class="tbl-wrap">
            <table class="tbl">
              <tbody>
                <tr><th>名称</th><th>状态</th><th>余额</th><th>今日</th><th>最近使用</th><th>操作</th></tr>
                <tr v-for="acc in keysList" :key="acc.id">
                  <td>{{ acc.name }}</td>
                  <td>
                    <span class="tag" :class="acc.status === 'online' ? 'tag-ok' : 'tag-dim'">{{ ACCOUNT_STATUS[acc.status]?.text || acc.status }}</span>
                    <span v-if="acc.coolReason" class="set-desc"> · {{ acc.coolReason }}</span>
                  </td>
                  <td class="mono num">
                    <span v-if="keyBalances[acc.id]?.state === 'ok'" class="tag tag-ok">{{ keyBalances[acc.id].text }}</span>
                    <span v-else-if="keyBalances[acc.id]?.state === 'fail'" class="set-desc err-text">{{ keyBalances[acc.id].text }}</span>
                    <span v-else-if="keyBalances[acc.id]?.state === 'loading'" class="set-desc">查询中…</span>
                    <span v-else class="set-desc">-</span>
                  </td>
                  <td class="mono num">{{ acc.todayReq }} 次</td>
                  <td class="mono">{{ fmtAgo(acc.lastUsed) }}</td>
                  <td>
                    <button class="btn-link btn-sm" :disabled="keyBalances[acc.id]?.state === 'loading'" @click="queryKeyBalance(acc)">查余额</button>
                    <button class="btn-link btn-sm danger" @click="askRemoveKey(acc)">移出</button>
                  </td>
                </tr>
                <tr v-if="!keysList.length"><td colspan="6" class="empty-row">还没有 Key —— 在下方填一把。没有可用 Key 的提供商不会被调度</td></tr>
              </tbody>
            </table>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">名称</div></div>
            <input v-model="newKey.name" class="input" style="width: 160px" placeholder="主 Key" />
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">API Key</div><div class="set-desc">加密存库；同一把重复粘贴会被拒</div></div>
            <input v-model="newKey.key" class="input mono" style="width: 300px" placeholder="sk-..." />
          </div>
          <div class="p-actions">
            <button class="btn" @click="keysOpen = false">关闭</button>
            <button class="btn btn-primary" :disabled="keyBusy || !newKey.key.trim()" @click="doAddKey">{{ keyBusy ? "添加中…" : "添加 Key" }}</button>
          </div>
        </div>
      </div>

      <!-- 移出 Key 确认（不可逆：库里只有密文，界面无从还原） -->
      <div v-if="keyDelOpen" class="p-mask" @click.self="keyDelOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">移出 Key</div>
          <div class="set-desc">
            确定从「{{ keysRow?.display }}」移出 Key「{{ keyDelRow?.name }}」？移出后它立即不再参与轮转，库里的密文一并删除，无法恢复。
          </div>
          <div class="p-actions">
            <button class="btn" @click="keyDelOpen = false">取消</button>
            <button class="btn btn-primary danger-solid" @click="doRemoveKey">移出</button>
          </div>
        </div>
      </div>

      <!-- 编辑态测试连接时从已存 Key 里挑一把 -->
      <div v-if="keyPickOpen" class="p-mask" @click.self="keyPickOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">选一把已有 Key 来测试</div>
          <div class="set-desc" style="margin-bottom: 8px">表单里的 Key 输入框是空的（编辑态不重填），测试需要一把真 Key。选中的 Key 只用于这次请求，不会被改动冷却状态。</div>
          <el-select v-model="keyPickId" popper-class="glass-popper" style="width: 100%">
            <el-option v-for="a in keyPickList" :key="a.id" :value="a.id" :label="`${a.name}（${ACCOUNT_STATUS[a.status]?.text || a.status}）`" />
          </el-select>
          <div class="p-actions">
            <button class="btn" @click="keyPickOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="!keyPickId" @click="confirmKeyPick">测试</button>
          </div>
        </div>
      </div>

      <!-- 从上游拉取：三态 diff 勾选合并（新增默认不勾 / 已存在默认保留 / 下架默认保留，删除要显式取消勾选） -->
      <div v-if="importOpen" class="p-mask" @click.self="importOpen = false">
        <div class="p-dlg glass imp-dlg">
          <div class="p-title">从上游拉取模型</div>
          <div v-if="importState === 'loading'" class="set-desc">正在请求上游 /v1/models…</div>
          <div v-else-if="importState === 'error'" class="set-desc err-text">
            {{ importErr }}
            <div class="p-actions"><button class="btn" @click="importOpen = false">关闭</button><button class="btn btn-primary" @click="doImport">重试</button></div>
          </div>
          <template v-else>
            <div v-if="importStale" class="set-desc imp-stale">
              上游地址在拉取之后改过了，这份清单已经过期——先重新拉取再合并，否则会把旧地址的模型配到新地址上。
              <button class="btn-link btn-sm" @click="doImport">重新拉取</button>
            </div>
            <div class="set-desc imp-sum">上游共 {{ upstreamIds.length }} 个模型：新增 {{ importGroups.added.length }} · 已存在 {{ importGroups.existing.length }} · 上游已下架 {{ importGroups.removed.length }}</div>

            <div v-if="importGroups.added.length" class="imp-group">
              <div class="imp-head">
                <b>新增</b>
                <span class="set-desc">默认不勾选，勾上的才加进清单</span>
                <button class="btn-link btn-sm" @click="selAdd = new Set(importGroups.added)">全选</button>
                <button class="btn-link btn-sm" @click="selAdd = new Set()">清空</button>
              </div>
              <label v-for="id in importGroups.added" :key="id" class="imp-item">
                <input type="checkbox" :checked="selAdd.has(id)" @change="toggleAdd(id)" /> <span class="mono">{{ id }}</span>
              </label>
            </div>

            <div v-if="importGroups.existing.length" class="imp-group">
              <div class="imp-head"><b>已存在</b><span class="set-desc">保留现有配置（别名、档位与已填上下文都不动；空缺的上下文/输出上限自动补齐）</span></div>
              <div class="imp-item set-desc">共 {{ importGroups.existing.length }} 个：{{ importGroups.existing.join("、") }}</div>
            </div>

            <div v-if="importGroups.removed.length" class="imp-group">
              <div class="imp-head">
                <b>上游已下架</b>
                <span class="set-desc">默认保留；取消勾选即从清单里删除</span>
              </div>
              <label v-for="id in importGroups.removed" :key="id" class="imp-item">
                <input type="checkbox" :checked="selDrop.has(id)" @change="toggleDrop(id)" /> <span class="mono">{{ id }}</span>
              </label>
            </div>

            <div v-if="!importGroups.added.length && !importGroups.removed.length" class="set-desc">上游清单与本地一致，无需合并。</div>

            <div class="p-actions">
              <button class="btn" @click="importOpen = false">取消</button>
              <button class="btn btn-primary" :disabled="importStale" @click="applyImport">
                合并（新增 {{ selAdd.size }} 个、删除 {{ importGroups.removed.length - selDrop.size }} 个）
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- 删除确认 -->
      <div v-if="delOpen" class="p-mask" @click.self="delOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">删除自定义提供商</div>
          <div class="set-desc">
            确定删除「{{ delRow?.display }}」（{{ delRow?.id }}）？它的 {{ delRow?.keyCount ?? 0 }} 把 Key 会一并移出。
            正在用 <span class="mono">{{ delRow?.id }}/模型名</span> 的客户端会立即收到「模型不在任何渠道目录中」。
          </div>
          <div class="p-actions">
            <button class="btn" @click="delOpen = false">取消</button>
            <button class="btn btn-primary danger-solid" @click="doDelete">删除</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.routing-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.routing-card .card-title {
  margin-bottom: 5px;
}
.routing-info {
  min-width: 0;
}
.routing-control {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.routing-state {
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
}
.routing-msg {
  margin-top: 6px;
}
.danger {
  color: var(--err, #e05555);
}
.url-cell {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* ===== 表单弹窗：标题与操作条固定，只有中间字段区滚动 =====
   整窗一起滚的话「保存」会在填到一半时滚出视口，每次提交都得先滚到底。
   .p-dlg 自带 padding 与 overflow:hidden，这里改成三段式布局，内边距下放到各段。 */
.form-dlg {
  width: min(980px, calc(100vw - 32px));
  max-height: min(92vh, 940px);
  display: flex;
  flex-direction: column;
  padding: 0;
}
.form-head {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 22px 24px 18px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel-2) 58%, transparent);
}
.form-head-main {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.form-head-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: none;
  border: 1px solid var(--accent-line);
  border-radius: 12px;
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 20px;
}
.form-head-copy {
  min-width: 0;
}
.form-kicker {
  margin-bottom: 3px;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.form-head .p-title {
  margin: 0;
  font-size: 18px;
  line-height: 1.25;
}
.form-subtitle {
  margin-top: 5px;
  color: var(--text-3);
  font-size: 12px;
}
.form-head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.form-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-size: 11.5px;
  font-weight: 650;
}
.form-state.muted {
  border-color: var(--line);
  background: var(--bg-soft);
  color: var(--text-3);
}
.form-close {
  width: 30px;
  height: 30px;
  font-size: 16px;
}
.form-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 24px 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: color-mix(in srgb, var(--bg) 18%, transparent);
}
.form-alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--err, #e05555) 34%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--err, #e05555) 8%, transparent);
  color: var(--err, #e05555);
  font-size: 12px;
  line-height: 1.5;
}
.form-alert i {
  margin-top: 1px;
  font-size: 15px;
}
.form-section {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel) 58%, transparent);
}
.form-section-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 14px;
}
.form-section-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 15px;
}
.form-section-head h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
}
.form-section-head p {
  margin: 3px 0 0;
  color: var(--text-3);
  font-size: 11.5px;
  line-height: 1.45;
}
.section-count {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 700;
}
.model-section-head {
  align-items: center;
}
.model-section-head .models-bar {
  margin-left: auto;
}
.form-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 62px;
  padding: 11px 24px 13px;
  border-top: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel-2) 68%, transparent);
}
.form-test-btn {
  flex: none;
}
.form-foot-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
/* 测试结果挤在按钮排里：长了就截断，完整内容在 el-tooltip 浮层上 */
.f-foot-msg {
  max-width: min(390px, 34vw);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.f-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.f-label {
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 650;
}
.f-required {
  margin-left: 4px;
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 500;
}
.f-models {
  gap: 6px;
}
.f-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.advanced-grid {
  align-items: start;
}
.f-control-icon {
  position: relative;
}
.f-control-icon > i {
  position: absolute;
  left: 11px;
  top: 50%;
  z-index: 1;
  color: var(--text-3);
  font-size: 14px;
  pointer-events: none;
  transform: translateY(-50%);
}
.f-control-icon .f-input {
  padding-left: 34px;
}
.f-warn {
  color: var(--warn, #d9a13b);
}
.f-count {
  margin-left: 6px;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-3);
}
.f-input {
  width: 100%;
}
.f-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--panel) 48%, transparent);
}
.f-inline-info {
  min-width: 0;
}
.f-inline .set-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
.f-inline .set-name i {
  color: var(--accent);
  font-size: 14px;
}
.routing-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  gap: 12px;
}
.priority-input {
  width: 86px;
  flex: none;
  text-align: center;
}
/* ===== 模型清单：工具条 + 逐行两行式 ===== */
.models-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.m-selall {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 30px;
  padding: 0 6px;
  font-size: 12px;
  color: var(--text-2);
}
.btn-primary-soft {
  border-color: var(--accent-line);
  background: var(--accent-dim);
  color: var(--accent-strong);
}
.inline-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  color: var(--warn, #d9a13b);
  font-size: 11.5px;
}
.models-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 78px;
  padding: 16px;
  border: 1px dashed var(--line);
  border-radius: 10px;
  text-align: center;
}
.models-empty i {
  color: var(--text-3);
  font-size: 18px;
}
.m-row {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--panel-2) 40%, transparent);
  transition: border-color 0.18s ease, background 0.18s ease;
}
.m-row.on {
  border-color: var(--accent-line);
  background: color-mix(in srgb, var(--accent-dim) 45%, var(--panel-2));
}
.m-row-head {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 42px;
  padding: 8px 10px 8px 12px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel-2) 76%, transparent);
}
.m-check-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  color: var(--text-3);
  font-size: 10.5px;
  font-weight: 650;
}
.m-display-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-2);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-ready {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  color: var(--accent-strong);
  font-size: 10px;
}
.m-row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.m-test-icon,
.m-del {
  width: 28px;
  height: 28px;
  font-size: 14px;
}
.m-del {
  color: var(--text-3);
}
.m-del:hover {
  color: var(--err, #e05555);
  border-color: color-mix(in srgb, var(--err, #e05555) 34%, transparent);
}
.m-line {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  min-width: 0;
  padding: 12px;
}
.m-check {
  flex: none;
}
.m-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.m-field > span,
.m-efforts-wrap > span {
  color: var(--text-3);
  font-size: 10.5px;
  font-weight: 600;
}
.m-name {
  min-width: 0;
}
.m-alias {
  min-width: 0;
}
.m-up {
  min-width: 0;
}
.m-proxy {
  min-width: 0;
}
.m-sub {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 12px 12px;
  font-size: 11.5px;
  color: var(--text-2);
}
.m-num {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 4px;
}
.m-num .input {
  width: 104px;
}
.m-cap {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg-soft);
  color: var(--text-3);
  cursor: pointer;
  font-size: 11px;
  transition: border-color 0.18s ease, background 0.18s ease, color 0.18s ease;
}
.m-cap:has(input:checked) {
  border-color: var(--accent-line);
  background: var(--accent-dim);
  color: var(--accent-strong);
}
.m-cap input {
  width: 13px;
  height: 13px;
}
.m-efforts-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 150px;
}
/* 选择控件跟全站同观感：原生 checkbox 补强调色与手型（与 Key 页选择列同款） */
.m-selall input[type="checkbox"],
.m-check,
.m-cap input[type="checkbox"],
.imp-item input[type="checkbox"] {
  cursor: pointer;
  accent-color: var(--accent);
}
.m-cap-sel {
  width: 104px;
}
.m-efforts {
  width: 100%;
}
.m-fail {
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-batch {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
  padding: 10px;
  border: 1px solid var(--accent-line);
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent-dim) 48%, var(--panel-2));
}

@media (max-width: 760px) {
  .p-mask {
    padding: 8px;
  }
  .form-dlg {
    width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
  }
  .form-head {
    padding: 16px;
  }
  .form-head-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    font-size: 18px;
  }
  .form-head .p-title {
    font-size: 16px;
  }
  .form-subtitle {
    display: none;
  }
  .form-state {
    display: none;
  }
  .form-body {
    padding: 12px 16px 18px;
  }
  .form-section {
    padding: 13px;
  }
  .model-section-head {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .model-section-head .models-bar {
    width: 100%;
    margin-left: 40px;
  }
  .f-grid,
  .routing-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .m-line {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .form-foot {
    flex-wrap: wrap;
    padding: 10px 16px;
  }
  .f-foot-msg {
    order: 3;
    width: 100%;
    max-width: none;
  }
  .form-foot-actions {
    margin-left: auto;
  }
}

@media (max-width: 520px) {
  .form-head-main {
    gap: 9px;
  }
  .form-kicker {
    display: none;
  }
  .form-close {
    width: 28px;
    height: 28px;
  }
  .models-bar {
    gap: 6px;
  }
  .model-section-head .models-bar {
    margin-left: 0;
  }
  .m-row-head {
    flex-wrap: wrap;
  }
  .m-display-name {
    max-width: calc(100% - 130px);
  }
  .m-line {
    grid-template-columns: minmax(0, 1fr);
  }
  .m-sub {
    align-items: flex-start;
  }
  .m-num {
    width: calc(50% - 4px);
  }
  .m-num .input {
    width: 100%;
  }
  .f-inline {
    align-items: flex-start;
  }
  .priority-input {
    width: 74px;
  }
  .form-foot-actions {
    width: 100%;
  }
  .form-foot-actions .btn {
    flex: 1;
  }
}
/* ===== 拉取合并弹窗 ===== */
.imp-dlg {
  width: 620px;
  max-height: 84vh;
  overflow: auto;
}
.imp-sum {
  margin-bottom: 8px;
}
.imp-stale {
  color: var(--warn, #d9a13b);
  margin-bottom: 8px;
}
.imp-group {
  margin-bottom: 10px;
}
.imp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.imp-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 2px 6px;
  font-size: 12px;
}
.empty-row {
  text-align: center;
  color: var(--text-3);
  padding: 14px;
}
</style>
