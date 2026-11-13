// Pictures of the agents, templates, runtimes, skills and repos pages on
// their fixture (agents.story.tsx): `--target macos` (or `--target gpui` when the
// screen is unlocked); headless it only checks the pages came up.
import "../polyfill";
import { expect, open, test } from "nsh/test";

type Shot = { name: string; scheme: "light" | "dark"; width: number; height?: number; route?: string; skill?: string; ready: string };

const shots: Shot[] = [
  { name: "agents-light", route: "/agents", scheme: "light", width: 1200, ready: "agents-page" },
  { name: "agents-dark", route: "/agents", scheme: "dark", width: 1200, ready: "agents-page" },
  { name: "agents-narrow", route: "/agents", scheme: "light", width: 560, ready: "agents-page" },
  { name: "agent-light", route: "/agents/laozhou", scheme: "light", width: 1400, height: 820, ready: "agent-page" },
  { name: "agent-dark", route: "/agents/laozhou", scheme: "dark", width: 1400, height: 820, ready: "agent-page" },
  { name: "agent-narrow", route: "/agents/laozhou", scheme: "light", width: 560, height: 820, ready: "agent-page" },
  { name: "orchestrator-profile-light", route: "/agents/orchestrator", scheme: "light", width: 1200, ready: "orchestrator-profile" },
  { name: "templates-light", route: "/agents/templates", scheme: "light", width: 1200, ready: "templates-page" },
  { name: "templates-dark", route: "/agents/templates", scheme: "dark", width: 1200, ready: "templates-page" },
  { name: "runtimes-light", route: "/runtimes", scheme: "light", width: 1200, height: 900, ready: "runtime-detail" },
  { name: "runtimes-dark", route: "/runtimes", scheme: "dark", width: 1200, height: 900, ready: "runtime-detail" },
  { name: "runtimes-narrow", route: "/runtimes/vibevalley", scheme: "light", width: 560, height: 900, ready: "runtime-detail" },
  { name: "skills-light", skill: "review", scheme: "light", width: 1100, ready: "skills-book" },
  { name: "skills-dark", skill: "release-notes", scheme: "dark", width: 1100, ready: "skills-book" },
  { name: "repos-light", route: "/repos", scheme: "light", width: 1200, ready: "repos-page" },
  { name: "repo-light", route: "/repos/vibevalley", scheme: "light", width: 1200, height: 900, ready: "repo-overview" },
  { name: "repo-dark", route: "/repos/vibevalley", scheme: "dark", width: 1200, height: 900, ready: "repo-overview" },
  { name: "repo-narrow", route: "/repos/vibevalley", scheme: "light", width: 560, height: 900, ready: "repo-overview" },
];

for (const s of shots) {
  test(s.name, async () => {
    const app = await open("./agents.story.tsx", {
      width: s.width,
      height: s.height ?? 760,
      colorScheme: s.scheme,
      platform: "macos",
      host: { params: s.skill !== undefined ? { skill: s.skill } : { route: s.route } },
    });
    await app.waitFor(`id:${s.ready}`);
    expect(app.count(`id:${s.ready}`)).toBe(1);
    try {
      await app.screenshot(`vv/app/shots/${s.name}.png`);
    } catch (e) {
      // headless runs draw nothing; on a host, say why there is no picture
      console.log(`no picture of ${s.name}: ${String(e)}`);
    }
  });
}
