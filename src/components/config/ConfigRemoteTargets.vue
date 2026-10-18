<!-- 反代网关 · 配置页「远程实例」板块：桌面连接远程 Docker 版的目标管理。
     切换目标后整页重载——所有页面数据必须整体换源，局部刷新留到后续做 -->
<script setup lang="ts">
import { onMounted, ref } from "vue";
import * as api from "../../api/ipc";
import { refreshRemoteState, remoteState } from "../../api/remote";
import { toast } from "../../utils/toast";
import type { RemoteTarget } from "../../types";

const form = ref({ id: "", alias: "", baseUrl: "", token: "" });
const busy = ref(false);
const testing = ref(false);
const testResult = ref<{ ok: boolean; message?: string; version?: string; platform?: string } | null>(null);

function editTarget(t: RemoteTarget) {
  form.value = { id: t.id, alias: t.alias, baseUrl: t.baseUrl, token: "" }; // 令牌留空 = 不修改
  testResult.value = null;
}

function resetForm() {
  form.value = { id: "", alias: "", baseUrl: "", token: "" };
  testResult.value = null;
}

async function test() {
  if (testing.value || !form.value.baseUrl) return;
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await api.remoteTest({
      id: form.value.id || undefined,
      baseUrl: form.value.baseUrl,
      token: form.value.token || undefined,
    });
  } catch (e) {
    testResult.value = { ok: false, message: (e as Error).message };
  } finally {
    testing.value = false;
  }
}

async function save() {
  if (busy.value) return;
  busy.value = true;
  try {
    await api.remoteTargetsSave({
      id: form.value.id || undefined,
      alias: form.value.alias,
      baseUrl: form.value.baseUrl,
      token: form.value.token,
    });
    await refreshRemoteState();
    toast.success(form.value.id ? "已保存修改" : "已添加远程实例");
    resetForm();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function remove(t: RemoteTarget) {
  if (!window.confirm(`删除远程实例「${t.alias}」？（不会动服务器上的任何数据）`)) return;
  try {
    await api.remoteTargetsDelete(t.id);
    await refreshRemoteState();
    if (form.value.id === t.id) resetForm();
    toast.success("已删除");
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function activate(id: string) {
  if (remoteState.activeId === id) return;
  try {
    await api.remoteTargetsActivate(id);
    await refreshRemoteState();
    toast.success(id === "local" ? "已切回本机，页面即将刷新" : `已切到远程「${nameOf(id)}」，页面即将刷新`);
    setTimeout(() => window.location.reload(), 400); // 全页面换源
  } catch (e) {
    toast.error((e as Error).message);
  }
}

function nameOf(id: string): string {
  return remoteState.targets.find((t) => t.id === id)?.alias || id;
}

onMounted(() => {
  if (!remoteState.ready) void refreshRemoteState();
});
</script>

<template>
  <div class="rt">
    <div class="rt-head">
      <div>
        <div class="rt-title">远程实例</div>
        <div class="rt-sub">
          连接部署在服务器上的 Docker 版网关（同一套界面对它做监视与操作）。当前目标：
          <b>{{ remoteState.activeId === "local" ? "本机" : nameOf(remoteState.activeId) }}</b>
        </div>
      </div>
      <button v-if="remoteState.activeId !== 'local'" class="rt-btn" @click="activate('local')">切回本机</button>
    </div>

    <div class="rt-list">
      <div v-for="t in remoteState.targets" :key="t.id" class="rt-row" :class="{ on: remoteState.activeId === t.id }">
        <div class="rt-main">
          <b>{{ t.alias }}</b>
          <span class="rt-url">{{ t.baseUrl }}</span>
          <span v-if="remoteState.activeId === t.id" class="rt-badge">操作中</span>
        </div>
        <div class="rt-ops">
          <button class="rt-btn" :disabled="remoteState.activeId === t.id" @click="activate(t.id)">切到此实例</button>
          <button class="rt-btn" @click="editTarget(t)">编辑</button>
          <button class="rt-btn" @click="remove(t)">删除</button>
        </div>
      </div>
      <div v-if="!remoteState.targets.length" class="rt-empty">还没有远程实例，用下面的表单添加一个。</div>
    </div>

    <div class="rt-form">
      <div class="rt-form-title">{{ form.id ? "编辑实例" : "添加实例" }}</div>
      <input v-model="form.alias" class="rt-input" placeholder="名字（例如：家里服务器）" />
      <input v-model="form.baseUrl" class="rt-input" placeholder="地址（http://192.168.1.10:9528）" spellcheck="false" />
      <input
        v-model="form.token"
        type="password"
        class="rt-input"
        :placeholder="form.id ? '管理令牌（留空 = 不修改）' : '管理令牌（服务器上的 AGENTHUB_ADMIN_TOKEN）'"
      />
      <div class="rt-ops">
        <button class="rt-btn" :disabled="testing || !form.baseUrl" @click="test">{{ testing ? "测试中…" : "测试连接" }}</button>
        <button class="rt-btn primary" :disabled="busy || !form.baseUrl" @click="save">{{ form.id ? "保存" : "添加" }}</button>
        <button v-if="form.id" class="rt-btn" @click="resetForm">取消编辑</button>
      </div>
      <div v-if="testResult" class="rt-result" :class="testResult.ok ? 'ok' : 'err'">
        {{ testResult.ok ? `连接成功：v${testResult.version} · ${testResult.platform}` : testResult.message }}
      </div>
      <div class="rt-hint">
        令牌就是服务器上的 <code>AGENTHUB_ADMIN_TOKEN</code>；日常监视建议另设只读令牌
        <code>AGENTHUB_ADMIN_READONLY_TOKEN</code>（只读令牌不能做增删改）。http 仅限内网地址，
        公网必须用 https——令牌不能明文出网。
      </div>
    </div>
  </div>
</template>

<style scoped>
.rt {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rt-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.rt-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.rt-sub {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.rt-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--line);
}
:root[data-theme="light"] .rt-row {
  background: rgba(15, 23, 42, 0.03);
}
.rt-row.on {
  border-color: var(--accent-line);
}
.rt-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.rt-main b {
  font-size: 13px;
}
.rt-url {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rt-badge {
  flex: none;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: var(--r-pill);
  color: var(--accent-strong);
  background: var(--accent-dim);
  border: 1px solid var(--accent-line);
}
.rt-ops {
  display: flex;
  gap: 8px;
  flex: none;
}
.rt-btn {
  height: var(--ctl-h);
  padding: 0 12px;
  border-radius: var(--r-sm);
  cursor: pointer;
  font-size: 12px;
  font-family: var(--font-ui);
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--line);
}
.rt-btn:hover:not(:disabled) {
  color: var(--text);
  background: rgba(255, 255, 255, 0.05);
}
:root[data-theme="light"] .rt-btn:hover:not(:disabled) {
  background: rgba(15, 23, 42, 0.045);
}
.rt-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.rt-btn.primary {
  color: var(--accent-strong);
  background: var(--accent-dim);
  border-color: var(--accent-line);
}
.rt-empty {
  padding: 14px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
  border: 1px dashed var(--line);
  border-radius: var(--r-sm);
}
.rt-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: var(--r-sm);
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--line);
}
:root[data-theme="light"] .rt-form {
  background: rgba(15, 23, 42, 0.02);
}
.rt-form-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
}
.rt-input {
  height: var(--ctl-h);
  padding: 0 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: rgba(0, 0, 0, 0.2);
  color: var(--text);
  font-size: 12px;
  font-family: var(--font-ui);
  outline: none;
}
:root[data-theme="light"] .rt-input {
  background: rgba(15, 23, 42, 0.04);
}
.rt-input:focus {
  border-color: var(--accent-line);
}
.rt-result {
  font-size: 12px;
  line-height: 1.6;
}
.rt-result.ok {
  color: var(--accent-strong);
}
.rt-result.err {
  color: var(--danger);
}
.rt-hint {
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-3);
}
.rt-hint code {
  font-size: 11px;
  font-family: var(--font-mono);
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
}
:root[data-theme="light"] .rt-hint code {
  background: rgba(15, 23, 42, 0.06);
}
</style>
