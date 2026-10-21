<!-- 设置弹窗 · 反馈与需求：三个跳转入口（问题反馈 / 功能建议 / 渠道与模型支持）。
     用系统默认浏览器打开 GitHub 的 issue 表单——应用内打开拿不到 GitHub 登录态，
     也没法提交表单；模板已在仓库里预设好，填完直接提交即可。
     桌面走 open_external_url（主进程有域名白名单），Web/容器形态改用新标签页打开。 -->
<script setup lang="ts">
import { isElectron, openExternalUrl } from "../../api/ipc";
import { toast } from "../../utils/toast";

/** 仓库固定入口：三个表单模板都在 .github/ISSUE_TEMPLATE 下 */
const REPO = "https://github.com/HUIdada1/AgentHub";

interface Entry {
  key: string;
  title: string;
  desc: string;
  hint: string;
  cta: string;
  url: string;
}

const ENTRIES: Entry[] = [
  {
    key: "bug",
    title: "问题反馈",
    desc: "功能异常、报错、数据不对、界面错位",
    hint: "模板会问清「哪个板块 / 版本号 / 复现步骤 / 报错原文」，填全了才好直接定位",
    cta: "去反馈",
    url: `${REPO}/issues/new?template=bug_report.yml`,
  },
  {
    key: "feature",
    title: "功能建议",
    desc: "想要的新能力，或现有功能用着别扭的地方",
    hint: "说清「你现在怎么绕过去的」比直接给方案更有用",
    cta: "提建议",
    url: `${REPO}/issues/new?template=feature_request.yml`,
  },
  {
    key: "channel",
    title: "渠道 / 模型支持",
    desc: "希望反代网关接入新的客户端，或某个模型拿不到",
    hint: "开放平台（只认 API Key）的服务可以直接用「自定义提供商」，不必在这里提",
    cta: "去申请",
    url: `${REPO}/issues/new?template=channel_request.yml`,
  },
];

async function open(url: string) {
  if (isElectron()) {
    try {
      const r = await openExternalUrl(url);
      if (r && r.ok === false) toast.error(r.message || "打开链接失败");
    } catch (e) {
      toast.error((e as Error).message || "打开链接失败");
    }
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function openIssues() {
  open(`${REPO}/issues`);
}
</script>

<template>
  <div class="cfg-sec">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">反馈与需求</div>
        <div class="cfg-sec-sub">问题反馈 · 功能建议 · 渠道支持（跳转 GitHub Issue 表单，模板已预设）</div>
      </div>
    </div>

    <div class="card" style="padding: 6px 18px">
      <div class="switch-row" v-for="e in ENTRIES" :key="e.key">
        <div class="s-left">
          <div class="s-title">{{ e.title }}</div>
          <div class="s-desc">{{ e.desc }}</div>
          <div class="s-desc" style="color: var(--text-3)">{{ e.hint }}</div>
        </div>
        <button class="btn-outline" @click="open(e.url)">{{ e.cta }}</button>
      </div>
    </div>

    <div class="card" style="padding: 6px 18px">
      <div class="switch-row" style="padding-bottom: 4px">
        <div class="s-left">
          <div class="s-title">先看看有没有人提过</div>
          <div class="s-desc">点下面的入口打开已有 issue 列表；重复的问题会被合并，先在列表里搜一下能省一个来回</div>
          <div class="s-desc" style="color: var(--text-3)">
            提交前请把 token / Cookie / API Key 打码；反代网关的请求日志会脱敏请求头，但请求体与响应体是原样保存的
          </div>
        </div>
        <button class="btn-outline" @click="openIssues">打开列表</button>
      </div>
    </div>
  </div>
</template>
