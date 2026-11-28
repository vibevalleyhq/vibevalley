import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const dashboardScenario = defineScenario({
  id: "dashboard",
  description: "Real-user click-through across Dashboard (Overview/Retro/Runs), Repos, Agents Roster, and Runtimes in Light & Dark",
  async run(v) {
    await seedNoteShowcase(v);
    await v.resize(v.viewport.width, v.viewport.height);
    await v.nav("/issues");
    await v.waitRoute("/issues");

    await v.forThemes(undefined, async (theme) => {
      await v.wait("place-dashboard");
      await v.press("place-dashboard");
      await v.waitRoute("/dashboard");
      await v.wait("dashboard-page");
      await v.assertClean(`dashboard-overview-${theme}`);
      await v.shot(`dashboard-overview-${theme}`, { label: `Dashboard Overview (${theme})` });

      await v.wait("dashboard-tabs-retro");
      await v.press("dashboard-tabs-retro");
      await v.waitRoute("/dashboard/retro");
      await v.assertClean(`dashboard-retro-${theme}`);
      await v.shot(`dashboard-retro-${theme}`, { label: `Dashboard Retro (${theme})` });

      await v.wait("dashboard-tabs-runs");
      await v.press("dashboard-tabs-runs");
      await v.waitRoute("/dashboard/runs");
      await v.wait("runs-page");
      await v.assertClean(`dashboard-runs-${theme}`);
      await v.shot(`dashboard-runs-${theme}`, { label: `Dashboard Runs & Trajectories (${theme})` });

      await v.wait("place-workspace");
      await v.press("place-workspace");
      await v.waitRoute("/workspace");
      await v.assertClean(`workspace-pane-${theme}`);
      await v.shot(`workspace-pane-${theme}`, { label: `Workspace Native Pane (${theme})` });

      await v.nav("/repos/papertrails-ui");
      await v.waitRoute("/repos");
      await v.wait("repos-page");
      await v.assertClean(`repos-list-${theme}`);
      await v.shot(`repos-list-${theme}`, { label: `Repositories Workspace (${theme})` });

      await v.wait("place-team");
      await v.press("place-team");
      await v.waitRoute("/agents");
      await v.wait("agents-page");
      await v.assertClean(`agents-roster-${theme}`);
      await v.shot(`agents-roster-${theme}`, { label: `Agents Roster (${theme})` });

      await v.wait("place-runtimes");
      await v.press("place-runtimes");
      await v.waitRoute("/runtimes");
      await v.wait("runtimes-page");
      await v.assertClean(`runtimes-list-${theme}`);
      await v.shot(`runtimes-list-${theme}`, { label: `Runtimes & Engines (${theme})` });
    });
  },
});
