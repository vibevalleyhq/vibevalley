import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const dashboardScenario = defineScenario({
  id: "dashboard",
  description: "Click-through across Dashboard (Overview/Retro/Runs), Workspace, Repos, Agents Roster, and Runtimes with single Dark sample",
  async run(v) {
    await seedNoteShowcase(v);
    const primaryTheme = v.defaultThemes[0] ?? "light";
    const includeDarkSample = v.defaultThemes.length > 1 && v.defaultThemes.includes("dark");

    await v.resize(v.viewport.width, v.viewport.height);
    await v.theme(primaryTheme);
    await v.nav("/issues");
    await v.waitRoute("/issues");

    await v.wait("place-dashboard");
    await v.press("place-dashboard");
    await v.waitRoute("/dashboard");
    await v.wait("dashboard-page");
    await v.assertClean(`dashboard-overview-${primaryTheme}`);
    await v.shot(`dashboard-overview-${primaryTheme}`, { label: `Dashboard Overview (${primaryTheme})`, settleMs: 80 });

    if (includeDarkSample) {
      await v.theme("dark");
      await v.assertClean("dashboard-overview-dark");
      await v.shot("dashboard-overview-dark", { label: "Dashboard Overview (dark)", settleMs: 90 });
      await v.theme(primaryTheme);
    }

    await v.wait("dashboard-tabs-retro");
    await v.press("dashboard-tabs-retro");
    await v.waitRoute("/dashboard/retro");
    await v.assertClean(`dashboard-retro-${primaryTheme}`);
    await v.shot(`dashboard-retro-${primaryTheme}`, { label: `Dashboard Retro (${primaryTheme})`, settleMs: 80 });

    await v.wait("dashboard-tabs-runs");
    await v.press("dashboard-tabs-runs");
    await v.waitRoute("/dashboard/runs");
    await v.wait("runs-page");
    await v.assertClean(`dashboard-runs-${primaryTheme}`);
    await v.shot(`dashboard-runs-${primaryTheme}`, { label: `Dashboard Runs & Trajectories (${primaryTheme})`, settleMs: 80 });

    await v.wait("place-workspace");
    await v.press("place-workspace");
    await v.waitRoute("/workspace");
    await v.assertClean(`workspace-pane-${primaryTheme}`);
    await v.shot(`workspace-pane-${primaryTheme}`, { label: `Workspace Native Pane (${primaryTheme})`, settleMs: 80 });

    await v.nav("/repos/core-gateway");
    await v.waitRoute("/repos");
    await v.wait("repos-page");
    await v.assertClean(`repos-list-${primaryTheme}`);
    await v.shot(`repos-list-${primaryTheme}`, { label: `Repositories Workspace (${primaryTheme})`, settleMs: 80 });

    await v.wait("place-team");
    await v.press("place-team");
    await v.waitRoute("/agents");
    await v.wait("agents-page");
    await v.assertClean(`agents-roster-${primaryTheme}`);
    await v.shot(`agents-roster-${primaryTheme}`, { label: `Agents Roster (${primaryTheme})`, settleMs: 80 });

    await v.wait("place-runtimes");
    await v.press("place-runtimes");
    await v.waitRoute("/runtimes");
    await v.wait("runtimes-page");
    await v.assertClean(`runtimes-list-${primaryTheme}`);
    await v.shot(`runtimes-list-${primaryTheme}`, { label: `Runtimes & Engines (${primaryTheme})`, settleMs: 80 });
  },
});
