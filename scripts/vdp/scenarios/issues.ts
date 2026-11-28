import { z } from "zod";

import { defineScenario, flattenLayoutDump } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

const EnsuredBodySchema = z.object({
  note: z.object({ id: z.string().min(1) }),
});

export const issuesScenario = defineScenario({
  id: "issues",
  description:
    "Issues click-through journey (Kanban/List/Timeline/Calendar), dense RFC BlockDoc geometry check, narrow viewports, and single Dark Board sample",
  async run(v) {
    const ids = await seedNoteShowcase(v);
    const detailIssueId = ids.issueIds[1] ?? ids.issueIds[0]!;
    const primaryTheme = v.defaultThemes[0] ?? "light";
    const includeDarkSample = v.defaultThemes.length > 1 && v.defaultThemes.includes("dark");

    const ensured = await v.rpc("issue.body.ensure", { id: detailIssueId }, EnsuredBodySchema);
    const rfcDoc = {
      version: 1,
      blocks: [
        {
          id: "rfc_kpi",
          type: "kpi",
          items: [
            { label: "并发刷新耗时 P99", value: "6.4 ms", delta: "较上周 -3.1 ms", tone: "ok" },
            { label: "重放拦截准确率", value: "100%", delta: "10 并发压测零泄漏", tone: "ok" },
            { label: "Redis 降级切换", value: "< 1.5 ms", delta: "本地令牌桶兜底", tone: "info" },
            { label: "控制台联动单", value: "#10", delta: "429 退避提示待联调", tone: "neutral" },
          ],
        },
        {
          id: "rfc_prose",
          type: "prose",
          text: "围绕 [[#1]] 与历史改造 #1/#3，在 **Refresh Token 并发防重放锁** 方案中统一采用租户维度 `KeyLock` 串行化上游换票调用。",
        },
        {
          id: "rfc_table",
          type: "table",
          headers: ["**组件模块**", "`核心策略`", "预期收益"],
          rows: [
            ["`oauth2::RefreshLock`", "`KeyLock<TenantId>` 并发合并", "消除双端同时刷新引发令牌作废"],
            ["`rate_limit::Fallback`", "Redis 断连降级本地令牌桶", "下游抖动期间网关保持可用"],
          ],
        },
        { id: "rfc_list", type: "list", ordered: false, items: ["紧邻列表项保持紧凑排版节奏，禁止左侧多余空白", "长文件路径与中英文技术术语混排自动软换行"] },
        { id: "rfc_todo_1", type: "todo", checked: true, text: "已合入 PostgreSQL 连接池空闲回收 PR #412 与慢查询指标" },
        { id: "rfc_todo_2", type: "todo", checked: false, text: "与控制台 #10 联调 429 Retry-After 横幅及静默重试流程" },
        {
          id: "rfc_callout",
          type: "callout",
          tone: "info",
          title: "灰度与回滚预案",
          text: "先在预发和 5% 金丝雀租户开启防重放锁开关 `oauth2.lock.enabled`，如上游延迟升高可秒级切换回透传模式。",
        },
        {
          id: "rfc_code",
          type: "code",
          language: "rust",
          code: "let _guard = RefreshLock::acquire(&tenant_id).await;\noauth_upstream::rotate_once(&refresh_token).await?",
        },
      ],
    };
    await v.rpc("note.file.write", {
      id: ensured.note.id,
      files: [{ path: "structure/doc.json", content: JSON.stringify(rfcDoc, null, 2) }],
      summary: "Seed dense engineering RFC Issue body for layout audit",
    });

    await v.resize(v.viewport.width, v.viewport.height);
    await v.theme(primaryTheme);
    await v.nav("/settings/general");
    await v.waitRoute("/settings");

    await v.wait("place-issues");
    await v.press("place-issues");
    await v.waitRoute("/issues");
    await v.wait("issues-page");
    await v.assertClean(`issues-board-${primaryTheme}`);
    await v.shot(`issues-board-${primaryTheme}`, { label: `Issues Kanban Board (${primaryTheme})`, settleMs: 80 });

    if (includeDarkSample) {
      await v.theme("dark");
      await v.assertClean("issues-board-dark");
      await v.shot("issues-board-dark", { label: "Issues Kanban Board (dark)", settleMs: 90 });
      await v.theme(primaryTheme);
    }

    await v.press("issue-view-list");
    await v.wait("issue-list");
    await v.assertClean(`issues-list-${primaryTheme}`);
    await v.shot(`issues-list-${primaryTheme}`, { label: `Issues List View (${primaryTheme})`, settleMs: 80 });

    await v.press("issue-view-timeline");
    await v.wait("issue-timeline");
    await v.assertClean(`issues-timeline-${primaryTheme}`);
    await v.shot(`issues-timeline-${primaryTheme}`, { label: `Issues Timeline / Gantt (${primaryTheme})`, settleMs: 120 });

    await v.press("issue-view-calendar");
    await v.wait("issue-calendar");
    await v.assertClean(`issues-calendar-${primaryTheme}`);
    await v.shot(`issues-calendar-${primaryTheme}`, { label: `Issues Calendar View (${primaryTheme})`, settleMs: 80 });

    await v.press("issue-view-board");
    await v.wait("issues-page");
    await v.wait(`issue-card-${detailIssueId}`);
    await v.press(`issue-card-${detailIssueId}`);
    await v.wait("issue-peek-expand");
    await v.wait("note-block-doc-view");
    await v.wait("doc-block-rfc_kpi");
    await v.settle(80);

    const dump = await v.dumpLayout("workbench");
    const flat = flattenLayoutDump(dump);
    const findById = (id: string) => [...flat.values()].find((n) => n.id === id);
    const docRoot = findById("note-block-doc-view");
    const firstBlock = findById("doc-block-rfc_kpi");
    if (!docRoot?.bounds || !firstBlock?.bounds) {
      throw new Error(`Expected bounds on note-block-doc-view and doc-block-rfc_kpi (theme=${primaryTheme})`);
    }
    const leftGap = Math.abs(firstBlock.bounds.x - docRoot.bounds.x);
    if (leftGap > 4) {
      throw new Error(`Excess left margin gap on embedded RFC doc: leftGap=${leftGap}px (docX=${docRoot.bounds.x}, blockX=${firstBlock.bounds.x})`);
    }
    const blockRight = firstBlock.bounds.x + firstBlock.bounds.width;
    const docRight = docRoot.bounds.x + docRoot.bounds.width;
    if (blockRight > docRight + 4) {
      throw new Error(`Right-edge clipping in embedded RFC doc: blockRight=${blockRight} > docRight=${docRight}`);
    }

    await v.press("issue-peek-expand");
    await v.waitRoute(`/issues/${detailIssueId}`);
    await v.wait("issue-notes");
    await v.wait("note-block-doc-view");
    await v.wait("doc-block-rfc_kpi");
    await v.assertClean(`issues-detail-${primaryTheme}`);
    await v.shot(`issues-detail-${primaryTheme}`, { label: `Issue Detail RFC BlockDoc (${primaryTheme})`, settleMs: 80 });

    await v.press("place-issues");
    await v.waitRoute("/issues");
    const parentId = ids.issueIds[0]!;
    await v.wait(`issue-card-${parentId}`);
    await v.press(`issue-card-${parentId}`);
    await v.wait("issue-peek-expand");
    await v.press("issue-peek-expand");
    await v.waitRoute(`/issues/${parentId}`);
    await v.wait("family-detail");
    await v.assertClean(`issues-family-${primaryTheme}`);
    await v.shot(`issues-family-${primaryTheme}`, { label: `Parent Family Issue Detail (${primaryTheme})`, settleMs: 80 });

    await v.resize(720, 860);
    await v.press("place-issues");
    await v.waitRoute("/issues");
    await v.wait("issues-page");
    await v.assertClean(`issues-board-narrow-${primaryTheme}`);
    await v.shot(`issues-board-narrow-${primaryTheme}`, { label: `Issues Board Narrow (720px)`, settleMs: 110 });

    await v.resize(560, 820);
    await v.wait("issues-page");
    await v.assertClean(`issues-board-narrow-560-${primaryTheme}`);
    await v.shot(`issues-board-narrow-560-${primaryTheme}`, { label: `Issues Board Narrow (560x820)`, settleMs: 110 });
    await v.resize(v.viewport.width, v.viewport.height);
  },
});
