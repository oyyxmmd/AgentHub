// 技能仓库「链接指向异常」（diff-link）自测：裁决面板能给的两个动词各自的磁盘效果。
// 现场三种——链接指向别处 / 链接悬空 / 链接指向中央仓库内部——plus 位置已被换成真实目录的兜底。
// 运行：node scripts/test-skills-diff-link.cjs
// 只碰临时目录（AGENT_SKILLS_FAKE_HOME / AGENT_SKILLS_HOME / AGENTHUB_DATA_DIR 三个沙箱钩子），
// 不碰真实 home、不联网、不需要 Electron
//
// 钉死的不变量（改动前必红）：
//   ① relink 只换链接本身，链接指向的内容一个字都不动，原链接进回收站可还原；
//   ② 中央没有真身时 relink 必须如实拒绝，不能"裁决成功"却什么都没挂上；
//   ③ adopt 只复制不移动：链接指向的那份原地保留；中央旧版先进回收站；
//   ④ 裁决成功后记账（manifest.mounts），下一轮扫描不再报同一条 —— 否则红点永不消失、
//      watch 自动感知同步被硬冲突永久卡死；
//   ⑤ 位置上是真实目录时两个动词都报错，绝不猜（那是内容冲突的语义）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-skill-difflink-"));
const HOME = path.join(TMP, "home");
const HUB = path.join(TMP, "hub");
process.env.AGENT_SKILLS_FAKE_HOME = HOME; // 工具目录按它展开（adapter.expandPath）
process.env.AGENT_SKILLS_HOME = HUB; // 中央技能仓库
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data"); // 配置目录
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

const config = require("../electron/backend/config.cjs");
const syncer = require("../electron/backend/syncer.cjs");
const hub = require("../electron/backend/hub.cjs");
const mounter = require("../electron/backend/mounter.cjs");

const cfg = config.loadConfig();
const CLAUDE = path.join(HOME, ".claude", "skills");
const AGENTS = path.join(HOME, ".agents", "skills");
const CODEX = path.join(HOME, ".codex", "skills");
const ZCODE = path.join(HOME, ".zcode", "skills");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

/** 造一个最小可识别技能目录（扫描层只认 SKILL.md 的 frontmatter） */
function writeSkill(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} 自测技能\n---\n\n${body}\n`);
  return dir;
}

function readSkill(dir) {
  return fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8");
}

/** 建链接（Windows 走 junction）；已存在先删，让每个用例从同一现场起步 */
function makeLink(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (fs.existsSync(linkPath) || mounter.isLink(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function diffLinkIds(plan) {
  return plan.conflicts.filter((c) => c.kind === "diff-link").map((c) => c.id);
}

/** 现场用条目：id/kind/skill/toolId/dir 与 planSync 落库的形态一致 */
function itemOf(skill, toolId, dir) {
  return { id: `diff-link:${skill}@${toolId}`, kind: "diff-link", skill, toolId, dir, title: `${toolId}:${skill} 链接指向异常`, detail: "现有链接不指向中央真身，需人工确认" };
}

function trashNames() {
  return fs.readdirSync(path.join(HUB, ".trash"));
}

/** 回收站里有没有一个指向 target 的链接条目（"只搬链接本身、可还原"的证据） */
function trashHoldsLink(target) {
  return trashNames().some((name) => {
    const p = path.join(HUB, ".trash", name);
    return mounter.isLink(p) && mounter.pointsTo(p, target);
  });
}

/** 回收站里有没有内容等于 text 的技能目录（覆盖前先进回收站的证据） */
function trashHoldsContent(text) {
  return trashNames().some((name) => {
    const f = path.join(HUB, ".trash", name, "SKILL.md");
    return fs.existsSync(f) && !mounter.isLink(path.join(HUB, ".trash", name)) && fs.readFileSync(f, "utf-8") === text;
  });
}

function mountRow(skill, toolId) {
  const m = hub.loadManifest();
  return ((m.skills[skill] || {}).mounts || []).find((x) => x.tool === toolId);
}

function main() {
  // ---------- [1] 现场识别：链接指向另一个工具目录（用户报的那个现场） ----------
  console.log("\n[1] 现场识别：claude 的链接指向 agents 那份");
  const agentsDrawio = writeSkill(path.join(AGENTS, "drawio"), "drawio", "来自 agents 的那份内容");
  makeLink(agentsDrawio, path.join(CLAUDE, "drawio"));
  {
    const plan = syncer.planSync(cfg);
    ok(diffLinkIds(plan).includes("diff-link:drawio@claude"), "planSync 把「链接指向别处」报成 diff-link");
    const st = syncer.linkConflictState(itemOf("drawio", "claude", CLAUDE));
    ok(st.isLink === true && st.resolves === true, "现场：是链接且目标还在");
    ok(st.hasSkillMd === true, "现场：链接指向的位置有 SKILL.md");
    ok(st.centralExists === false, "现场：中央还没有这份真身");
    ok(st.targetInsideHub === false && st.sameAsCentral === false, "现场：指向的不是中央仓库内部");
  }

  // ---------- [2] 中央没有真身：relink 如实拒绝 ----------
  console.log("\n[2] 中央还没有真身时 relink 必须拒绝");
  {
    const r = syncer.resolveDiffLinkConflict(itemOf("drawio", "claude", CLAUDE), "relink", cfg);
    ok(r.ok === false && r.message.includes("中央还没有"), "relink 拒绝并说明原因（不能静默成功）");
    ok(mounter.isLink(path.join(CLAUDE, "drawio")), "拒绝后链接原地不动");
  }

  // ---------- [3] adopt：内容进中央 + 重链 + 记账 + 原目录留着 + 闭环 ----------
  console.log("\n[3] adopt：把链接那份收进中央再重链");
  {
    const r = syncer.resolveDiffLinkConflict(itemOf("drawio", "claude", CLAUDE), "adopt", cfg);
    ok(r.ok === true, `adopt 成功（${r.message}）`);
    const central = path.join(HUB, "skills", "drawio");
    ok(fs.existsSync(path.join(central, "SKILL.md")), "中央出现了这份真身");
    ok(readSkill(central) === readSkill(agentsDrawio), "中央内容 = 链接原本指向的那份");
    ok(fs.existsSync(path.join(agentsDrawio, "SKILL.md")), "只复制不移动：链接指向的那份原地保留");
    ok(mounter.pointsTo(path.join(CLAUDE, "drawio"), central), "工具目录里的链接已重建为指向中央");
    ok(mounter.isLink(path.join(CLAUDE, "drawio")) && fs.existsSync(path.join(CLAUDE, "drawio")), "新链接可解析（不是悬空）");
    const mt = mountRow("drawio", "claude");
    ok(!!mt && mt.path === path.join(CLAUDE, "drawio") && mt.enabled !== false, "台账记下了这次挂载（下一轮不再复发的前提）");
    ok(trashHoldsLink(agentsDrawio), "被替换掉的原链接进了回收站（可还原）");
    const verify = mounter.verifyAll(hub.loadManifest()).find((x) => x.skill === "drawio" && x.tool === "claude");
    ok(!!verify && verify.valid === true, "verifyAll 判定该挂载有效");
    const again = syncer.planSync(cfg);
    ok(!diffLinkIds(again).includes("diff-link:drawio@claude"), "重扫不再报同一条 diff-link（闭环）");
    ok(syncer.loadConflicts().items.every((x) => x.id !== "diff-link:drawio@claude" || x.resolved), "冲突队列里这条已结清");
  }

  // ---------- [4] adopt 覆盖已有中央版：旧版进回收站，不静默覆盖 ----------
  console.log("\n[4] adopt 覆盖中央旧版：旧版进回收站");
  {
    const zcodeGamma = writeSkill(path.join(ZCODE, "gamma"), "gamma", "中央旧内容");
    hub.importSkill({
      name: "gamma", dir: zcodeGamma, skillName: "gamma", description: "", version: "", treeHash: "", health: [],
      sources: [{ tool: "zcode", name: "gamma", dir: zcodeGamma }],
    });
    fs.rmSync(zcodeGamma, { recursive: true, force: true }); // 只留中央那份旧版做对照
    const centralGamma = path.join(HUB, "skills", "gamma");
    const agentsGamma = writeSkill(path.join(AGENTS, "gamma"), "gamma", "链接那份新内容");
    makeLink(agentsGamma, path.join(CLAUDE, "gamma"));
    const oldCentral = readSkill(centralGamma);
    const r = syncer.resolveDiffLinkConflict(itemOf("gamma", "claude", CLAUDE), "adopt", cfg);
    ok(r.ok === true, "adopt 成功");
    ok(readSkill(centralGamma) === readSkill(agentsGamma), "中央换成链接那份内容");
    ok(trashHoldsContent(oldCentral), "旧中央版进了回收站（覆盖不静默）");
    const again = syncer.planSync(cfg);
    ok(again.conflicts.length === 0, "两侧内容一致后整页无残留冲突（收敛）");
  }

  // ---------- [5] 悬空链接：adopt 拒绝，relink（中央在）成功 ----------
  console.log("\n[5] 悬空链接：指向的目标已不存在");
  {
    const zcodeGhost = writeSkill(path.join(ZCODE, "ghost"), "ghost", "真身内容");
    hub.importSkill({
      name: "ghost", dir: zcodeGhost, skillName: "ghost", description: "", version: "", treeHash: "", health: [],
      sources: [{ tool: "zcode", name: "ghost", dir: zcodeGhost }],
    });
    const gone = writeSkill(path.join(TMP, "gone", "ghost"), "ghost", "悬空前指向的内容");
    // 先建好再删目标：Windows 上 junction 指不了不存在的位置
    makeLink(gone, path.join(CLAUDE, "ghost"));
    fs.rmSync(gone, { recursive: true, force: true });
    const st = syncer.linkConflictState(itemOf("ghost", "claude", CLAUDE));
    ok(st.isLink === true && st.resolves === false, "现场：链接在、目标没了");
    const bad = syncer.resolveDiffLinkConflict(itemOf("ghost", "claude", CLAUDE), "adopt", cfg);
    ok(bad.ok === false && bad.message.includes("悬空"), "adopt 拒绝并说明「悬空」");
    const r = syncer.resolveDiffLinkConflict(itemOf("ghost", "claude", CLAUDE), "relink", cfg);
    ok(r.ok === true, "中央有真身时 relink 成功");
    ok(mounter.pointsTo(path.join(CLAUDE, "ghost"), path.join(HUB, "skills", "ghost")), "悬空链接被换成指向中央的链接");
    ok(!!mountRow("ghost", "claude"), "重链后记进台账");
  }

  // ---------- [6] 链接指向中央仓库内部：adopt 拒绝，relink 成功 ----------
  console.log("\n[6] 链接指向中央仓库内部的另一份真身");
  {
    const zcodeAlpha = writeSkill(path.join(ZCODE, "alpha"), "alpha", "alpha 内容");
    const zcodeBeta = writeSkill(path.join(ZCODE, "beta"), "beta", "beta 内容");
    for (const [name, dir] of [["alpha", zcodeAlpha], ["beta", zcodeBeta]]) {
      hub.importSkill({ name, dir, skillName: name, description: "", version: "", treeHash: "", health: [], sources: [{ tool: "zcode", name, dir }] });
    }
    makeLink(path.join(HUB, "skills", "alpha"), path.join(CODEX, "beta"));
    const st = syncer.linkConflictState(itemOf("beta", "codex", CODEX));
    ok(st.targetInsideHub === true && st.sameAsCentral === false, "现场：指向中央内部，但不是它自己那份");
    const bad = syncer.resolveDiffLinkConflict(itemOf("beta", "codex", CODEX), "adopt", cfg);
    ok(bad.ok === false && bad.message.includes("中央仓库内部"), "adopt 拒绝（不许拿另一份真身覆盖它）");
    const r = syncer.resolveDiffLinkConflict(itemOf("beta", "codex", CODEX), "relink", cfg);
    ok(r.ok === true, "relink 成功");
    ok(mounter.pointsTo(path.join(CODEX, "beta"), path.join(HUB, "skills", "beta")), "链接改指向自己那份真身");
  }

  // ---------- [7] 位置是真实目录：两个动词都如实报错 ----------
  console.log("\n[7] 位置已被换成真实目录（不是链接）");
  {
    writeSkill(path.join(CLAUDE, "real"), "real", "真实目录内容");
    for (const choice of ["relink", "adopt"]) {
      const r = syncer.resolveDiffLinkConflict(itemOf("real", "claude", CLAUDE), choice, cfg);
      ok(r.ok === false && r.message.includes("已不是链接"), `${choice} 如实报错，不猜`);
    }
    ok(fs.existsSync(path.join(CLAUDE, "real", "SKILL.md")), "真实目录原封不动");
  }

  // ---------- [8] 未知动词 ----------
  console.log("\n[8] 未知裁决动词");
  {
    const r = syncer.resolveDiffLinkConflict(itemOf("drawio", "claude", CLAUDE), "keepBoth", cfg);
    ok(r.ok === false && r.message.includes("未知裁决选项"), "未知动词如实拒绝");
  }

  // ---------- [9] 同一毫秒归档两次不撞名 ----------
  console.log("\n[9] 一次裁决里背靠背归档两次（旧中央版 + 原链接）");
  {
    const a = path.join(TMP, "dup-a");
    const b = path.join(TMP, "dup-b");
    writeSkill(a, "dup", "第一份");
    writeSkill(b, "dup", "第二份");
    const destA = hub.toTrash(a, "dup");
    const destB = hub.toTrash(b, "dup"); // 同一毫秒时旧实现会撞上 destA：rename 到已存在的目录直接崩
    ok(destA !== destB && fs.existsSync(destA) && fs.existsSync(destB), "两份都归档成功且路径不同");
    ok(readSkill(destA) !== readSkill(destB), "两份内容各自独立，没有互相覆盖");
  }

  // ---------- [10] 收纳复制失败必须自己接住 ----------
  // 复制失败（权限 / 磁盘满 / 路径过长）时旧中央版已经进了回收站，让异常裸奔上去的话
  // 用户只看到一条未捕获的错误，不知道内容还能从回收站还原。这条是接线守卫：
  // 真实触发需要权限/磁盘故障，用源码锚点钉住「cpSync 被 try 包住且提示回收站」，
  // 与仓内既有的接线守卫（如 atomic-tmp-pid 的语句锚点）同一先例
  console.log("\n[10] adopt 的复制失败必须自己接住（旧中央版已进回收站）");
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "syncer.cjs"), "utf8");
    ok(/try \{\s*\n\s*fs\.cpSync\(st\.resolved, central/.test(src), "adopt 的 fs.cpSync 被 try 包住");
    ok(/原中央版已移入回收站/.test(src), "复制失败时如实说明旧版可从回收站还原");
    ok(/中央此前没有这份内容，未受影响/.test(src), "中央此前无内容时也给出明确说法");
  }

  console.log(`\n${failed === 0 ? "OK" : "FAIL"} 技能仓库 diff-link 裁决自测：${pass} 项通过，${failed} 项失败`);
}

console.log(`沙箱目录：${TMP}（成功即清理；失败留着看现场）`);
main();
if (failed === 0) fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
