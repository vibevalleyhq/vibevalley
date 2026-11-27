import { defineScenario } from "../dsl.ts";
import { seedWorkspaceCore } from "../fixtures/workspace.ts";

export const chatScenario = defineScenario({
  id: "chat",
  description: "Channels workbench view and composer in Light & Dark",
  async run(v) {
    const core = await seedWorkspaceCore(v);
    await v.resize(v.viewport.width, v.viewport.height);

    await v.forThemes(undefined, async (theme) => {
      const route = `/chat/${encodeURIComponent(core.channelId)}`;
      await v.nav(route);
      await v.waitRoute("/chat");
      await v.wait("chat-page");
      await v.assertClean(`chat-channel-${theme}`);
      await v.shot(`chat-channel-${theme}`, { label: `Channel Workspace (${theme})` });
    });
  },
});
