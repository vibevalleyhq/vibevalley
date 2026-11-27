import { defineScenario } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

export const dashboardScenario = defineScenario({
  id: "dashboard",
  description: "Dashboard overview, Repositories, Runs & Trajectories, Agents Roster, and Runtimes in Light & Dark",
  async run(v) {
    await seedNoteShowcase(v);
    await v.resize(v.viewport.width, v.viewport.height);

    await v.forThemes(undefined, async (theme) => {
      await v.nav("/dashboard");
      await v.waitRoute("/dashboard");
      await v.wait("dashboard-page");
      await v.assertClean(`dashboard-overview-${theme}`);
      await v.shot(`dashboard-overview-${theme}`, { label: `Dashboard Overview (${theme})` });

      await v.nav("/repos/papertrails-ui");
      await v.waitRoute("/repos");
      await v.wait("repos-page");
      await v.assertClean(`repos-list-${theme}`);
      await v.shot(`repos-list-${theme}`, { label: `Repositories Workspace (${theme})` });

      await v.nav("/runs");
      await v.waitRoute("/runs");
      await v.wait("runs-page");
      await v.assertClean(`dashboard-runs-${theme}`);
      await v.shot(`dashboard-runs-${theme}`, { label: `Runs & Trajectories (${theme})` });

      await v.nav("/agents");
      await v.waitRoute("/agents");
      await v.wait("agents-page");
      await v.assertClean(`agents-roster-${theme}`);
      await v.shot(`agents-roster-${theme}`, { label: `Agents Roster (${theme})` });

      await v.nav("/runtimes");
      await v.waitRoute("/runtimes");
      await v.wait("runtimes-page");
      await v.assertClean(`runtimes-list-${theme}`);
      await v.shot(`runtimes-list-${theme}`, { label: `Runtimes & Engines (${theme})` });
    });
  },
});
