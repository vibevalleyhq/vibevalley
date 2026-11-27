import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const issuesScenario = defineScenario({
  id: "issues",
  description: "Issues Kanban board & issue detail (including narrow viewport) in Light & Dark",
  async run(v) {
    const ids = await seedNoteShowcase(v);
    await v.resize(v.viewport.width, v.viewport.height);

    await v.forThemes(undefined, async (theme) => {
      await v.nav("/issues");
      await v.waitRoute("/issues");
      await v.wait("issues-page");
      await v.assertClean(`issues-board-${theme}`);
      await v.shot(`issues-board-${theme}`, { label: `Issues Kanban Board (${theme})` });

      await v.nav(`/issues/${ids.issueIds[0]}`);
      await v.waitRoute(`/issues/${ids.issueIds[0]}`);
      await v.wait("issue-notes");
      await v.assertClean(`issues-detail-${theme}`);
      await v.shot(`issues-detail-${theme}`, { label: `Issue Detail & Linked Notes (${theme})` });
    });

    await v.theme("light");
    await v.resize(720, 860);
    await v.nav("/issues");
    await v.waitRoute("/issues");
    await v.wait("issues-page");
    await v.assertClean("issues-board-narrow-light");
    await v.shot("issues-board-narrow-light", { label: "Issues Board Narrow (<768px)", settleMs: 220 });
    await v.resize(v.viewport.width, v.viewport.height);
  },
});
