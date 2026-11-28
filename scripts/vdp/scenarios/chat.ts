import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const chatScenario = defineScenario({
  id: "chat",
  description: "Channels click-through across engineering architecture and HR onboarding channels",
  async run(v) {
    const ids = await seedNoteShowcase(v);
    const primaryTheme = v.defaultThemes[0] ?? "light";

    await v.resize(v.viewport.width, v.viewport.height);
    await v.theme(primaryTheme);
    await v.nav("/issues");
    await v.waitRoute("/issues");

    await v.wait("place-chat");
    await v.press("place-chat");
    await v.waitRoute("/chat");
    await v.wait("chat-page");

    await v.press("chat-filter-group");
    await v.press("chat-filter-direct");
    await v.press("chat-filter-all");

    await v.nav(`/chat/${encodeURIComponent(ids.channelId)}`);
    await v.waitRoute("/chat");
    await v.wait("chat-page");
    await v.assertClean(`chat-channel-${primaryTheme}`);
    await v.shot(`chat-channel-${primaryTheme}`, { label: `Backend Architecture Channel (${primaryTheme})`, settleMs: 80 });

    await v.nav(`/chat/${encodeURIComponent(ids.hrChannelId)}`);
    await v.waitRoute("/chat");
    await v.wait("chat-page");
    await v.assertClean(`chat-hr-onboarding-${primaryTheme}`);
    await v.shot(`chat-hr-onboarding-${primaryTheme}`, { label: `People Onboarding Channel (${primaryTheme})`, settleMs: 80 });
  },
});
