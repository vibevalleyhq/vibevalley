import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { MachineInfo, RuntimeInfo, SessionsSlice, SliceBundle } from "@vibevalley/protocol";

import { fakeHost, type FakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

type SliceMachine = SessionsSlice["machines"][number];

function withMachines(base: SliceBundle, machines: SliceMachine[]): SliceBundle {
  return {
    ...base,
    sessions: {
      ...base.sessions,
      machines,
    },
  };
}

async function mountRoute(route: string, state: SliceBundle, configure?: (fake: FakeHost) => void) {
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route, locale: "en" });
  configure?.(fake);
  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);
  return { app, fake };
}

test("RuntimesPage: top-level nav above Team, 3-column full-height layout, machine-grouped, installed coding agents ONLY", async () => {
  setLocale("en");
  const sliceMachines: SliceMachine[] = [
    {
      id: "gpu-linux",
      name: "GPU Linux Box",
      here: false,
      online: true,
      joinedAt: SCENARIO_NOW - 60_000,
      platform: "linux",
      status: "online",
      ephemeral: false,
      runtimes: ["codex", "claude"],
    },
    {
      id: "local",
      name: "Studio Mac",
      here: true,
      online: true,
      joinedAt: SCENARIO_NOW - 120_000,
      platform: "macos",
      status: "online",
      ephemeral: false,
      runtimes: ["claude", "opencode"],
    },
  ];
  const rpcMachines: MachineInfo[] = [
    {
      id: "local",
      name: "Studio Mac",
      platform: "macos",
      status: "online",
      here: true,
      ephemeral: false,
      worktreeSupported: true,
      joinedAt: SCENARIO_NOW - 120_000,
      runtimes: [
        { id: "claude", label: "Claude Code", models: [], capabilities: ["listModels"], available: true },
        { id: "opencode", label: "OpenCode", models: [], capabilities: [], available: true },
      ],
    },
    {
      id: "sbx-42",
      name: "CI Sandbox #42",
      platform: "container",
      status: "draining",
      here: false,
      ephemeral: true,
      worktreeSupported: true,
      joinedAt: SCENARIO_NOW - 10_000,
      runtimes: [
        { id: "opencode", label: "OpenCode", models: [], capabilities: ["listModels"], available: true },
        { id: "cursor", label: "Cursor", models: [], capabilities: [], available: false },
      ],
    },
    {
      id: "empty-host",
      name: "Idle Empty Host",
      platform: "linux",
      status: "online",
      here: false,
      ephemeral: false,
      worktreeSupported: false,
      joinedAt: SCENARIO_NOW - 5_000,
      runtimes: [{ id: "codex", label: "Codex", models: [], capabilities: [], available: false }],
    },
  ];

  const state = withMachines(scenarios.typical.state, sliceMachines);
  const { app, fake } = await mountRoute("/runtimes", state, (f) => {
    f.respond("machine.list", () => rpcMachines);
  });

  await fake.pumpUntil(app, () => app.count("id:machine-group-sbx-42") === 1);

  // Full-height 3-column layout: no top Desk bar; left sidebar, middle main, right inspector all present.
  expect(app.count("id:desk")).toBe(0);
  expect(app.count("id:place-runtimes")).toBe(1);
  expect(app.count("id:place-team")).toBe(1);
  expect(app.count("id:runtimes-sidebar")).toBe(1);
  expect(app.count("id:runtimes-main")).toBe(1);
  expect(app.count("id:runtimes-inspector")).toBe(1);

  // Machine groups rendered for machines that have installed coding agents.
  expect(app.count("id:machine-group-local")).toBe(1);
  expect(app.count("id:machine-group-gpu-linux")).toBe(1);
  expect(app.count("id:machine-group-sbx-42")).toBe(1);
  // Machine with 0 installed coding agents is hidden.
  expect(app.count("id:machine-group-empty-host")).toBe(0);

  // Local machine: claude, codex, vibevalley are available; opencode is not_found -> MUST NOT appear on local!
  expect(app.count("id:runtime-row-local-claude")).toBe(1);
  expect(app.count("id:runtime-row-local-codex")).toBe(1);
  expect(app.count("id:runtime-row-local-vibevalley")).toBe(1);
  expect(app.count("id:runtime-row-local-opencode")).toBe(0);
  expect(app.count("id:runtime-detail")).toBe(1);
  expect(app.count("id:runtime-bin-path")).toBe(1);
  expect(app.texts()).toContain(t("web.runtime.installation"));
  expect(app.texts()).toContain(t("web.runtime.available"));

  // Remote & sandbox machines: installed coding agents appear; unavailable cursor on sbx-42 MUST NOT appear!
  expect(app.count("id:runtime-row-gpu-linux-codex")).toBe(1);
  expect(app.count("id:runtime-row-gpu-linux-claude")).toBe(1);
  expect(app.count("id:runtime-row-sbx-42-opencode")).toBe(1);
  expect(app.count("id:runtime-row-sbx-42-cursor")).toBe(0);

  // Selecting a remote runtime updates both middle workspace header and right inspector machine card.
  await app.press("id:runtime-row-sbx-42-opencode");
  await fake.pump(app);
  expect(app.count("id:inspector-machine-sbx-42")).toBe(1);
  expect(app.texts()).toContain("CI Sandbox #42");
  expect(app.texts()).toContain(t("web.runtime.machines.kind.sandbox"));
  expect(app.texts()).toContain(t("web.runtime.machines.platform.container"));
  expect(app.texts()).toContain(t("web.runtime.machines.status.draining"));

  // Selecting GPU Linux Box runtime shows remote metadata and follows real-time slice status updates.
  await app.press("id:runtime-row-gpu-linux-codex");
  await fake.pump(app);
  expect(app.count("id:inspector-machine-gpu-linux")).toBe(1);
  expect(app.texts()).toContain(t("web.runtime.machines.kind.remote"));
  expect(app.texts()).toContain(t("web.runtime.machines.platform.linux"));
  expect(app.texts()).toContain(t("web.runtime.machines.status.online"));

  await fake.setSlice(app, "sessions", {
    ...state.sessions,
    seq: state.sessions.seq + 1,
    machines: [{ ...sliceMachines[1] }, { ...sliceMachines[0], online: false, status: "offline" }],
  });
  await fake.pumpUntil(app, () => app.texts().includes(t("web.runtime.machines.status.offline")));
  expect(app.texts()).toContain(t("web.runtime.machines.status.offline"));

  // Collapsing and expanding left sidebar + right inspector.
  await app.press("id:runtimes-sidebar-toggle");
  await fake.pump(app);
  expect(app.count("id:runtimes-sidebar")).toBe(0);
  expect(app.count("id:runtimes-sidebar-expand")).toBe(1);
  await app.press("id:runtimes-sidebar-expand");
  await fake.pump(app);
  expect(app.count("id:runtimes-sidebar")).toBe(1);

  await app.press("id:runtimes-inspector-toggle");
  await fake.pump(app);
  expect(app.count("id:runtimes-inspector")).toBe(0);
  await app.press("id:runtimes-inspector-toggle");
  await fake.pump(app);
  expect(app.count("id:runtimes-inspector")).toBe(1);
});

test("RuntimesPage: renders calm empty state when no coding agents are installed on any machine", async () => {
  setLocale("en");
  const allUninstalled = (scenarios.typical.responses["runtime.list"] as RuntimeInfo[]).map((r) => ({
    ...r,
    installation: { status: "not_found" as const },
  }));
  const state = withMachines(scenarios.typical.state, [
    {
      id: "local",
      name: "Studio Mac",
      here: true,
      online: true,
      joinedAt: SCENARIO_NOW - 120_000,
      platform: "macos",
      status: "online",
      ephemeral: false,
      runtimes: [],
    },
  ]);

  const { app, fake } = await mountRoute("/runtimes", state, (f) => {
    f.respond("runtime.list", () => allUninstalled);
    f.respond("machine.list", () => []);
  });

  await fake.pumpUntil(app, () => app.count("id:runtimes-empty") === 1);
  expect(app.count("id:runtimes-sidebar-empty")).toBe(1);
  expect(app.count("id:machine-group-local")).toBe(0);
  expect(app.texts()).toContain(t("web.runtime.noneInstalled"));
});

test("Navigation: Runtimes sits directly above Team, Team has no sub-tabs, and /skills + /memory redirect to Settings", async () => {
  setLocale("en");
  const { places } = await import("../../app/places");
  const runtimesIndex = places.findIndex((p) => p.id === "runtimes");
  const teamIndex = places.findIndex((p) => p.id === "team");
  expect(runtimesIndex).toBeGreaterThanOrEqual(0);
  expect(teamIndex).toBe(runtimesIndex + 1);

  const { app, fake } = await mountRoute("/agents", scenarios.typical.state);
  expect(app.count("id:agents-page")).toBe(1);
  expect(app.count("id:place-runtimes")).toBe(1);
  expect(app.count("id:place-team")).toBe(1);
  expect(app.count("id:tab-team-runtimes")).toBe(0);
  expect(app.count("id:tab-team-skills")).toBe(0);
  expect(app.count("id:tab-team-memory")).toBe(0);

  await app.host.send("route", "/skills");
  await fake.pumpUntil(app, () => app.count("id:skills-book") === 1);
  expect(app.count("id:settings-skills")).toBe(1);

  await app.host.send("route", "/team/skills");
  await fake.pumpUntil(app, () => app.count("id:skills-book") === 1);
  expect(app.count("id:settings-skills")).toBe(1);

  await app.host.send("route", "/memory");
  await fake.pumpUntil(app, () => app.count("id:settings-memory") === 1);

  await app.host.send("route", "/team/memory");
  await fake.pumpUntil(app, () => app.count("id:settings-memory") === 1);
});
