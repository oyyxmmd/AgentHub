<script setup lang="ts">
// 网关托管形态的登录页：校验管理令牌 → 存 localStorage → 重进主界面。
// 独立挂载（不经主 App）：主界面挂载即发一堆请求，未登录会全 401 把界面打花
import { ref } from "vue";
import { setToken } from "../api/web-transport";

const token = ref("");
const busy = ref(false);
const error = ref("");

async function submit() {
  const t = token.value.trim();
  if (!t || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const res = await fetch("/api/status", { headers: { authorization: `Bearer ${t}` } });
    if (res.status === 401) {
      error.value = "令牌不正确";
    } else if (!res.ok) {
      error.value = `网关返回 HTTP ${res.status}`;
    } else {
      setToken(t);
      window.location.reload();
    }
  } catch (e) {
    error.value = "无法连接网关：" + ((e as Error).message || e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <form class="login-card" @submit.prevent="submit">
      <div class="login-title">AgentHub 网关控制台</div>
      <div class="login-sub">输入服务器上的管理令牌（AGENTHUB_ADMIN_TOKEN）</div>
      <input
        v-model="token"
        type="password"
        class="login-input"
        placeholder="管理令牌"
        autocomplete="current-password"
        autofocus
      />
      <button type="submit" class="login-btn" :disabled="busy || !token.trim()">
        {{ busy ? "验证中…" : "进入控制台" }}
      </button>
      <div v-if="error" class="login-err">{{ error }}</div>
    </form>
  </div>
</template>

<style scoped>
.login-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
  box-sizing: border-box;
}
.login-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 340px;
  padding: 28px 26px;
  border-radius: 16px;
  background: rgba(20, 24, 36, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(18px);
}
:root[data-theme="light"] .login-card {
  background: rgba(255, 255, 255, 0.86);
  border-color: rgba(15, 23, 42, 0.08);
}
.login-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--text, #e8ecf5);
}
.login-sub {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim, #94a3b8);
}
.login-input {
  height: 38px;
  padding: 0 12px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.25);
  color: var(--text, #e8ecf5);
  font-size: 13px;
  font-family: inherit;
  outline: none;
}
:root[data-theme="light"] .login-input {
  background: rgba(15, 23, 42, 0.04);
  border-color: rgba(15, 23, 42, 0.12);
}
.login-input:focus {
  border-color: rgba(99, 102, 241, 0.65);
}
.login-btn {
  height: 38px;
  border: none;
  border-radius: 9px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}
.login-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.login-err {
  font-size: 12px;
  color: #f87171;
  line-height: 1.5;
}
</style>
