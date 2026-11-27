import { z } from "zod";

import type { VdpRpcTransport, VdpScenarioContext } from "../dsl.ts";

const CreatedIssueSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
});

const CreatedChannelSchema = z.string().min(1);

const RepoSummarySchema = z.object({
  name: z.string().min(1),
});

const AgentSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  role: z.string(),
});

const AgentTemplateSchema = z.object({
  id: z.string().min(1),
  role: z.string(),
  name: z.string(),
  installed: z.array(z.string()),
});

const ChatMessageSummarySchema = z.object({
  id: z.string().min(1),
  text: z.string(),
});

const CreatedCronSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
});

const DAY_MS = 86_400_000;

function dayOffsetMs(baseMs: number, offsetDays: number): number {
  const d = new Date(baseMs + offsetDays * DAY_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface WorkspaceCoreIds {
  readonly issueIds: readonly string[];
  readonly channelId: string;
  readonly channelIds: readonly string[];
  readonly repoNames: readonly string[];
  readonly agentIds: readonly string[];
  readonly cronIds: readonly string[];
}

const seededByTransport = new WeakMap<VdpRpcTransport, Promise<WorkspaceCoreIds>>();

async function performSeedWorkspaceCore(v: VdpScenarioContext): Promise<WorkspaceCoreIds> {
  const nowMs = Date.now();

  // 1. Seed local sandbox repos so /repos, Dashboard health, and Issues repo filters look realistic offline.
  const repoUi = await v.rpc("repo.create", { name: "papertrails-ui" }, RepoSummarySchema);
  const repoEngine = await v.rpc("repo.create", { name: "farm-engine" }, RepoSummarySchema);
  const repoNames = [repoUi.name, repoEngine.name];

  // 2. Ensure at least a couple helper agent profiles exist for Roster & assignee badges.
  const existingAgents = await v.rpc("agent.list", undefined, z.array(AgentSummarySchema));
  const agentIds = existingAgents.map((a) => a.id);
  const templates = await v.rpc("agent.template.list", undefined, z.array(AgentTemplateSchema));
  let installedExtra = 0;
  for (const tpl of templates) {
    if (installedExtra >= 2) break;
    if (tpl.role === "helper" && tpl.installed.length === 0) {
      const installed = await v.rpc("agent.template.install", { id: tpl.id }, AgentSummarySchema);
      agentIds.push(installed.id);
      installedExtra += 1;
    }
  }
  const helperAgentId = existingAgents.find((a) => a.role === "helper")?.id ?? agentIds.find((id) => id !== "orchestrator");

  // 3. Seed realistic bilingual issues with parent/child hierarchy, blockers, relations, and schedule dates.
  const issue1 = await v.rpc(
    "issue.create",
    {
      title: "打磨 3+1 Note 编辑排版与对比度层级 (Editorial Typography Pass)",
      priority: "high",
      repo: repoUi.name,
      ...(helperAgentId ? { agent: helperAgentId } : {}),
      owner: { kind: "user", id: "user" },
      tags: ["UX", "Note", "Editorial"],
      startAt: dayOffsetMs(nowMs, -3),
      dueAt: dayOffsetMs(nowMs, 4),
      description:
        "## 优化范围\n去掉文档与视图中的「盒套盒」冗余边框，统一 `Base` 列宽密度，并对齐 Light / Dark 主题文本对比度。\n\n- 收敛块级常驻外框，改为悬停/激活按需浮现\n- 对齐行打开抽屉与大纲跳转位置",
      criteria: [
        "Block Doc 正文保持冷静克制的杂志阅读感，无冗余常驻框线",
        "Base Table / Board / Gallery / Timeline 视图切换保持数据一致",
        "Canvas 白板在深浅色主题下节点对比度清晰可读",
        "关联工单与双链面板点击跳转准确",
      ],
    },
    CreatedIssueSchema,
  );

  const issue2 = await v.rpc(
    "issue.create",
    {
      title: "Base 多维视图列宽对齐与 Timeline 甘特条拖拽体验",
      priority: "high",
      repo: repoUi.name,
      parent: issue1.id,
      tags: ["Note", "Base", "Timeline"],
      startAt: dayOffsetMs(nowMs, -2),
      dueAt: dayOffsetMs(nowMs, 2),
      description: "## 目标\n统一表头操作、筛选栏尺寸与跨视图选中态，确保 Timeline 条形跨天宽度与周/月切换精确对齐。",
      criteria: ["Table 汇总条数值精确到两位小数", "Timeline 视图周/月缩放无横向文字截断"],
    },
    CreatedIssueSchema,
  );

  const issue3 = await v.rpc(
    "issue.create",
    {
      title: "Canvas 白板深色模式表面适配与缩放网格调优",
      priority: "medium",
      repo: repoUi.name,
      parent: issue1.id,
      blockedBy: [issue2.id],
      tags: ["Note", "Canvas", "DarkMode"],
      startAt: dayOffsetMs(nowMs, 1),
      dueAt: dayOffsetMs(nowMs, 5),
      description: "## 要点\n深色模式下降低网格线干扰，强化便签与容器标题可读性。",
      criteria: ["Dark 模式下容器与便签对比度 >= 4.5:1"],
    },
    CreatedIssueSchema,
  );

  const issue4 = await v.rpc(
    "issue.create",
    {
      title: "修复看板窄屏溢出、多余多选框与跨列拖拽 Ghost 漂移",
      priority: "urgent",
      repo: repoUi.name,
      owner: { kind: "user", id: "user" },
      tags: ["Board", "Layout", "P0"],
      startAt: dayOffsetMs(nowMs, -5),
      dueAt: dayOffsetMs(nowMs, -1),
      description: "## 问题描述\n移除低价值的看板卡片多选复选框；跨列拖拽时应保持 Ghost 尺寸一致并按目标插入位置预览挤压。",
      criteria: ["720px 窄视口下泳道横向滚动与卡片标题不发生垂直裁剪", "跨列拖拽 Ghost 与实际落位保持一致"],
    },
    CreatedIssueSchema,
  );

  const issue5 = await v.rpc(
    "issue.create",
    {
      title: "消除外观设置页打开时枚举系统字体导致的同步卡顿",
      priority: "urgent",
      repo: repoEngine.name,
      ...(helperAgentId ? { agent: helperAgentId } : {}),
      tags: ["Performance", "Settings"],
      startAt: dayOffsetMs(nowMs, 0),
      dueAt: dayOffsetMs(nowMs, 2),
      description: "## 根因定位\n`host_bridge` 同步扫描字体列表叠加上百个菜单项即时加载字体字形，导致进入 `/settings/appearance` 出现明显掉帧。",
      criteria: ["打开外观设置页首帧耗时 < 32ms，无感知卡顿"],
    },
    CreatedIssueSchema,
  );

  const issue6 = await v.rpc(
    "issue.create",
    {
      title: "Support deterministic TS VDP scenario runner over single WebSocket",
      priority: "medium",
      repo: repoEngine.name,
      tags: ["VDP", "Testing"],
      startAt: dayOffsetMs(nowMs, 2),
      dueAt: dayOffsetMs(nowMs, 7),
      description: "## Goal\nReplace multi-minute ad-hoc scripts with repeatable `vp run vdp` scenarios seeded with realistic product state.",
      criteria: ["Single persistent WS execution captures Light & Dark PNGs + manifest.json cleanly"],
    },
    CreatedIssueSchema,
  );

  const issue7 = await v.rpc(
    "issue.create",
    {
      title: "重构全站 30+ 空状态分层视觉规范（Empty State Tiers）",
      priority: "medium",
      repo: repoUi.name,
      relations: [{ kind: "related", issue: issue1.id }],
      tags: ["Design System", "Empty State"],
      startAt: dayOffsetMs(nowMs, 3),
      dueAt: dayOffsetMs(nowMs, 9),
      description: "## 分层方案\n区分首屏引导型空状态、过滤无结果型与局部面板占位型，避免千篇一律居中图标+单行灰字。",
      criteria: ["核心空状态附带清晰的下一步主动作或清除筛选按钮"],
    },
    CreatedIssueSchema,
  );

  const issue8 = await v.rpc(
    "issue.create",
    {
      title: "下线重构前遗留的旧 Artifact 徽章与冗余状态字段",
      priority: "low",
      repo: repoEngine.name,
      tags: ["Cleanup"],
      startAt: dayOffsetMs(nowMs, -6),
      dueAt: dayOffsetMs(nowMs, -2),
      description: "Done as part of Papertrails 3+1 Note restraint pass.",
      criteria: ["Only canonical priority and note counters remain on board cards"],
    },
    CreatedIssueSchema,
  );

  const issue9 = await v.rpc(
    "issue.create",
    {
      title: "落地核心页面微动效原则（弹层阻尼、状态过渡与减动效适配）",
      priority: "high",
      repo: repoUi.name,
      blockedBy: [issue4.id],
      tags: ["Motion", "Polish"],
      startAt: dayOffsetMs(nowMs, 4),
      dueAt: dayOffsetMs(nowMs, 11),
      description: "## 动效清单\n统一抽屉/弹窗进出曲线、列表增删衔接以及 `prefers-reduced-motion` 全局降级。",
      criteria: ["核心面板过渡时间统一在 160–240ms 区间"],
    },
    CreatedIssueSchema,
  );

  // Move one closed issue to `canceled` safely (never triggers live LLM dispatch in offline sandbox).
  await v.rpc("issue.status.update", { id: issue8.id, status: "canceled", reason: "dismissed" });

  // 4. Seed rich channels with multi-turn messages, issue links, pins, and reactions.
  const releaseChannelId = await v.rpc(
    "channel.create",
    {
      name: "release-ops",
      repo: repoUi.name,
      description: "发版就绪检查、VDP 视觉验收与专业产品体验走查",
    },
    CreatedChannelSchema,
  );

  const designChannelId = await v.rpc(
    "channel.create",
    {
      name: "design-review",
      repo: repoUi.name,
      description: "Papertrails 设计系统、3+1 笔记排版与空状态走查",
    },
    CreatedChannelSchema,
  );

  const infraChannelId = await v.rpc(
    "channel.create",
    {
      name: "farm-infra",
      repo: repoEngine.name,
      description: "Rust 服务端性能、Loro 协同与定时巡检状态同步",
    },
    CreatedChannelSchema,
  );

  await v.rpc("channel.message.send", {
    id: releaseChannelId,
    text: `**v0.9 UI 走查窗口已开启** — 本轮聚焦 #${issue1.number} 排版克制感与 #${issue4.number} 看板响应体验，欢迎在对应频道补充截图定位。`,
  });
  await v.rpc("channel.message.send", {
    id: releaseChannelId,
    text: "TS VDP 场景回归已完成重构（`vp run vdp all --ui-only`），当前覆盖：\n- Issues 四视图（Board / List / Timeline / Calendar）+ 720px 窄屏\n- Note 3+1 原语（Doc / Base 4 视图 / Canvas / Media / Presenter）\n- Settings 全分栏与 Dashboard / Repos / Runs / Agents",
  });
  await v.rpc("channel.message.send", {
    id: releaseChannelId,
    text: `注意检查 \`/settings/appearance\` 字体选择器加载与 #${issue5.number} 的首帧卡顿反馈；如发现深色模式对比度不足或控件截断请直接标红框说明。`,
  });
  await v.rpc("channel.message.send", {
    id: releaseChannelId,
    text: "```sh\nvp run vdp all --ui-only --out /tmp/vv-vdp-review\n```\n单条 WebSocket 全量截图 + 控制台零报错校验已通过。",
  });

  // Pin first announcement and add reactions on key updates.
  const releaseMsgs = await v.rpc("channel.message.list", { id: releaseChannelId, limit: 10 }, z.array(ChatMessageSummarySchema));
  const oldestMsg = releaseMsgs.at(-1);
  const newestMsg = releaseMsgs[0];
  if (oldestMsg) {
    await v.rpc("channel.pin.set", { id: oldestMsg.id, on: true });
    await v.rpc("channel.reaction.set", { id: oldestMsg.id, emoji: "📌", on: true });
  }
  if (newestMsg) {
    await v.rpc("channel.reaction.set", { id: newestMsg.id, emoji: "🚀", on: true });
  }

  await v.rpc("channel.message.send", {
    id: designChannelId,
    text: "Papertrails 本周评审结论：信息密度较高的卡片与 Base 表格尽量少用全包裹描边，改用背景层差与字重分级。",
  });
  await v.rpc("channel.message.send", {
    id: designChannelId,
    text: `已同步至 #${issue7.number}，接下来补齐空状态插画层级与主动作引导。`,
  });

  await v.rpc("channel.message.send", {
    id: infraChannelId,
    text: "SQLite / PostgreSQL 双后端切片投影已就绪，`StateFeed` 6 路状态同步耗时稳定在 2ms 内。",
  });

  // 5. Seed cron schedules (one paused, one active daily digest) for ops views.
  const cronDigest = await v.rpc(
    "cron.create",
    {
      name: "晨间工单与阻塞巡检简报",
      text: "汇总昨日关闭项、超期高优工单与当前待确认问题，发布至 #release-ops。",
      channel: releaseChannelId,
      repo: repoUi.name,
      when: { kind: "daily", time: "09:30" },
      tz: "Asia/Shanghai",
    },
    CreatedCronSchema,
  );
  const cronVdp = await v.rpc(
    "cron.create",
    {
      name: "每周一 UI-only VDP 视觉回归采样",
      text: "自动触发界面多主题截图走查并生成巡检简报。",
      channel: designChannelId,
      repo: repoUi.name,
      when: { kind: "weekly", days: [1], time: "10:00" },
      tz: "Asia/Shanghai",
    },
    CreatedCronSchema,
  );
  await v.rpc("cron.update", { id: cronVdp.id, enabled: false });

  return {
    issueIds: [issue1.id, issue2.id, issue3.id, issue4.id, issue5.id, issue6.id, issue7.id, issue8.id, issue9.id],
    channelId: releaseChannelId,
    channelIds: [releaseChannelId, designChannelId, infraChannelId],
    repoNames,
    agentIds,
    cronIds: [cronDigest.id, cronVdp.id],
  };
}

/** Seeds shared repos, agents, issues, channels, and crons once per WebSocket transport so multi-scenario suites share one dataset. */
export function seedWorkspaceCore(v: VdpScenarioContext): Promise<WorkspaceCoreIds> {
  const existing = seededByTransport.get(v.transport);
  if (existing !== undefined) return existing;
  const pending = performSeedWorkspaceCore(v).catch((err) => {
    seededByTransport.delete(v.transport);
    throw err;
  });
  seededByTransport.set(v.transport, pending);
  return pending;
}
