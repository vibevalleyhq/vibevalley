import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  path: z.string().optional(),
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

interface RepoCommitSeed {
  readonly author: string;
  readonly email: string;
  readonly message: string;
  readonly files: Readonly<Record<string, string>>;
}

function seedRepoGitCommits(repoPath: string | undefined, commits: readonly RepoCommitSeed[]): void {
  if (!repoPath || !existsSync(repoPath)) return;
  const git = (args: readonly string[]) =>
    execFileSync("git", ["-C", repoPath, ...args], {
      stdio: "ignore",
    });

  if (!existsSync(join(repoPath, ".git"))) {
    git(["init", "-q"]);
  }

  for (const commit of commits) {
    for (const [relPath, content] of Object.entries(commit.files)) {
      const absPath = join(repoPath, relPath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, content, "utf8");
    }
    git(["add", "-A"]);
    git(["-c", `user.name=${commit.author}`, "-c", `user.email=${commit.email}`, "commit", "-q", "--allow-empty", "-m", commit.message]);
  }
}

export interface WorkspaceCoreIds {
  readonly issueIds: readonly string[];
  readonly channelId: string;
  readonly hrChannelId: string;
  readonly adminChannelId: string;
  readonly channelIds: readonly string[];
  readonly repoNames: readonly string[];
  readonly agentIds: readonly string[];
  readonly cronIds: readonly string[];
}

const seededByTransport = new WeakMap<VdpRpcTransport, Promise<WorkspaceCoreIds>>();

async function performSeedWorkspaceCore(v: VdpScenarioContext): Promise<WorkspaceCoreIds> {
  const nowMs = Date.now();

  const repoGateway = await v.rpc("repo.create", { name: "core-gateway" }, RepoSummarySchema);
  const repoConsole = await v.rpc("repo.create", { name: "console-web" }, RepoSummarySchema);
  const repoHandbook = await v.rpc("repo.create", { name: "people-handbook" }, RepoSummarySchema);
  const repoInfra = await v.rpc("repo.create", { name: "infra-deploy" }, RepoSummarySchema);
  const repoNames = [repoGateway.name, repoConsole.name, repoHandbook.name, repoInfra.name];

  seedRepoGitCommits(repoGateway.path, [
    {
      author: "Shen Kuo",
      email: "shenkuo@company.local",
      message: "Initialize gateway workspace crate",
      files: {
        "Cargo.toml": '[package]\nname = "core-gateway"\nversion = "0.9.4"\nedition = "2024"\n',
        "README.md": "# core-gateway\n\nMulti-tenant API gateway supporting OAuth2 PKCE rotation and PostgreSQL pooling.\n",
      },
    },
    {
      author: "Shen Kuo",
      email: "shenkuo@company.local",
      message: "Add OAuth2 PKCE refresh lock and sliding window rate limiter",
      files: {
        "src/oauth2.rs":
          "pub struct RefreshLock { pub tenant_id: String }\nimpl RefreshLock {\n    pub fn acquire(tenant_id: &str) -> Self { Self { tenant_id: tenant_id.to_owned() } }\n}\n",
        "src/rate_limit.rs": "pub fn allow_request(quota_per_min: u32, current: u32) -> bool {\n    current < quota_per_min\n}\n",
      },
    },
    {
      author: "Zhou Mi",
      email: "zhoumi@company.local",
      message: "Add audit_log monthly partition migration",
      files: {
        "migrations/001_audit_log.sql":
          "CREATE TABLE IF NOT EXISTS audit_log (\n  id BIGINT PRIMARY KEY,\n  tenant_id TEXT NOT NULL,\n  action TEXT NOT NULL,\n  created_at BIGINT NOT NULL\n);\n",
      },
    },
  ]);

  seedRepoGitCommits(repoConsole.path, [
    {
      author: "Lin Hui",
      email: "linhui@company.local",
      message: "Scaffold enterprise approval console views",
      files: {
        "package.json": '{\n  "name": "console-web",\n  "private": true,\n  "version": "1.8.0"\n}\n',
        "src/LeaveApproval.tsx": "export function formatLeaveDays(hours: number): string { return `${(hours / 8).toFixed(1)} 天`; }\n",
      },
    },
    {
      author: "Lin Hui",
      email: "linhui@company.local",
      message: "Add monthly expense export and 429 retry banner",
      files: {
        "src/BillingTable.tsx": "export const EXPORT_BOM = '\\uFEFF';\nexport function exportHeading(): string { return '部门,差旅费,餐补,合计'; }\n",
      },
    },
  ]);

  seedRepoGitCommits(repoHandbook.path, [
    {
      author: "Su Qing",
      email: "suqing@company.local",
      message: "Update Q4 onboarding week-1 checklist and hiring rubric",
      files: {
        "onboarding/week1-checklist.md": "# 首周入职清单\n\n- 领取 MacBook Pro 与工牌门禁\n- 开通企业邮箱、Git 仓库与 VPN 证书\n- 完成一对一导师迎新面谈\n",
        "recruiting/rubric-2026q4.md": "# 2026 秋招面试评分标准\n\n1. 系统设计、并发排查与代码可读性\n2. 跨团队沟通与问题推进能力\n",
      },
    },
    {
      author: "Gu Yan",
      email: "guyan@company.local",
      message: "Publish November travel reimbursement & equipment rules",
      files: {
        "admin/reimbursement-policy.yaml": "hotel_cap_cny: 650\nmeal_daily_cny: 120\nmonthly_cutoff_day: 25\n",
      },
    },
  ]);

  seedRepoGitCommits(repoInfra.path, [
    {
      author: "Zhou Mi",
      email: "zhoumi@company.local",
      message: "Configure macOS notarization and K8s rollout manifests",
      files: {
        "scripts/notarize-dmg.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho 'Submitting archive to notarytool...'\n",
        "k8s/gateway-rollout.yaml": "apiVersion: argoproj.io/v1alpha1\nkind: Rollout\nmetadata:\n  name: core-gateway\n",
      },
    },
  ]);

  const existingAgents = await v.rpc("agent.list", undefined, z.array(AgentSummarySchema));
  const agentIds = existingAgents.map((a) => a.id);
  const templates = await v.rpc("agent.template.list", undefined, z.array(AgentTemplateSchema));
  let installedExtra = 0;
  for (const tpl of templates) {
    if (installedExtra >= 3) break;
    if (tpl.role === "helper" && tpl.installed.length === 0) {
      const installed = await v.rpc("agent.template.install", { id: tpl.id }, AgentSummarySchema);
      agentIds.push(installed.id);
      installedExtra += 1;
    }
  }
  const helperAgentId = existingAgents.find((a) => a.role === "helper")?.id ?? agentIds.find((id) => id !== "orchestrator" && !id.startsWith("ext-"));

  const teammates = [
    {
      id: "ext-arch",
      name: "沈括 · 后端架构",
      avatar: "avatar-architect",
      duty: "负责网关高并发连接池、OAuth2 鉴权与数据库迁移评审",
      tags: ["Rust", "Gateway", "Postgres"],
    },
    {
      id: "ext-fe",
      name: "林徽 · 前端研发",
      avatar: "avatar-frontend",
      duty: "负责控制台审批流界面、表单状态校验与可访问性优化",
      tags: ["TSX", "Console", "UI"],
    },
    {
      id: "ext-qa",
      name: "周密 · 质量与发版",
      avatar: "avatar-tester",
      duty: "负责性能压测、macOS 公证流水线与线上值班巡检",
      tags: ["QA", "CI/CD", "Release"],
    },
    {
      id: "ext-hr",
      name: "苏晴 · 招聘与入职",
      avatar: "avatar-product",
      duty: "负责校招社招面试排期、Offer 定级审批与新员工入职培训",
      tags: ["HR", "Recruiting", "Onboarding"],
    },
    {
      id: "ext-ops",
      name: "顾言 · 行政与薪酬",
      avatar: "avatar-docs",
      duty: "负责月度考勤核算、差旅报销单据初审、办公设备采购与工位调配",
      tags: ["Ops", "Admin", "Finance"],
    },
  ] as const;

  for (const mate of teammates) {
    const saved = await v.rpc("agent.register", { ...mate }, AgentSummarySchema);
    if (!agentIds.includes(saved.id)) agentIds.push(saved.id);
  }

  const issue1 = await v.rpc(
    "issue.create",
    {
      title: "网关 OAuth2 PKCE 令牌轮换与多租户限流改造",
      priority: "high",
      repo: repoGateway.name,
      ...(helperAgentId ? { agent: helperAgentId } : {}),
      owner: { kind: "agent", id: "ext-arch" },
      tags: ["Backend", "Gateway", "Security"],
      startAt: dayOffsetMs(nowMs, -4),
      dueAt: dayOffsetMs(nowMs, 4),
      description:
        "## 改造目标\n统一多租户 `Refresh Token` 并发刷新锁，补齐网关 Redis 滑动窗口限流与连接池慢查询导出。\n\n- 消除并发刷新引发的双重失效\n- 429 响应携带标准化 `Retry-After` 与 TraceId",
      criteria: [
        "10 并发刷新同一 Refresh Token 仅触发 1 次上游签发",
        "Redis 不可用时自动降级为本地令牌桶且 P99 < 12ms",
        "控制台正常渲染会话续期与 429 提示弹窗",
      ],
    },
    CreatedIssueSchema,
  );

  const issue2 = await v.rpc(
    "issue.create",
    {
      title: "实现 Refresh Token 并发防重放锁与 Redis 降级限流",
      priority: "urgent",
      repo: repoGateway.name,
      parent: issue1.id,
      owner: { kind: "agent", id: "ext-arch" },
      tags: ["Rust", "OAuth2", "P0"],
      startAt: dayOffsetMs(nowMs, -3),
      dueAt: dayOffsetMs(nowMs, 1),
      description: "## 实现要点\n通过 `KeyLock` 串行化同租户刷新请求，并在下游鉴权超时时返回可恢复降级状态。",
      criteria: ["并发压测无竞态重放告警", "单测覆盖 Redis 断连降级分支"],
    },
    CreatedIssueSchema,
  );

  const issue3 = await v.rpc(
    "issue.create",
    {
      title: "补齐 PostgreSQL 连接池空闲回收与慢查询指标导出",
      priority: "high",
      repo: repoGateway.name,
      parent: issue1.id,
      owner: { kind: "agent", id: "ext-arch" },
      tags: ["Postgres", "Metrics"],
      startAt: dayOffsetMs(nowMs, -6),
      dueAt: dayOffsetMs(nowMs, -2),
      description: "## 验收范围\n增加 `pg_pool_idle_reaped_total` 指标并将空闲超时回收延迟压到 2ms 内。",
      criteria: ["Prometheus /metrics 暴露连接池饱和度与等待时长"],
    },
    CreatedIssueSchema,
  );

  const issue4 = await v.rpc(
    "issue.create",
    {
      title: "排查晚高峰 Webhook 投递队列偶发积压与死信重放死锁",
      priority: "urgent",
      repo: repoGateway.name,
      owner: { kind: "agent", id: "ext-arch" },
      tags: ["Outbox", "Latency", "P0"],
      startAt: dayOffsetMs(nowMs, -5),
      dueAt: dayOffsetMs(nowMs, -1),
      description: "## 现场现象\n晚 8 点批处理回调峰值时，死信重放任务与常规 outbox 工人竞争同一行锁导致延时抖动。",
      criteria: ["批量重放改为分片游标拉取，单批锁定行 <= 50"],
    },
    CreatedIssueSchema,
  );

  const issue5 = await v.rpc(
    "issue.create",
    {
      title: "打通 macOS 客户端 Developer ID 自动签名与公证流水线",
      priority: "high",
      repo: repoInfra.name,
      ...(helperAgentId ? { agent: helperAgentId } : {}),
      owner: { kind: "agent", id: "ext-qa" },
      tags: ["Release", "macOS", "CI/CD"],
      startAt: dayOffsetMs(nowMs, -1),
      dueAt: dayOffsetMs(nowMs, 3),
      description: "## 流水线改造\n在 `release.yml` 中接入 `notarytool` 凭据校验、自动装订 Ticket 与 DMG SHA256 清单归档。",
      criteria: ["Alpha / Beta tag 自动产出已公证 dmg 与 zip"],
    },
    CreatedIssueSchema,
  );

  const issue6 = await v.rpc(
    "issue.create",
    {
      title: "审计日志表按月分区归档并压缩 90 天前冷数据至对象存储",
      priority: "medium",
      repo: repoGateway.name,
      tags: ["Postgres", "Archive"],
      startAt: dayOffsetMs(nowMs, 2),
      dueAt: dayOffsetMs(nowMs, 7),
      description: "## 目标\n自动按自然月预建 `audit_log_YYYY_MM` 分区，并将超 90 天只读分区导出为 Parquet 归档。",
      criteria: ["历史审计查询保留只读联邦视图透明访问"],
    },
    CreatedIssueSchema,
  );

  const issue7 = await v.rpc(
    "issue.create",
    {
      title: "导出月度考勤与加班汇总 CSV 时兼容 Excel 与 WPS UTF-8 BOM",
      priority: "medium",
      repo: repoConsole.name,
      tags: ["HR", "Console", "Export"],
      startAt: dayOffsetMs(nowMs, 3),
      dueAt: dayOffsetMs(nowMs, 9),
      description: "## 背景\n行政同学用本地 Excel 打开考勤统计表出现中文表头乱码，需要在导出流首部写入 UTF-8 BOM。",
      criteria: ["macOS Numbers / Windows Excel / WPS 直接双击无乱码"],
    },
    CreatedIssueSchema,
  );

  const issue8 = await v.rpc(
    "issue.create",
    {
      title: "维护旧版串口考勤机同步脚本（已切换企业微信考勤直连）",
      priority: "low",
      repo: repoConsole.name,
      tags: ["Admin", "Cleanup"],
      startAt: dayOffsetMs(nowMs, -7),
      dueAt: dayOffsetMs(nowMs, -3),
      description: "公司各楼层已完成云考勤打卡机替换，停止维护串口协议同步服务。",
      criteria: ["归档旧仓库脚本并下线对应定时任务"],
    },
    CreatedIssueSchema,
  );

  const issue9 = await v.rpc(
    "issue.create",
    {
      title: "制定春节前后值班补贴标准与异地返岗弹性办公细则",
      priority: "medium",
      repo: repoHandbook.name,
      tags: ["HR", "Policy", "Admin"],
      startAt: dayOffsetMs(nowMs, 4),
      dueAt: dayOffsetMs(nowMs, 11),
      description: "## 制度范围\n明确核心研发 Oncall 值班餐补/调休换算口径，以及跨省返岗前 3 天远程居家申请流程。",
      criteria: ["人事与技术负责人会签并通过全员公告发布"],
    },
    CreatedIssueSchema,
  );

  const issue10 = await v.rpc(
    "issue.create",
    {
      title: "控制台接入 429 退避重试提示与会话续期弹窗",
      priority: "medium",
      repo: repoConsole.name,
      parent: issue1.id,
      blockedBy: [issue2.id],
      owner: { kind: "agent", id: "ext-fe" },
      tags: ["Frontend", "Auth", "UX"],
      startAt: dayOffsetMs(nowMs, 1),
      dueAt: dayOffsetMs(nowMs, 5),
      description: "## 前端交互\n收到 `Retry-After` 时显示倒计时横幅，刷新成功后自动重放失败只读查询。",
      criteria: ["不丢失表单已填草稿状态"],
    },
    CreatedIssueSchema,
  );

  const issue11 = await v.rpc(
    "issue.create",
    {
      title: "2026 Q4 秋招收尾与 12 月首批新员工集中入职统筹",
      priority: "high",
      repo: repoHandbook.name,
      owner: { kind: "agent", id: "ext-hr" },
      tags: ["HR", "Recruiting", "Onboarding"],
      startAt: dayOffsetMs(nowMs, -3),
      dueAt: dayOffsetMs(nowMs, 5),
      description: "## 统筹清单\n协调技术面试官终面结论、薪酬定级审批、6 位 12 月 2 日入职同学电脑采购及导师带教安排。",
      criteria: ["所有 Offer 完成电子签回执", "入职前 2 个工作日配齐办公电脑与工牌"],
    },
    CreatedIssueSchema,
  );

  const issue12 = await v.rpc(
    "issue.create",
    {
      title: "完成后端与前端秋招终面评议汇总及薪酬定级审批",
      priority: "high",
      repo: repoHandbook.name,
      parent: issue11.id,
      owner: { kind: "agent", id: "ext-hr" },
      tags: ["HR", "Recruiting", "Offer"],
      startAt: dayOffsetMs(nowMs, -8),
      dueAt: dayOffsetMs(nowMs, -2),
      description: "## 审批情况\n汇总 14 位校招终面评语表、定级薪资包，并由部门负责人审批用印。",
      criteria: ["全部 9 份正式 Offer 签发归档"],
    },
    CreatedIssueSchema,
  );

  const issue13 = await v.rpc(
    "issue.create",
    {
      title: "核对首批 6 名新员工 MacBook Pro 序列号、门禁卡与邮箱开通",
      priority: "high",
      repo: repoHandbook.name,
      parent: issue11.id,
      owner: { kind: "agent", id: "ext-ops" },
      tags: ["IT", "Admin", "Onboarding"],
      startAt: dayOffsetMs(nowMs, -1),
      dueAt: dayOffsetMs(nowMs, 2),
      description: "## 备货与账号\n登记资产编码写入行政台账，预开通企业邮箱、GitHub 组织权限及四楼工位网络端口。",
      criteria: ["6 台 M4 Pro 设备完成资产贴标与预装基线镜像"],
    },
    CreatedIssueSchema,
  );

  const issue14 = await v.rpc(
    "issue.create",
    {
      title: "更新首周入职导师带教计划表与保密协议电子签归档",
      priority: "medium",
      repo: repoHandbook.name,
      parent: issue11.id,
      owner: { kind: "agent", id: "ext-hr" },
      tags: ["HR", "Mentor", "Compliance"],
      startAt: dayOffsetMs(nowMs, 0),
      dueAt: dayOffsetMs(nowMs, 4),
      description: "## 带教与合规\n为每位研发新人匹配跨组 Buddy，并在电子签系统归档竞业与保密协议副本。",
      criteria: ["100% 新人完成入职导师双选确认"],
    },
    CreatedIssueSchema,
  );

  const issue15 = await v.rpc(
    "issue.create",
    {
      title: "11 月研发与产品中心差旅报销单据抽检及供应商对账",
      priority: "high",
      repo: repoHandbook.name,
      owner: { kind: "agent", id: "ext-ops" },
      tags: ["Finance", "Admin", "Audit"],
      startAt: dayOffsetMs(nowMs, -2),
      dueAt: dayOffsetMs(nowMs, 1),
      description: "## 对账内容\n核验机票酒店电子发票真伪、超出城市限额特批记录及云厂商 11 月账单明细。",
      criteria: ["25 日截单前完成全部 42 笔报销单复核"],
    },
    CreatedIssueSchema,
  );

  const issue16 = await v.rpc(
    "issue.create",
    {
      title: "员工请假与调休审批流支持跨自然月自动折算年假余额",
      priority: "medium",
      repo: repoConsole.name,
      owner: { kind: "agent", id: "ext-fe" },
      tags: ["HR", "Console", "Workflow"],
      startAt: dayOffsetMs(nowMs, -1),
      dueAt: dayOffsetMs(nowMs, 3),
      description: "## 规则修正\n解决跨月请假拆分时法定年假与加班调休扣减顺序偶发颠倒的问题。",
      criteria: ["跨 11/30-12/03 连续请假按先调休后年假精确扣减"],
    },
    CreatedIssueSchema,
  );

  const issue17 = await v.rpc(
    "issue.create",
    {
      title: "修复 WebSocket 心跳断线重连后订阅偏移量重复推送",
      priority: "urgent",
      repo: repoGateway.name,
      owner: { kind: "agent", id: "ext-arch" },
      tags: ["WebSocket", "Bugfix"],
      startAt: dayOffsetMs(nowMs, -7),
      dueAt: dayOffsetMs(nowMs, -3),
      description: "## 修复内容\n重连握手携带客户端最后确认 `lastSeq`，服务端从 `lastSeq + 1` 恢复增量广播。",
      criteria: ["弱网断线重连零重复事件与零遗漏"],
    },
    CreatedIssueSchema,
  );

  const issue18 = await v.rpc(
    "issue.create",
    {
      title: "发布 2026 年度绩效互评（360 环评）时间窗口与职级答辩说明",
      priority: "medium",
      repo: repoHandbook.name,
      owner: { kind: "agent", id: "ext-hr" },
      tags: ["HR", "Performance", "Announcement"],
      startAt: dayOffsetMs(nowMs, -6),
      dueAt: dayOffsetMs(nowMs, -2),
      description: "## 周期安排\n12 月 5 日开启同事互评提名，12 月 18 日完成直属主管面谈与职级委员会晋升材料提交。",
      criteria: ["全员手册页面上线答辩模板与评分维度 FAQ"],
    },
    CreatedIssueSchema,
  );

  const issue19 = await v.rpc(
    "issue.create",
    {
      title: "四楼东侧研发工区人体工学椅与 4K 显示器增补签收",
      priority: "low",
      repo: repoHandbook.name,
      owner: { kind: "agent", id: "ext-ops" },
      tags: ["Admin", "Facilities"],
      startAt: dayOffsetMs(nowMs, -8),
      dueAt: dayOffsetMs(nowMs, -4),
      description: "## 资产入库\n完成 12 台 27 寸 4K 显示器及 8 把工学椅到货验收、贴码与工位摆放。",
      criteria: ["行政资产系统录入全部序列号"],
    },
    CreatedIssueSchema,
  );

  const issue20 = await v.rpc(
    "issue.create",
    {
      title: "演练主从数据库故障自动切换（Failover）与只读降级开关",
      priority: "low",
      repo: repoInfra.name,
      tags: ["SRE", "Postgres", "DR"],
      startAt: dayOffsetMs(nowMs, 5),
      dueAt: dayOffsetMs(nowMs, 12),
      description: "## 演练清单\n在预发环境模拟主库掉线，验证只读降级提示条渲染与 30 秒内主从切换恢复。",
      criteria: ["RTO < 30s 且零数据提交静默丢失"],
    },
    CreatedIssueSchema,
  );

  // Move non-backlog issues through valid unsent workflow states so every column & Retro metric is richly populated.
  for (const id of [issue1.id, issue4.id, issue5.id, issue10.id, issue11.id, issue14.id]) {
    await v.rpc("issue.status.update", { id, status: "in_progress" });
  }
  for (const id of [issue2.id, issue13.id, issue15.id, issue16.id]) {
    await v.rpc("issue.status.update", { id, status: "in_progress" });
    await v.rpc("issue.status.update", { id, status: "in_review" });
  }

  const doneTransitions: ReadonlyArray<{ readonly id: string; readonly receipt: Record<string, unknown> }> = [
    {
      id: issue3.id,
      receipt: {
        kind: "pull_request",
        url: "https://github.com/acme/core-gateway/pull/412",
        number: 412,
        branch: "feat/pg-idle-reaper",
        summary: "空闲连接回收耗时降至 1.8ms 并导出 Prometheus 指标",
      },
    },
    {
      id: issue12.id,
      receipt: {
        kind: "answer",
        summary: "已完成 14 名校招终面评议与定级审批，累计签发 9 份正式 Offer",
      },
    },
    {
      id: issue17.id,
      receipt: {
        kind: "pull_request",
        url: "https://github.com/acme/core-gateway/pull/408",
        number: 408,
        branch: "fix/ws-resume-seq",
        summary: "重连握手携带 lastSeq，消除增量推送重复事件",
      },
    },
    {
      id: issue18.id,
      receipt: {
        kind: "answer",
        summary: "已发布 2026 年度 360 绩效互评日程与研发/职能职级晋升材料模板",
      },
    },
    {
      id: issue19.id,
      receipt: {
        kind: "commit",
        sha: "8f3a91c",
        branch: "main",
        summary: "四楼东区 12 台 4K 显示器与 8 把人体工学椅完成资产编号入库",
      },
    },
  ];

  for (const item of doneTransitions) {
    await v.rpc("issue.status.update", { id: item.id, status: "in_progress" });
    await v.rpc("issue.status.update", {
      id: item.id,
      status: "done",
      deliveryReceipt: item.receipt,
    });
  }

  await v.rpc("issue.status.update", { id: issue8.id, status: "canceled", reason: "dismissed" });

  await v.rpc("issue.triage.suggest", {
    issueId: issue6.id,
    reason: "审计日志当前增长至每日 180 万行，建议本月排期先于春节大促上线分区归档。",
    summary: "建议提优至 high 并补充 Postgres / Archive 标签",
    patch: { priority: "high", ...(helperAgentId ? { agent: helperAgentId } : {}), tags: ["Postgres", "Archive", "Q4"] },
  });
  await v.rpc("issue.triage.suggest", {
    issueId: issue7.id,
    reason: "11 月考勤月结将于 25 日导出核算，添加 UTF-8 BOM 可直接消除财务 Excel 打开乱码。",
    summary: "建议提优至 high 在 11/25 前交付导出修补",
    patch: { priority: "high", ...(helperAgentId ? { agent: helperAgentId } : {}), tags: ["HR", "Console", "Urgent"] },
  });
  await v.rpc("issue.triage.suggest", {
    issueId: issue9.id,
    reason: "行政与研发主管需在 12 月中旬前对齐春节 Oncall 补贴及异地返岗政策。",
    summary: "建议补充 HR / Policy 标签并推进部门会签",
    patch: { ...(helperAgentId ? { agent: helperAgentId } : {}), tags: ["HR", "Policy", "Q1"] },
  });

  const backendChannelId = await v.rpc(
    "channel.create",
    {
      name: "backend-arch",
      repo: repoGateway.name,
      description: "网关 OAuth2 PKCE、PostgreSQL 连接池、Outbox 性能与上线评审",
    },
    CreatedChannelSchema,
  );

  const hrChannelId = await v.rpc(
    "channel.create",
    {
      name: "people-onboarding",
      repo: repoHandbook.name,
      description: "2026 秋招 Offer 进度、12 月新员工集中入职与导师带教协同",
    },
    CreatedChannelSchema,
  );

  const adminChannelId = await v.rpc(
    "channel.create",
    {
      name: "admin-finance",
      repo: repoHandbook.name,
      description: "月度差旅报销截单、考勤休假折算、办公设备采购与工位安排",
    },
    CreatedChannelSchema,
  );

  const releaseChannelId = await v.rpc(
    "channel.create",
    {
      name: "release-oncall",
      repo: repoInfra.name,
      description: "macOS 客户端签名公证、双周封板检查与线上值班交接",
    },
    CreatedChannelSchema,
  );

  const consoleChannelId = await v.rpc(
    "channel.create",
    {
      name: "product-console",
      repo: repoConsole.name,
      description: "企业审批台、请假调休流、CSV 导出兼容与设计走查",
    },
    CreatedChannelSchema,
  );

  await v.rpc("channel.message.send", {
    id: backendChannelId,
    text: `**网关架构双周同步** — 请重点跟进 #${issue2.number} Refresh Token 防重放锁（已进 Reviewing）和 #${issue4.number} 晚高峰 Outbox 死锁排查；#${issue3.number} PR #412 已合入主干。`,
  });
  await v.rpc("channel.message.send", {
    id: backendChannelId,
    text: "昨晚压测数据已同步至监控面板：\n- `core-gateway` 1,500 QPS 稳态 P99 耗时 **6.4 ms**（下降 3.1 ms）\n- 空闲连接回收延迟降至 **1.8 ms**\n- WebSocket 重连偏移校验 `lastSeq` 压测零丢失",
  });
  await v.rpc("channel.message.send", {
    id: backendChannelId,
    text: "```rust\nlet _guard = RefreshLock::acquire(&tenant_id);\n// Coalesce concurrent token rotation within KeyLock<TenantId>\nlet next = oauth.rotate_once(refresh_token).await?;\n```\n并发刷新冲突率已归零，请林徽同步联调控制台 #10 的 429 退避重试横幅。",
  });

  const backendMsgs = await v.rpc("channel.message.list", { id: backendChannelId, limit: 10 }, z.array(ChatMessageSummarySchema));
  const backendPin = backendMsgs.at(-1);
  const backendLatest = backendMsgs[0];
  if (backendPin) {
    await v.rpc("channel.pin.set", { id: backendPin.id, on: true });
    await v.rpc("channel.reaction.set", { id: backendPin.id, emoji: "📌", on: true });
  }
  if (backendLatest) {
    await v.rpc("channel.reaction.set", { id: backendLatest.id, emoji: "🚀", on: true });
  }

  await v.rpc("channel.message.send", {
    id: hrChannelId,
    text: `**12 月 2 日新员工集中入职进度同步**（关联 #${issue11.number}）\n- 秋招终面 14 人评审完毕，**9 份正式 Offer** 已全部用印发出（#${issue12.number} Done）\n- 首批入职 6 位新同学中已有 5 位提交档案资料与工服尺码`,
  });
  await v.rpc("channel.message.send", {
    id: hrChannelId,
    text: `请行政与 IT 同事今天 17:00 前核对 #${issue13.number}：\n1. 四楼东区 E12–E17 工位显示器与电源插排调试\n2. 6 台 M4 Pro MacBook Pro 资产码入库与开发者基础环境镜像校验\n3. 门禁权限与企业邮箱预开单回执`,
  });
  await v.rpc("channel.message.send", {
    id: hrChannelId,
    text: `后端组 沈括、前端组 林徽、架构组 周密 已确认担任首批新人一对一导师；保密协议电子签催办已在 #${issue14.number} 跟进，周四上午统一安排入职破冰分享。`,
  });

  const hrMsgs = await v.rpc("channel.message.list", { id: hrChannelId, limit: 10 }, z.array(ChatMessageSummarySchema));
  const hrPin = hrMsgs.at(-1);
  if (hrPin) {
    await v.rpc("channel.pin.set", { id: hrPin.id, on: true });
    await v.rpc("channel.reaction.set", { id: hrPin.id, emoji: "✅", on: true });
  }

  await v.rpc("channel.message.send", {
    id: adminChannelId,
    text: `**11 月差旅报销截单提醒** — 本月报销单据审核入口将于 **25 日 18:00** 关闭（#${issue15.number}）。请研发出差同事补齐电子发票 PDF 与行程单，超标准住宿请附直属总监审批截图。`,
  });
  await v.rpc("channel.message.send", {
    id: adminChannelId,
    text: `四楼东侧研发工区新增的 12 台 27 寸 4K 显示器和 8 把人体工学椅已验收摆放完毕（#${issue19.number}），有换新需求的组长可按工位号在行政台账登记领用。`,
  });

  await v.rpc("channel.message.send", {
    id: releaseChannelId,
    text: `Alpha 0.1.0-alpha.17 本地验证包已产出；Developer ID 公证链路与 DMG 装订正在 #${issue5.number} 联调，周五 16:00 进行一次主从切换桌面演练。`,
  });
  await v.rpc("channel.message.send", {
    id: consoleChannelId,
    text: `请假跨自然月折算修复已在 #${issue16.number} 提交测试；考勤月结 CSV 的 UTF-8 BOM 支持见 #${issue7.number}，待产品评审确认后随本周小版本合入。`,
  });

  const cronStandup = await v.rpc(
    "cron.create",
    {
      name: "研发晨会阻塞与超期工单播报",
      text: "汇总昨日已合并 PR、当日逾期任务与待评审清单，推送至 #backend-arch。",
      channel: backendChannelId,
      repo: repoGateway.name,
      when: { kind: "daily", time: "09:30" },
      tz: "Asia/Shanghai",
    },
    CreatedCronSchema,
  );
  const cronOnboarding = await v.rpc(
    "cron.create",
    {
      name: "每周一新人入职与 Offer 回执追踪",
      text: "统计下两周拟入职名单、电脑门禁就绪率及待签署 Offer 进度，发布至 #people-onboarding。",
      channel: hrChannelId,
      repo: repoHandbook.name,
      when: { kind: "weekly", days: [1], time: "10:00" },
      tz: "Asia/Shanghai",
    },
    CreatedCronSchema,
  );
  const cronFinance = await v.rpc(
    "cron.create",
    {
      name: "月结考勤与差旅发票截止提醒",
      text: "提醒全员在 25 日前提交当月考勤异常处理与差旅报销发票。",
      channel: adminChannelId,
      repo: repoHandbook.name,
      when: { kind: "cron", expr: "0 10 23 * *" },
      tz: "Asia/Shanghai",
    },
    CreatedCronSchema,
  );
  const cronFailover = await v.rpc(
    "cron.create",
    {
      name: "周五预发环境高并发与主从切换压测",
      text: "按每周压测基线触发 OAuth2 令牌轮换与降级演练采样。",
      channel: releaseChannelId,
      repo: repoInfra.name,
      when: { kind: "weekly", days: [5], time: "16:30" },
      tz: "Asia/Shanghai",
    },
    CreatedCronSchema,
  );
  await v.rpc("cron.update", { id: cronFailover.id, enabled: false });

  return {
    issueIds: [
      issue1.id,
      issue2.id,
      issue3.id,
      issue4.id,
      issue5.id,
      issue6.id,
      issue7.id,
      issue8.id,
      issue9.id,
      issue10.id,
      issue11.id,
      issue12.id,
      issue13.id,
      issue14.id,
      issue15.id,
      issue16.id,
      issue17.id,
      issue18.id,
      issue19.id,
      issue20.id,
    ],
    channelId: backendChannelId,
    hrChannelId,
    adminChannelId,
    channelIds: [backendChannelId, hrChannelId, adminChannelId, releaseChannelId, consoleChannelId],
    repoNames,
    agentIds,
    cronIds: [cronStandup.id, cronOnboarding.id, cronFinance.id, cronFailover.id],
  };
}

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
