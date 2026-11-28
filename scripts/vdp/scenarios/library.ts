import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const libraryScenario = defineScenario({
  id: "library",
  description: "Library gallery showing engineering specs, HR bases, and ops handbooks via left rail Content button",
  async run(v) {
    await seedNoteShowcase(v);
    const primaryTheme = v.defaultThemes[0] ?? "light";

    await v.resize(v.viewport.width, v.viewport.height);
    await v.theme(primaryTheme);
    await v.nav("/issues");
    await v.waitRoute("/issues");

    await v.wait("place-content");
    await v.press("place-content");
    await v.wait("content-nav-notes-all");
    await v.press("content-nav-notes-all");
    await v.waitRoute("/library");
    await v.wait("library-page");
    await v.assertClean(`library-grid-${primaryTheme}`);
    await v.shot(`library-grid-${primaryTheme}`, { label: `Library & Notes Grid (${primaryTheme})`, settleMs: 80 });
  },
});
