import { defineScenario } from "../dsl.ts";

const SETTING_SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "general", label: "General Settings" },
  { id: "appearance", label: "Appearance & Theme" },
  { id: "providers", label: "Model Providers" },
  { id: "models", label: "Models & Model Policy" },
  { id: "voice", label: "Voice & Audio" },
  { id: "remote", label: "Remote Access & Pairing" },
  { id: "about", label: "About & Diagnostics" },
] as const;

export const settingsScenario = defineScenario({
  id: "settings",
  description: "Settings navigation via left rail button and top-to-bottom section clicks in Light & Dark",
  async run(v) {
    await v.resize(v.viewport.width, v.viewport.height);
    await v.nav("/issues");
    await v.waitRoute("/issues");
    await v.wait("place-settings");
    await v.press("place-settings");
    await v.waitRoute("/settings");

    await v.forThemes(undefined, async (theme) => {
      for (const sec of SETTING_SECTIONS) {
        const route = `/settings/${sec.id}`;
        await v.wait(`settings-section-${sec.id}`);
        await v.press(`settings-section-${sec.id}`);
        await v.waitRoute(route);
        await v.wait("settings-nav");
        await v.assertClean(`settings-${sec.id}-${theme}`);
        await v.shot(`settings-${sec.id}-${theme}`, { label: `${sec.label} (${theme})` });
      }
    });
  },
});
