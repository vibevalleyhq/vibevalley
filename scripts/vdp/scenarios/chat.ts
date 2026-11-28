import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const chatScenario = defineScenario({
  id: "chat",
  description: "Channels click-through navigation, filter cycling, and multi-turn composer view in Light & Dark",
  async run(v) {
    const ids = await seedNoteShowcase(v);
    await v.resize(v.viewport.width, v.viewport.height);
    await v.nav("/issues");
    await v.waitRoute("/issues");

    await v.forThemes(undefined, async (theme) => {
      await v.wait("place-chat");
      await v.press("place-chat");
      await v.waitRoute("/chat");
      await v.wait("chat-page");

      await v.press("chat-filter-group");
      await v.press("chat-filter-direct");
      await v.press("chat-filter-all");

      const targetRoute = `/chat/${encodeURIComponent(ids.channelId)}`;
      await v.nav(targetRoute);
      await v.waitRoute("/chat");
      await v.wait("chat-page");
      await v.assertClean(`chat-channel-${theme}`);
      await v.shot(`chat-channel-${theme}`, { label: `Channel Workspace (${theme})` });
    });
  },
});
