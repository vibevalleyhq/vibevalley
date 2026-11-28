import { z } from "zod";

import { defineScenario, flattenLayoutDump } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

const EnsuredBodySchema = z.object({
  note: z.object({ id: z.string().min(1) }),
});

export const issuesScenario = defineScenario({
  id: "issues",
  description: "Issues click-through journey (Kanban/List/Timeline/Calendar), dense RFC BlockDoc geometry check, and narrow viewport in Light & Dark",
  async run(v) {
    const ids = await seedNoteShowcase(v);
    const detailIssueId = ids.issueIds[1] ?? ids.issueIds[0]!;
    const ensured = await v.rpc("issue.body.ensure", { id: detailIssueId }, EnsuredBodySchema);
    const rfcDoc = {
      version: 1,
      blocks: [
        {
          id: "rfc_kpi",
          type: "kpi",
          items: [
            { label: "当前规则盲区", value: "51%", delta: "115 / 225 个 nsh 组件 · 零右裁切", tone: "info" },
            { label: "缺 key 的 Each", value: "0 处", delta: "全量补齐稳定键", tone: "ok" },
            { label: "顶层首帧冻结", value: "0 处", delta: "props/信号延后求值", tone: "ok" },
            { label: "抖动与回环", value: "0 处", delta: "字重恒定 + selection guard", tone: "neutral" },
          ],
        },
        {
          id: "rfc_prose",
          type: "prose",
          text: "围绕 [[#1]] 与历史规范 #1/#2，在 **嵌入式工单正文** 中验证 `Zero-Margin` 与无右裁切对齐。",
        },
        {
          id: "rfc_table",
          type: "table",
          headers: ["**规则名称**", "`拦截范围`", "推荐改法"],
          rows: [
            ["`nsh-each-key`", "`<Each>` 缺失稳定 `key`", "改为 `key={(x) => x.id}`"],
            ["`ui-tokens`", "字重切换与静态 style", "保留字重，用 `bg-selected`"],
          ],
        },
        { id: "rfc_list", type: "list", ordered: false, items: ["紧邻列表项保持紧凑间距", "多行路径与中英文混排正常软换行"] },
        { id: "rfc_todo_1", type: "todo", checked: true, text: "已收紧嵌入式 BlockDoc 左侧留白与 KPI 折行" },
        { id: "rfc_todo_2", type: "todo", checked: false, text: "验证表头行内 Markdown 与 CJK/#N 引用边界" },
        {
          id: "rfc_callout",
          type: "callout",
          tone: "info",
          title: "排版门禁说明",
          text: "工单详情内 `note-block-doc-view` 首块左边距需紧贴容器边缘，且右缘不可溢出裁切。",
        },
        { id: "rfc_code", type: "code", language: "ts", code: "const invariant = firstBlock.bounds.x - docRoot.bounds.x <= 4;" },
      ],
    };
    await v.rpc("note.file.write", {
      id: ensured.note.id,
      files: [{ path: "structure/doc.json", content: JSON.stringify(rfcDoc, null, 2) }],
      summary: "Seed dense RFC Issue body for layout audit",
    });

    await v.resize(v.viewport.width, v.viewport.height);
    await v.nav("/settings/general");
    await v.waitRoute("/settings");

    await v.forThemes(undefined, async (theme) => {
      await v.wait("place-issues");
      await v.press("place-issues");
      await v.waitRoute("/issues");
      await v.wait("issues-page");
      await v.assertClean(`issues-board-${theme}`);
      await v.shot(`issues-board-${theme}`, { label: `Issues Kanban Board (${theme})` });

      await v.press("issue-view-list");
      await v.wait("issue-list");
      await v.assertClean(`issues-list-${theme}`);
      await v.shot(`issues-list-${theme}`, { label: `Issues List View (${theme})` });

      await v.press("issue-view-timeline");
      await v.wait("issue-timeline");
      await v.assertClean(`issues-timeline-${theme}`);
      await v.shot(`issues-timeline-${theme}`, { label: `Issues Timeline / Gantt (${theme})`, settleMs: 220 });

      await v.press("issue-view-calendar");
      await v.wait("issue-calendar");
      await v.assertClean(`issues-calendar-${theme}`);
      await v.shot(`issues-calendar-${theme}`, { label: `Issues Calendar View (${theme})` });

      await v.press("issue-view-board");
      await v.wait("issues-page");
      await v.wait(`issue-card-${detailIssueId}`);
      await v.press(`issue-card-${detailIssueId}`);
      await v.wait("issue-peek-expand");
      await v.wait("note-block-doc-view");
      await v.wait("doc-block-rfc_kpi");
      await v.settle(140);

      const dump = await v.dumpLayout("workbench");
      const flat = flattenLayoutDump(dump);
      const findById = (id: string) => [...flat.values()].find((n) => n.id === id);
      const docRoot = findById("note-block-doc-view");
      const firstBlock = findById("doc-block-rfc_kpi");
      if (!docRoot?.bounds || !firstBlock?.bounds) {
        throw new Error(`Expected bounds on note-block-doc-view and doc-block-rfc_kpi (theme=${theme})`);
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
      await v.assertClean(`issues-detail-${theme}`);
      await v.shot(`issues-detail-${theme}`, { label: `Issue Detail RFC BlockDoc (${theme})` });
      await v.press("place-issues");
      await v.waitRoute("/issues");
    });

    await v.theme("light");
    const parentId = ids.issueIds[0]!;
    await v.wait(`issue-card-${parentId}`);
    await v.press(`issue-card-${parentId}`);
    await v.wait("issue-peek-expand");
    await v.press("issue-peek-expand");
    await v.waitRoute(`/issues/${parentId}`);
    await v.wait("family-detail");
    await v.assertClean("issues-family-light");
    await v.shot("issues-family-light", { label: "Parent Family Issue Detail (light)" });

    await v.resize(720, 860);
    await v.press("place-issues");
    await v.waitRoute("/issues");
    await v.wait("issues-page");
    await v.assertClean("issues-board-narrow-light");
    await v.shot("issues-board-narrow-light", { label: "Issues Board Narrow (720px)", settleMs: 220 });

    await v.resize(560, 820);
    await v.wait("issues-page");
    await v.assertClean("issues-board-narrow-560-light");
    await v.shot("issues-board-narrow-560-light", { label: "Issues Board Narrow (560x820)", settleMs: 220 });
    await v.resize(v.viewport.width, v.viewport.height);
  },
});
