import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const issuesScenario = defineScenario({
  id: "issues",
  description: "Issues Kanban board, List, Timeline, Calendar, Issue detail, and narrow viewport in Light & Dark",
  async run(v) {
    const ids = await seedNoteShowcase(v);
    await v.resize(v.viewport.width, v.viewport.height);

    await v.forThemes(undefined, async (theme) => {
      await v.nav("/issues");
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

      // Reset default view preference back to Board for clean subsequent navigation.
      await v.press("issue-view-board");
      await v.wait("issues-page");

      await v.nav(`/issues/${ids.issueIds[1]}`);
      await v.waitRoute(`/issues/${ids.issueIds[1]}`);
      await v.wait("issue-notes");
      await v.assertClean(`issues-detail-${theme}`);
      await v.shot(`issues-detail-${theme}`, { label: `Issue Detail & Linked Notes (${theme})` });
    });

    await v.theme("light");
    await v.nav(`/issues/${ids.issueIds[0]}`);
    await v.waitRoute(`/issues/${ids.issueIds[0]}`);
    await v.wait("family-detail");
    await v.assertClean("issues-family-light");
    await v.shot("issues-family-light", { label: "Parent Family Issue Detail (light)" });

    await v.resize(720, 860);
    await v.nav("/issues");
    await v.waitRoute("/issues");
    await v.wait("issues-page");
    await v.assertClean("issues-board-narrow-light");
    await v.shot("issues-board-narrow-light", { label: "Issues Board Narrow (<768px)", settleMs: 220 });
    await v.resize(v.viewport.width, v.viewport.height);
  },
});
