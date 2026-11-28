import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const libraryScenario = defineScenario({
  id: "library",
  description: "Library gallery entered via left rail Content button in Light & Dark",
  async run(v) {
    await seedNoteShowcase(v);
    await v.resize(v.viewport.width, v.viewport.height);
    await v.nav("/issues");
    await v.waitRoute("/issues");

    await v.forThemes(undefined, async (theme) => {
      await v.wait("place-content");
      await v.press("place-content");
      await v.wait("content-nav-notes-all");
      await v.press("content-nav-notes-all");
      await v.waitRoute("/library");
      await v.wait("library-page");
      await v.assertClean(`library-grid-${theme}`);
      await v.shot(`library-grid-${theme}`, { label: `Library & Notes Grid (${theme})` });
    });
  },
});
