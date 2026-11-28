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
  description: "Settings navigation via left rail button and top-to-bottom section clicks with single Dark Appearance sample",
  async run(v) {
    const primaryTheme = v.defaultThemes[0] ?? "light";
    const includeDarkSample = v.defaultThemes.length > 1 && v.defaultThemes.includes("dark");

    await v.resize(v.viewport.width, v.viewport.height);
    await v.theme(primaryTheme);
    await v.nav("/issues");
    await v.waitRoute("/issues");
    await v.wait("place-settings");
    await v.press("place-settings");
    await v.waitRoute("/settings");

    for (const sec of SETTING_SECTIONS) {
      const route = `/settings/${sec.id}`;
      await v.wait(`settings-section-${sec.id}`);
      await v.press(`settings-section-${sec.id}`);
      await v.waitRoute(route);
      await v.wait("settings-nav");
      await v.assertClean(`settings-${sec.id}-${primaryTheme}`);
      await v.shot(`settings-${sec.id}-${primaryTheme}`, { label: `${sec.label} (${primaryTheme})`, settleMs: 60 });

      if (sec.id === "appearance" && includeDarkSample) {
        await v.theme("dark");
        await v.assertClean("settings-appearance-dark");
        await v.shot("settings-appearance-dark", { label: `${sec.label} (dark)`, settleMs: 80 });
        await v.theme(primaryTheme);
      }
    }
  },
});
