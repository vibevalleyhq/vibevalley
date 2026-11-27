import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const libraryScenario = defineScenario({
  id: "library",
  description: "Library gallery with unified sidebar and 3+1 Notes grid in Light & Dark",
  async run(v) {
    await seedNoteShowcase(v);
    await v.resize(v.viewport.width, v.viewport.height);

    await v.forThemes(undefined, async (theme) => {
      await v.nav("/library");
      await v.waitRoute("/library");
      await v.wait("library-page");
      await v.assertClean(`library-grid-${theme}`);
      await v.shot(`library-grid-${theme}`, { label: `Library & Notes Grid (${theme})` });
    });
  },
});
