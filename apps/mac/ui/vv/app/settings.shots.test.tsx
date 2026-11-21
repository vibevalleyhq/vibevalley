// Pictures of the settings sections ported after round 3, the memory panels
// and the orchestrator's voice tab (story.tsx, the workbench fixture):
// `nsh test --target gpui vv/app/settings.shots.test.tsx`.
import "../polyfill";
import { expect, open, test } from "nsh/test";

const shots: { name: string; route: string; scheme: "light" | "dark"; width: number; id: string; tab?: string }[] = [
  { name: "settings-providers-light", route: "/settings/models", scheme: "light", width: 1200, id: "provider-form" },
  { name: "settings-providers-dark", route: "/settings/models", scheme: "dark", width: 1200, id: "provider-form" },
  { name: "settings-accounts-light", route: "/settings/accounts", scheme: "light", width: 1200, id: "provider-form" },
  { name: "settings-call-light", route: "/settings/voice/call", scheme: "light", width: 1200, id: "voice-call" },
  { name: "settings-call-dark", route: "/settings/voice/call", scheme: "dark", width: 1200, id: "voice-call" },
  { name: "settings-moss-light", route: "/settings/voice/moss", scheme: "light", width: 1200, id: "voice-moss" },
  { name: "settings-dictation-light", route: "/settings/voice/dictation", scheme: "light", width: 1200, id: "voice-dictation" },
  { name: "settings-chat-light", route: "/settings/connections/chat", scheme: "light", width: 1200, id: "connectors" },
  { name: "settings-chat-feishu-dark", route: "/settings/connections/chat/feishu", scheme: "dark", width: 1200, id: "connectors" },
  { name: "settings-chat-qq-light", route: "/settings/connections/chat/qq", scheme: "light", width: 1200, id: "connectors" },
  { name: "orchestrator-memory-light", route: "/orchestrator", scheme: "light", width: 1200, id: "orchestrator-memory" },
  { name: "orchestrator-voice-light", route: "/orchestrator/voice", scheme: "light", width: 1200, id: "minimax-voices" },
  { name: "agent-memory-light", route: "/agents/laozhou", scheme: "light", width: 1200, id: "memory-panel", tab: "tab-memory" },
  { name: "agent-memory-dark", route: "/agents/laozhou", scheme: "dark", width: 1200, id: "memory-panel", tab: "tab-memory" },
];

for (const s of shots) {
  test(s.name, async () => {
    const app = await open("./story.tsx", { width: s.width, height: 800, colorScheme: s.scheme, platform: "macos", host: { params: { route: s.route } } });
    await app.wait(1500);
    if (s.tab) {
      await app.press(`id:${s.tab}`);
      await app.wait(800);
    }
    expect(app.count(`id:${s.id}`)).toBe(1);
    try {
      await app.screenshot(`vv/app/shots/${s.name}.png`);
    } catch (e) {
      console.log(`no picture of ${s.name}: ${String(e)}`);
    }
  });
}
