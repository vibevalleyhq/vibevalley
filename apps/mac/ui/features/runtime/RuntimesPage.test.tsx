import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type {
  MachineInfo,
  McpHostId,
  McpServerEntry,
  McpServerRemoveInput,
  McpServerSaveInput,
  McpServerToggleInput,
  RuntimeInfo,
  SessionsSlice,
  SliceBundle,
} from "@vibevalley/protocol";

import type { DesignHost } from "../../design/host";
import { fakeHost, type FakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";
import type { SlicesSource } from "../../infra/frame";

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

async function mountRoute(route: string, state: SliceBundle, configure?: (fake: FakeHost) => void, viewport = { width: 1200, height: 800 }) {
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route, locale: "en" });
  configure?.(fake);
  const app = await open("../../app/main.tsx", {
    width: viewport.width,
    height: viewport.height,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);
  return { app, fake };
}

test("RuntimesPage: top-level nav above Experts, 3-column full-height layout, machine-grouped, installed coding agents ONLY", async () => {
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

test("Navigation: Runtimes sits directly above Experts, Experts has no sub-tabs, and /skills + /memory redirect to Settings", async () => {
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

test("regression: narrow viewport (< 1024px) collapses inspector by default and keeps toggle smooth", async () => {
  setLocale("en");
  const { app, fake } = await mountRoute("/runtimes", scenarios.typical.state, undefined, { width: 900, height: 720 });
  await fake.pumpUntil(app, () => app.count("id:runtime-row-local-claude") === 1);

  expect(app.count("id:runtimes-sidebar")).toBe(1);
  expect(app.count("id:runtimes-main")).toBe(1);
  expect(app.count("id:runtimes-inspector")).toBe(0);
  expect(app.count("id:runtime-detail")).toBe(1);

  await app.press("id:runtimes-inspector-toggle");
  await fake.pump(app);
  expect(app.count("id:runtimes-inspector")).toBe(1);

  await app.press("id:runtimes-inspector-close");
  await fake.pump(app);
  expect(app.count("id:runtimes-inspector")).toBe(0);

  // Resizing below 1024px without an explicit toggle collapses the inspector; widening restores it.
  const wide = await mountRoute("/runtimes", scenarios.typical.state, undefined, { width: 1200, height: 800 });
  await wide.fake.pumpUntil(wide.app, () => wide.app.count("id:runtimes-inspector") === 1);
  await wide.app.setViewport(900, 720);
  await wide.fake.pump(wide.app);
  expect(wide.app.count("id:runtimes-inspector")).toBe(0);
  await wide.app.setViewport(1200, 800);
  await wide.fake.pump(wide.app);
  expect(wide.app.count("id:runtimes-inspector")).toBe(1);
});

test("regression: repeated /runtimes mount/unmount cycles keep subscription and timer counts flat", async () => {
  const { effect, signal } = await import("nsh");
  const { QueryProvider } = await import("../../infra/query");
  const { createQueryClient } = await import("../../infra/query/cache");
  const { RuntimesPage } = await import("./RuntimesPage");
  const { Router, Routes, route } = await import("../../infra/router");
  const { memoryHistory } = await import("../../infra/router/history");
  const { createSlices, SlicesContext } = await import("../../infra/frame");
  const { setTransport } = await import("../../infra/transport");
  const { DesignHostProvider } = await import("../../design/host");

  // 1. Full app route cycling via FakeHost: zero bridge subscriptions or duplicate slice watches per visit.
  setLocale("en");
  const { app, fake } = await mountRoute("/issues", scenarios.typical.state);
  const countWatchOrSubPosts = () =>
    (app.host.posts?.() ?? []).filter((p) => {
      const data = p.data;
      if (typeof data !== "object" || data === null || !("type" in data)) return false;
      return data.type === "watch" || data.type === "unwatch" || data.type === "subscribe" || data.type === "unsubscribe";
    }).length;
  const initialWatchPosts = countWatchOrSubPosts();
  expect(fake.subscriptions.size).toBe(0);

  for (let i = 0; i < 3; i++) {
    await app.host.send("route", "/runtimes");
    await fake.pumpUntil(app, () => app.count("id:runtimes-page") === 1);
    expect(fake.subscriptions.size).toBe(0);
    await app.host.send("route", "/issues");
    await fake.pumpUntil(app, () => app.count("id:issues-page") === 1);
    expect(fake.subscriptions.size).toBe(0);
  }
  expect(countWatchOrSubPosts()).toBe(initialWatchPosts);

  // 2. Direct QueryClient + Slices + timer accounting across repeated RuntimesPage mount/unmount cycles.
  const sliceListeners = new Map<string, Set<() => void>>();
  let linkSubs = 0;
  const mockSource: SlicesSource = {
    get: (kind) => scenarios.typical.state[kind],
    subscribe: (kind, fn) => {
      let set = sliceListeners.get(kind);
      if (!set) {
        set = new Set();
        sliceListeners.set(kind, set);
      }
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    refresh: () => {},
    link: () => "open",
    subscribeLink: (listener) => {
      linkSubs++;
      void listener;
      return () => {
        linkSubs--;
      };
    },
  };

  setTransport({
    call: async (op) => {
      if (op === "host.assetsDir") return { bizCode: 0, message: "ok", data: { path: "/tmp/assets" } };
      const responses: Record<string, unknown> = scenarios.typical.responses;
      return { bizCode: 0, message: "ok", data: responses[op] ?? [] };
    },
    slice: () => () => {},
    live: () => () => {},
  });

  const client = createQueryClient();
  let activeQuerySubs = 0;
  const wrappedClient: typeof client = {
    ...client,
    subscribe: (q, listener, demand) => {
      activeQuerySubs++;
      const handle = client.subscribe(q, listener, demand);
      let stopped = false;
      return {
        ...handle,
        stop: () => {
          if (!stopped) {
            stopped = true;
            activeQuerySubs--;
          }
          handle.stop();
        },
      };
    },
  };

  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const activeTimers = new Set<number>();
  globalThis.setTimeout = (fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const id = realSetTimeout(fn, ms, ...rest);
    activeTimers.add(id);
    return id;
  };
  globalThis.clearTimeout = (id?: number) => {
    if (id !== undefined) activeTimers.delete(id);
    realClearTimeout(id);
  };

  try {
    const alive = signal(true);
    const history = memoryHistory("/other");
    const fakeDesignHost: DesignHost = {
      openExternal: () => {},
      openFile: () => {},
      navigate: (p) => history.navigate(p),
      saveFile: () => Promise.resolve({ saved: false }),
      renderQr: () => Promise.resolve(undefined),
      toast: () => {},
      getPrefWidth: () => undefined,
      setPrefWidth: () => {},
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    };
    const routes = [
      { path: route("/other/*"), component: () => null },
      { path: route("/runtimes/*"), component: () => <RuntimesPage rest="" /> },
    ];
    effect(() => {
      if (!alive()) return;
      void DesignHostProvider({
        host: fakeDesignHost,
        get children() {
          return Router({
            history,
            get children() {
              return SlicesContext.Provider({
                value: createSlices(mockSource),
                get children() {
                  return QueryProvider({
                    client: wrappedClient,
                    get children() {
                      return Routes({
                        routes,
                        fallback: () => null,
                        invalid: () => null,
                      });
                    },
                  });
                },
              });
            },
          });
        },
      });
    });

    await new Promise((resolve) => realSetTimeout(resolve, 30));
    expect(activeQuerySubs).toBe(0);

    let baselineUnmountedTimers: number | undefined;
    for (let i = 0; i < 3; i++) {
      history.navigate("/runtimes");
      await new Promise((resolve) => realSetTimeout(resolve, 30));
      expect(activeQuerySubs).toBeGreaterThan(0);

      history.navigate("/other");
      await new Promise((resolve) => realSetTimeout(resolve, 30));
      expect(activeQuerySubs).toBe(0);
      const sliceCount = [...sliceListeners.values()].reduce((sum, set) => sum + set.size, 0);
      expect(sliceCount).toBe(1);
      expect(linkSubs).toBe(1);
      if (baselineUnmountedTimers === undefined) baselineUnmountedTimers = activeTimers.size;
      else expect(activeTimers.size).toBe(baselineUnmountedTimers);
    }
    alive.set(false);
    expect(activeTimers.size).toBe(0);
    expect(linkSubs).toBe(0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("i18n: runtime inventory unreported copy avoids literal fragment in zh and en", () => {
  setLocale("zh");
  expect(t("web.runtime.unreported")).toBe("当前引擎未上报这一项。");
  expect(t("web.runtime.none")).toBe("暂无。");
  setLocale("en");
  expect(t("web.runtime.unreported")).toBe("Not reported by this engine.");
  expect(t("web.runtime.none")).toBe("None.");
});

test("RuntimesPage: MCP InventoryCard displays real host entries and supports add, edit, toggle, remove, and error display", async () => {
  setLocale("en");
  let serversByHost: Record<McpHostId, McpServerEntry[]> = {
    antigravity: [
      {
        host: "antigravity",
        name: "linear",
        transport: "streamableHttp",
        args: [],
        env: {},
        url: "https://mcp.linear.app/mcp",
        headers: {},
        enabled: true,
        configPath: "/Users/test/.gemini/config/mcp_config.json",
      },
    ],
    claude: [
      {
        host: "claude",
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: {},
        headers: {},
        enabled: true,
        configPath: "/Users/test/.claude.json",
      },
    ],
    codex: [],
    cursor: [],
  };
  let failNextToggle = false;

  const { app, fake } = await mountRoute("/runtimes/local/claude", scenarios.typical.state, (f) => {
    f.respond("runtime.mcpServer.list", (payload: unknown) => {
      const { host } = payload as { host: McpHostId };
      return {
        host,
        configPath: serversByHost[host][0]?.configPath ?? `/Users/test/.${host}.json`,
        servers: serversByHost[host],
      };
    });
    f.respond("runtime.mcpServer.save", (payload: unknown) => {
      const input = payload as McpServerSaveInput;
      const list = serversByHost[input.host].filter((s) => s.name !== input.previousName && s.name !== input.name);
      const entry: McpServerEntry = {
        host: input.host,
        name: input.name,
        transport: input.transport,
        ...(input.command !== undefined ? { command: input.command } : {}),
        args: input.args,
        env: input.env,
        ...(input.url !== undefined ? { url: input.url } : {}),
        headers: input.headers,
        enabled: input.enabled,
        configPath: input.host === "claude" ? "/Users/test/.claude.json" : "/Users/test/.gemini/config/mcp_config.json",
      };
      serversByHost = { ...serversByHost, [input.host]: [...list, entry].toSorted((a, b) => a.name.localeCompare(b.name)) };
      return { host: input.host, configPath: entry.configPath, servers: serversByHost[input.host] };
    });
    f.respond("runtime.mcpServer.toggle", (payload: unknown) => {
      if (failNextToggle) {
        failNextToggle = false;
        return { bizCode: 100011, message: "corrupt config file" };
      }
      const input = payload as McpServerToggleInput;
      serversByHost = {
        ...serversByHost,
        [input.host]: serversByHost[input.host].map((s) => (s.name === input.name ? { ...s, enabled: input.enabled } : s)),
      };
      return { host: input.host, configPath: "/Users/test/.claude.json", servers: serversByHost[input.host] };
    });
    f.respond("runtime.mcpServer.remove", (payload: unknown) => {
      const input = payload as McpServerRemoveInput;
      serversByHost = {
        ...serversByHost,
        [input.host]: serversByHost[input.host].filter((s) => s.name !== input.name),
      };
      return { host: input.host, configPath: "/Users/test/.claude.json", servers: serversByHost[input.host] };
    });
  });

  await fake.pumpUntil(app, () => app.count("id:mcp-server-row-github") === 1);
  expect(app.shows("id:mcp-server-row-github >> text:github")).toBe(true);
  expect(app.shows("id:mcp-server-row-github >> text:stdio")).toBe(true);
  expect(app.shows("id:mcp-server-row-github >> text:npx -y @modelcontextprotocol/server-github")).toBe(true);
  expect(app.texts()).toContain("/Users/test/.claude.json");
  expect(app.shows("id:mcp-server-row-github >> text:enabled")).toBe(true);

  // Add a new streamableHttp MCP server via the dialog.
  await app.press("id:mcp-server-add");
  await fake.pumpUntil(app, () => app.count("id:mcp-server-dialog") === 1);
  await app.type("id:mcp-server-name", "context7");
  await app.press("id:mcp-server-transport-streamableHttp");
  await fake.pump(app);
  await app.type("id:mcp-server-url", "https://mcp.context7.com/mcp");
  await app.press("id:mcp-server-save");
  await fake.pumpUntil(app, () => app.count("id:mcp-server-row-context7") === 1);
  expect(app.shows("id:mcp-server-row-context7 >> text:http")).toBe(true);
  expect(app.texts()).toContain("https://mcp.context7.com/mcp");

  // Toggle disabled -> shows disabled tag; error path shows banner.
  await app.press("id:mcp-server-toggle-context7");
  await fake.pumpUntil(app, () => app.shows("id:mcp-server-row-context7 >> text:disabled"));

  failNextToggle = true;
  await app.press("id:mcp-server-toggle-context7");
  await fake.pumpUntil(app, () => app.count("id:mcp-server-error") === 1);
  expect(app.texts()).toContain("corrupt config file");

  // Edit existing entry (replace URL).
  await app.press("id:mcp-server-edit-context7");
  await fake.pumpUntil(app, () => app.count("id:mcp-server-dialog") === 1);
  await app.clear("id:mcp-server-url");
  await app.type("id:mcp-server-url", "https://mcp.context7.com/v2");
  await app.press("id:mcp-server-save");
  await fake.pumpUntil(app, () => app.texts().includes("https://mcp.context7.com/v2"));

  // Remove entry -> disappears from inventory card.
  await app.press("id:mcp-server-remove-context7");
  await fake.pumpUntil(app, () => app.count("id:mcp-server-row-context7") === 0);
});
