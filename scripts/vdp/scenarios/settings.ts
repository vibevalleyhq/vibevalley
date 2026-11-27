import { defineScenario } from "../dsl.ts";

const SETTING_SECTIONS = [
  { route: "/settings/general", id: "settings-general", label: "General Settings" },
  { route: "/settings/providers", id: "settings-providers", label: "Model Providers" },
  { route: "/settings/models", id: "settings-models", label: "Models & Model Policy" },
  { route: "/settings/appearance", id: "settings-appearance", label: "Appearance & Theme" },
  { route: "/settings/voice", id: "settings-voice", label: "Voice & Audio" },
  { route: "/settings/remote", id: "settings-remote", label: "Remote Access & Pairing" },
  { route: "/settings/about", id: "settings-about", label: "About & Diagnostics" },
] as const;

export const settingsScenario = defineScenario({
  id: "settings",
  description: "Settings navigation and key subsections (general/providers/models/appearance/voice/remote/about) in Light & Dark",
  async run(v) {
    await v.resize(v.viewport.width, v.viewport.height);

    await v.forThemes(undefined, async (theme) => {
      for (const sec of SETTING_SECTIONS) {
        await v.nav(sec.route);
        await v.waitRoute(sec.route);
        await v.wait("settings-nav");
        await v.assertClean(`${sec.id}-${theme}`);
        await v.shot(`${sec.id}-${theme}`, { label: `${sec.label} (${theme})` });
      }
    });
  },
});
