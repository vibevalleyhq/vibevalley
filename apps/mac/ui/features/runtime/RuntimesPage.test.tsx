import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { MachineInfo, SessionsSlice, SliceBundle } from "@vibevalley/protocol";

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

test("RuntimesPage: renders Execution Machines strip with local, remote, and ephemeral sandbox hosts", async () => {
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
      runtimes: ["claude"],
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
        { id: "claude", label: "Claude Code", models: [], capabilities: [], available: true },
        { id: "codex", label: "Codex", models: [], capabilities: [], available: false },
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
      runtimes: [{ id: "opencode", label: "OpenCode", models: [], capabilities: [], available: true }],
    },
  ];

  const state = withMachines(scenarios.typical.state, sliceMachines);
  const { app, fake } = await mountRoute("/runtimes", state, (f) => {
    f.respond("machine.list", () => rpcMachines);
  });

  await fake.pumpUntil(app, () => app.count("id:execution-machines") === 1 && app.count("id:machine-card-sbx-42") === 1);
  expect(app.count("id:machine-card-local")).toBe(1);
  expect(app.count("id:machine-card-gpu-linux")).toBe(1);
  expect(app.count("id:machine-card-sbx-42")).toBe(1);

  const texts = app.texts();
  expect(texts).toContain(t("web.runtime.machines.title"));
  expect(texts).toContain("Studio Mac");
  expect(texts).toContain("GPU Linux Box");
  expect(texts).toContain("CI Sandbox #42");
  expect(texts).toContain(t("web.runtime.machines.kind.local"));
  expect(texts).toContain(t("web.runtime.machines.kind.remote"));
  expect(texts).toContain(t("web.runtime.machines.kind.sandbox"));
  expect(texts).toContain(t("web.runtime.machines.platform.macos"));
  expect(texts).toContain(t("web.runtime.machines.platform.linux"));
  expect(texts).toContain(t("web.runtime.machines.platform.container"));
  expect(texts).toContain(t("web.runtime.machines.status.online"));
  expect(texts).toContain(t("web.runtime.machines.status.draining"));
  expect(texts).toContain("opencode");

  await fake.setSlice(app, "sessions", {
    ...state.sessions,
    seq: state.sessions.seq + 1,
    machines: [{ ...sliceMachines[1] }, { ...sliceMachines[0], online: false, status: "offline" }],
  });
  await fake.pumpUntil(app, () => app.texts().includes(t("web.runtime.machines.status.offline")));
  expect(app.texts()).toContain(t("web.runtime.machines.status.offline"));
});
