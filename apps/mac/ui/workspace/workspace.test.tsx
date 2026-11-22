import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { RuntimeInfo } from "@vibevalley/protocol";

import type { FilesFrame } from "./FileTree";
import type { GitFrame } from "./GitPanel";

type App = Awaited<ReturnType<typeof open>>;

function workspaceHost(params: Record<string, unknown>, rpcResponses: Record<string, unknown> = {}, deferOps: readonly string[] = []) {
  const queue: [string, unknown][] = [];
  const heldReplies: [string, unknown][] = [];
  const acts: { type: string; [key: string]: unknown }[] = [];
  const calls: { op: string; payload: unknown }[] = [];
  const subscriptions = new Map<string, { name: string; payload: unknown }>();
  const pixelDir = decodeURI(new URL("../../../../assets/pixel", import.meta.url).pathname);
  const responses: Record<string, unknown> = {
    "host.pixelDir": { path: pixelDir },
    "repo.list": [],
    ...rpcResponses,
  };
  let rev = 0;

  const action = (data: unknown) => {
    const a = data as { type: string; id?: string; op?: string; name?: string; payload?: unknown };
    if (a.type === "call") {
      const op = a.op ?? "";
      calls.push({ op, payload: a.payload });
      const answer = op in responses ? responses[op] : null;
      const body = typeof answer === "function" ? (answer as (p: unknown) => unknown)(a.payload) : answer;
      const reply: [string, unknown] = [`reply:${a.id}`, { bizCode: 0, message: "ok", data: body }];
      if (deferOps.includes(op)) heldReplies.push(reply);
      else queue.push(reply);
    } else if (a.type === "subscribe" && a.id !== undefined) {
      subscriptions.set(a.id, { name: a.name ?? "", payload: a.payload });
    } else if (a.type === "unsubscribe" && a.id !== undefined) {
      subscriptions.delete(a.id);
    } else if (!["watch", "unwatch", "applied", "ready"].includes(a.type)) {
      acts.push(a);
    }
    return null;
  };

  const pump = async (app: App) => {
    for (let round = 0; round < 30 && queue.length > 0; round++) {
      for (const [name, data] of queue.splice(0)) await app.host.send(name, data);
    }
  };

  const releaseDeferred = async (app: App) => {
    queue.push(...heldReplies.splice(0));
    await pump(app);
  };

  const pushFrame = async (app: App, topic: string, data: unknown) => {
    await app.host.send(`frame:${topic}`, { rev: ++rev, data });
    await pump(app);
  };

  const emitSub = async (app: App, name: string, event: unknown) => {
    for (const [id, sub] of subscriptions) {
      if (sub.name === name) queue.push([`sub:${id}`, { event }]);
    }
    await pump(app);
  };

  return {
    options: { params: { pixelDir, ...params }, handlers: { action, ready: null } },
    acts,
    calls,
    subscriptions,
    clearActs: () => {
      acts.length = 0;
    },
    clearCalls: () => {
      calls.length = 0;
    },
    pump,
    releaseDeferred,
    pushFrame,
    emitSub,
  };
}

test("workspace sidebar renders repos, tabs, collapse toggle, and posts project/tab actions", async () => {
  const host = workspaceHost(
    { view: "sidebar" },
    {
      "repo.list": [{ name: "vibevalley", path: "/work/vibevalley", git: true }],
    },
  );
  const app = await open("../App.story.tsx", { width: 280, height: 760, colorScheme: "light", platform: "macos", host: host.options });
  await host.pump(app);

  await host.pushFrame(app, "slice:board", { seq: 1, issues: [] });
  await host.pushFrame(app, "slice:sessions", { seq: 1, sessions: [], machines: [] });
  const repoListCallsAfterFirstState = host.calls.filter((c) => c.op === "repo.list").length;
  await host.pushFrame(app, "slice:board", { seq: 2, issues: [] });
  await host.pushFrame(app, "slice:sessions", { seq: 2, sessions: [], machines: [] });
  expect(host.calls.filter((c) => c.op === "repo.list").length).toBe(repoListCallsAfterFirstState);
  await host.pushFrame(app, "rail", {
    panel: "files",
    projects: [
      {
        id: 1,
        name: "vibevalley",
        path: "/work/vibevalley",
        initials: "VV",
        active: true,
        attention: false,
        terminals: 1,
        shortcut: "⌘1",
        branch: "main",
        tabs: [
          { id: 101, title: "zsh", active: true, kind: "terminal", running: true, runningState: "working", runningAgent: "codex" },
          { id: 102, title: "README.md", active: false, kind: "file" },
          { id: 103, title: "Antigravity", active: false, kind: "chat", running: true, runningState: "working", runningAgent: "antigravity", attention: true },
          { id: 104, title: "Claude Code", active: false, kind: "chat", running: false, runningState: "ready", runningAgent: "claude" },
        ],
      },
      {
        id: 2,
        name: "notes",
        path: "/tmp/notes",
        initials: "NO",
        active: false,
        attention: false,
        terminals: 0,
        shortcut: null,
        tabs: [],
      },
    ],
  });

  expect(app.count("id:workspace-sidebar")).toBe(1);
  expect(app.texts()).toContain("vibevalley");
  expect(app.texts()).toContain("README.md");
  expect(app.texts()).toContain("Antigravity");
  expect(app.texts()).toContain("notes");
  expect(app.texts()).not.toContain("其他文件夹");
  expect(app.texts()).not.toContain("Other folders");

  host.clearActs();
  await app.press("text:README.md");
  expect(host.acts).toContainEqual({ type: "activate_tab", path: "/work/vibevalley", tab_id: 102 });

  await app.press("text:Antigravity");
  expect(host.acts).toContainEqual({ type: "activate_tab", path: "/work/vibevalley", tab_id: 103 });

  await app.hover("text:vibevalley");
  await app.press(`label:${t("web.shell.sidebar.newChat", { name: "vibevalley" })}`);
  expect(host.acts).toContainEqual({ type: "new_chat_at", path: "/work/vibevalley" });

  await app.press("text:notes");
  expect(host.acts).toContainEqual({ type: "activate_path", path: "/tmp/notes" });

  await app.press(`label:${t("web.shell.sidebar.manageRepos")}`);
  expect(host.acts).toContainEqual({ type: "open_route", path: "/repos" });

  await app.press(`label:${t("web.shell.sidebar.addRepo")}`);
  expect(host.acts).toContainEqual({ type: "add_project" });

  expect(app.count("id:sidebar-tab-working-101")).toBe(1);
  expect(app.count("id:sidebar-tab-working-103")).toBe(1);
  expect(app.count("id:sidebar-tab-attention-103")).toBe(1);
  expect(app.count("id:sidebar-tab-ready-104")).toBe(1);
  expect(app.count("id:sidebar-tab-more-102")).toBe(0);

  await app.hover("text:README.md");
  expect(app.count(`label:${t("web.shell.sidebar.closeTab")}`)).toBe(0);
  expect(app.count("id:sidebar-tab-more-102")).toBe(1);
  host.clearActs();
  await app.press("id:sidebar-tab-more-102");
  expect(app.count("id:sidebar-tab-menu-chat-102")).toBe(1);
  expect(app.count("id:sidebar-tab-menu-term-102")).toBe(1);
  expect(app.count("id:sidebar-tab-menu-close-102")).toBe(1);
  await app.press("id:sidebar-tab-menu-close-102");
  expect(host.acts).toContainEqual({ type: "close_tab_at", path: "/work/vibevalley", tab_id: 102 });

  await app.press(`label:${t("web.shell.sidebar.collapseAll")}`);
  expect(app.texts()).not.toContain("README.md");
  await app.press(`label:${t("web.shell.sidebar.expandCurrent")}`);
  expect(app.texts()).toContain("README.md");
});

test("workspace inspector FileTree expands, collapses, opens files, and handles context menus", async () => {
  const host = workspaceHost({ view: "sidebar", role: "inspector" });
  const app = await open("../App.story.tsx", { width: 320, height: 760, colorScheme: "light", platform: "macos", host: host.options });
  await host.pump(app);

  const initialFiles: FilesFrame = {
    root: "/work/app",
    name: "app",
    expanded: [],
    selected: null,
    items: [
      { id: "/work/app/src", label: "src", tone: "dirty", children: [{ id: "/work/app/src/__loading", label: "…", tone: "placeholder" }] },
      { id: "/work/app/README.md", label: "README.md", tone: "modified" },
    ],
  };
  await host.pushFrame(app, "rail", { panel: "files", projects: [] });
  await host.pushFrame(app, "files", initialFiles);

  expect(app.count("id:workspace-inspector")).toBe(1);
  expect(app.texts()).toContain("src");
  expect(app.texts()).toContain("README.md");

  host.clearActs();
  await app.press("text:src");
  expect(host.acts).toContainEqual({ type: "expand_dir", path: "/work/app/src" });

  await host.pushFrame(app, "files", {
    ...initialFiles,
    expanded: ["/work/app/src"],
    items: [
      {
        id: "/work/app/src",
        label: "src",
        tone: "dirty",
        children: [{ id: "/work/app/src/index.ts", label: "index.ts", tone: "added" }],
      },
      { id: "/work/app/README.md", label: "README.md", tone: "modified" },
    ],
  } satisfies FilesFrame);
  expect(app.texts()).toContain("index.ts");

  await app.press(`label:${t("web.shell.fileTree.collapseAllDirs")}`);
  expect(host.acts).toContainEqual({ type: "collapse_dir", path: "/work/app/src" });

  await app.press("text:README.md");
  expect(host.acts).toContainEqual({ type: "open_file", path: "/work/app/README.md" });

  await app.rightClick("text:README.md");
  expect(app.shows(`text:${t("web.shell.fileTree.copyRelPath")}`)).toBe(true);
  expect(app.shows(`text:${t("web.shell.fileTree.newTerminalInDir")}`)).toBe(true);
  await app.press(`text:${t("web.shell.fileTree.copyRelPath")}`);
  expect(app.clipboard()).toBe("README.md");

  await app.rightClick("text:README.md");
  await app.press(`text:${t("web.shell.fileTree.newTerminalInDir")}`);
  expect(host.acts).toContainEqual({ type: "new_terminal_at", path: "/work/app" });
});

test("workspace inspector GitPanel drives changes, staging/commit, branches, and commits tabs", async () => {
  const host = workspaceHost({ view: "sidebar", role: "inspector" });
  const app = await open("../App.story.tsx", { width: 340, height: 820, colorScheme: "light", platform: "macos", host: host.options });
  await host.pump(app);

  const gitFrame: GitFrame = {
    repo: true,
    branch: "main",
    ahead: 1,
    behind: 0,
    conflicts: [{ path: "src/conflict.rs", code: "UU", tone: "conflict" }],
    staged: [{ path: "src/staged.rs", code: "M", tone: "modified" }],
    changes: [{ path: "src/dirty.rs", code: "M", tone: "modified" }],
    branches: [
      { name: "main", head: true, upstream: "origin/main" },
      { name: "feat/tests", head: false, upstream: null },
    ],
    log: [{ id: "abc1234567", short: "abc1234", summary: "Fix sidebar panel", author: "Lucas", time: Math.floor(Date.now() / 1000) - 30 }],
  };
  await host.pushFrame(app, "rail", { panel: "git", projects: [] });
  await host.pushFrame(app, "git", gitFrame);

  expect(app.texts()).toContain("staged.rs");
  expect(app.texts()).toContain("dirty.rs");
  expect(app.texts()).toContain("conflict.rs");

  host.clearActs();
  await app.press("label:Open diff of src/dirty.rs");
  expect(host.acts).toContainEqual({ type: "open_diff", path: "src/dirty.rs", staged: false });

  await app.hover("label:Open diff of src/dirty.rs");
  await app.press(`label:${t("web.shell.git.stagePath", { path: "src/dirty.rs" })}`);
  expect(host.acts).toContainEqual({ type: "stage", paths: ["src/dirty.rs"] });

  await app.type(`text:${t("web.shell.git.commitPlaceholder")}`, "Refine workspace tests");
  await app.press(`text:${t("web.shell.git.commitStaged", { count: 1 })}`);
  expect(host.acts).toContainEqual({ type: "commit", message: "Refine workspace tests" });

  await app.press(`label:${t("web.shell.sidebar.gitBranches")}`);
  expect(app.texts()).toContain("feat/tests");
  await app.press(`label:${t("web.shell.git.switchBranch", { name: "feat/tests" })}`);
  expect(host.acts).toContainEqual({ type: "checkout", branch: "feat/tests" });

  await app.press(`label:${t("web.shell.sidebar.gitCommits")}`);
  await app.press("label:Commit abc1234: Fix sidebar panel");
  expect(host.acts).toContainEqual({ type: "open_commit", id: "abc1234567" });
});

test("workspace Palette handles commands filter/select/close and remote search/files queries", async () => {
  const host = workspaceHost({ view: "palette" });
  const app = await open("../App.story.tsx", { width: 640, height: 420, colorScheme: "light", platform: "macos", host: host.options });
  await host.pump(app);

  await host.pushFrame(app, "palette", {
    mode: "commands",
    query: "",
    loading: false,
    note: null,
    items: [
      { id: "cmd-issue", label: "New issue", section: "Actions" },
      { id: "cmd-farm", label: "Open farm", section: "Navigation", detail: "Switch view" },
    ],
  });
  expect(app.count("id:palette-root")).toBe(1);
  expect(app.texts()).toContain("New issue");
  expect(app.texts()).toContain("Open farm");

  await app.type(`text:${t("web.shell.palette.placeholder.commands")}`, "farm");
  expect(app.texts()).not.toContain("New issue");
  await app.press("text:Open farm");
  expect(host.acts).toContainEqual({ type: "palette_select", id: "cmd-farm" });

  await app.keyboard.press("escape");
  expect(app.texts()).toContain("New issue");
  await app.keyboard.press("escape");
  expect(host.acts).toContainEqual({ type: "palette_close" });

  host.clearActs();
  await host.pushFrame(app, "palette", {
    mode: "files",
    query: "",
    loading: true,
    note: null,
    items: [{ id: "f1", label: "App.tsx", detail: "apps/mac/ui" }],
  });
  expect(app.texts()).toContain(t("web.shell.palette.searching"));
  await app.type("id:palette-root", "Sidebar");
  expect(host.acts).toContainEqual({ type: "palette_query", query: "Sidebar" });

  host.clearActs();
  await host.pushFrame(app, "palette", {
    mode: "search",
    query: "",
    loading: false,
    note: "No code hits",
    items: [],
  });
  expect(app.texts()).toContain("No code hits");
  await app.clear("id:palette-root");
  await app.type("id:palette-root", "TODO");
  expect(host.acts).toContainEqual({ type: "search", query: "TODO" });
});

test("workspace MarkdownPane renders delayed skeleton, pushed markdown documents, and error states", async () => {
  const host = workspaceHost({ view: "markdown" });
  const app = await open("../App.story.tsx", {
    width: 720,
    height: 600,
    colorScheme: "light",
    platform: "macos",
    clock: { time: 1_700_000_000_000 },
    host: host.options,
  });
  const clock = app.clock;
  if (!clock) throw new Error("MarkdownPane skeleton test requires a manual virtual clock");
  await host.pump(app);

  expect(app.count("id:markdown-pane")).toBe(1);
  expect(app.count("id:markdown-pane-skeleton")).toBe(0);
  expect(app.texts()).not.toContain("Loading preview…");

  await clock.fastForward(160);
  await host.pump(app);
  expect(app.count("id:markdown-pane-skeleton")).toBe(1);

  await host.pushFrame(app, "doc", { path: "README.md", markdown: "# Architecture\n\nRendered paragraph body." });
  expect(app.count("id:markdown-pane-skeleton")).toBe(0);
  expect(app.texts().some((s) => s.includes("Architecture"))).toBe(true);
  expect(app.texts().some((s) => s.includes("Rendered paragraph body."))).toBe(true);

  await host.pushFrame(app, "doc", { path: "missing.md", markdown: null, error: "File disappeared on disk" });
  expect(app.count("id:markdown-pane-skeleton")).toBe(0);
  expect(app.texts()).toContain("File disappeared on disk");
});

test("workspace ChatPane drives openWorkspace, session.watch, tool adjacent open, interaction_*, mid-turn steer, and telemetry", async () => {
  const baseSession = {
    id: "sess-ws-1",
    controller: "user" as const,
    name: "Antigravity",
    runtime: "antigravity",
    brief: "Workspace chat",
    cwd: "/work/vibevalley",
    policy: { kind: "directCwd" as const, repo: "vibevalley", permissionMode: "acceptEdits" as const },
    bindings: [],
    hiredAt: 1_700_000_000_000,
    runs: 1,
    phase: { _tag: "working" as const, since: 1_700_000_000_000, doing: { action: "thinking" as const, label: "Analyzing" } },
  };
  const host = workspaceHost(
    { view: "workspace-chat", tabId: 42, runtime: "antigravity", cwd: "/work/vibevalley", repo: "vibevalley" },
    {
      "runtime.list": [
        {
          id: "antigravity",
          preset: {
            id: "antigravity",
            label: "Antigravity",
            blurb: "ACP",
            look: { species: null, outfit: null, orchestrator: null, build: "biped", head: "rounded", body: "blue", trim: "navy", hat: "slate", eye: "ink" },
          },
          support: { steer: true, refused: {}, capabilities: ["listModels"], inProcess: false, inSessionConfig: true },
          installation: { status: "available", via: "executable", command: "agy", version: "1.5.14" },
          models: [{ id: "gemini-4-neon", name: "Gemini 4 Neon", effortLevels: ["low", "medium", "high", "xhigh"], defaultEffort: "high", isDefault: true }],
          usage: null,
          skills: null,
          mcpServers: null,
          tools: null,
          settings: { enabled: true, binPath: "", defaultModel: "gemini-4-neon", defaultEffort: "high", env: {} },
          quota: { left: 0.74, text: "5h window" },
          stop: "ok",
          checkedAt: 1_700_000_000_000,
        },
      ] satisfies RuntimeInfo[],
      "session.openWorkspace": {
        id: "sess-ws-1",
        session: baseSession,
        model: "gemini-4-neon",
        effort: "high",
        permissionMode: "acceptEdits",
      },
      "session.send": baseSession,
      "session.setConfig": {
        id: "sess-ws-1",
        session: baseSession,
        model: "gemini-4-neon",
        effort: "xhigh",
        permissionMode: "acceptEdits",
      },
      "session.respondInteraction": null,
      "session.respondPermission": null,
      "session.stop": null,
      "host.pickFile": { path: "/work/vibevalley/src/main.rs", name: "main.rs", type: "text/plain", size: 1200 },
    },
  );

  const app = await open("../App.story.tsx", { width: 820, height: 760, colorScheme: "light", platform: "macos", host: host.options });
  await host.pump(app);

  expect(app.count("id:workspace-chat-pane")).toBe(1);
  expect(app.count("id:chat-empty")).toBe(1);

  await app.type("id:chat-composer-input", "Inspect acp.rs");
  await app.press("id:chat-send");
  await host.pump(app);

  expect(host.calls.some((c) => c.op === "session.openWorkspace")).toBe(true);
  expect(host.calls.some((c) => c.op === "session.send")).toBe(true);
  expect(host.acts.some((a) => a.type === "bind_chat_session" && a.tab_id === 42 && a.session_id === "sess-ws-1")).toBe(true);
  expect([...host.subscriptions.values()].some((s) => s.name === "session.watch")).toBe(true);

  host.clearActs();
  await host.emitSub(app, "session.watch", {
    kind: "state",
    session: baseSession,
    title: "Upgrade Antigravity ACP",
    model: "gemini-4-neon",
    effort: "high",
    permissionMode: "acceptEdits",
    pendingPermissions: [{ requestId: "perm-1", tool: "run_command", summary: "cargo test -p vibevalley-runtime", input: '{"command":"cargo test"}' }],
    pendingInteractions: [
      {
        requestId: "interaction_01",
        question: "How should silent step_type=17 errors be reported?",
        options: [
          { id: "opt-err", label: "Surface as RunError", description: "Preserve context for retry" },
          { id: "opt-warn", label: "Warn only", warning: "May hide quota failures" },
        ],
        allowCustom: true,
      },
    ],
    tokens: { input: 76_000, cacheRead: 62_400, output: 6_800, reasoning: 2_000, contextUsed: 76_000, contextWindow: 200_000 },
  });
  await host.emitSub(app, "session.watch", {
    kind: "history",
    session: "sess-ws-1",
    events: [
      { seq: 1, revision: 1, time: 1_700_000_001_000, type: "user/message", text: "Inspect acp.rs" },
      { seq: 2, revision: 1, time: 1_700_000_002_000, type: "assistant/thinking", text: "Checking ACP v2 handshake" },
      {
        seq: 3,
        revision: 1,
        time: 1_700_000_003_000,
        type: "tool/call",
        action: "edit_file",
        actionText: "Edit",
        tool: "replace_file_content",
        text: "crates/runtime/src/oar/acp/mod.rs",
        input: JSON.stringify({ path: "crates/runtime/src/oar/acp/mod.rs", line: 136 }),
      },
      { seq: 4, revision: 1, time: 1_700_000_004_000, type: "tool/result", call: 3, ok: true, text: "", output: "updated 42 lines" },
      { seq: 5, revision: 1, time: 1_700_000_005_000, type: "assistant/message", text: "Updated ACP driver." },
    ],
  });
  await host.pump(app);

  expect(host.acts.some((a) => a.type === "update_chat_tab")).toBe(false);
  expect(app.count("id:chat-header-title")).toBe(0);
  expect(app.count("id:chat-permission-mode")).toBe(1);

  host.clearActs();
  await app.press("id:chat-tool-open-file-3");
  await app.press("id:chat-tool-open-diff-3");
  expect(host.acts).toContainEqual({ type: "open_file_adjacent", path: "crates/runtime/src/oar/acp/mod.rs", line: 136 });
  expect(host.acts).toContainEqual({ type: "open_diff_adjacent", path: "crates/runtime/src/oar/acp/mod.rs", staged: false });

  expect(app.count("id:chat-permission-perm-1")).toBe(1);
  expect(app.count("id:chat-interaction-interaction_01")).toBe(1);

  host.clearCalls();
  await app.press("id:chat-permission-once-perm-1");
  await host.pump(app);
  expect(host.calls).toContainEqual({
    op: "session.respondPermission",
    payload: { id: "sess-ws-1", requestId: "perm-1", decision: "allowOnce" },
  });

  await app.type("id:chat-interaction-custom-interaction_01", "Retry once on 429");
  await app.press("id:chat-interaction-confirm-interaction_01");
  await host.pump(app);
  expect(host.calls).toContainEqual({
    op: "session.respondInteraction",
    payload: { id: "sess-ws-1", requestId: "interaction_01", text: "Retry once on 429" },
  });
  expect(app.count("id:chat-interaction-interaction_01")).toBe(0);

  expect(app.count("id:chat-steering-banner")).toBe(1);
  expect(app.count("id:chat-composer-card")).toBe(1);
  expect(app.count("id:chat-composer-attachments")).toBe(0);
  host.clearCalls();
  await app.press("id:chat-thought-level");
  expect(app.count("id:chat-thought-level-xhigh")).toBe(1);
  await app.press("id:chat-thought-level-xhigh");
  await host.pump(app);
  expect(host.calls).toContainEqual({ op: "session.setConfig", payload: { id: "sess-ws-1", effort: "xhigh" } });

  await app.press("id:chat-attach-file");
  await host.pump(app);
  expect(app.count("id:chat-composer-attachments")).toBe(1);
  expect(app.count("id:chat-attachment-main.rs")).toBe(1);

  await app.type("id:chat-composer-input", "Keep diff minimal");
  await app.press("id:chat-send");
  await host.pump(app);
  expect(host.calls).toContainEqual({
    op: "session.send",
    payload: { id: "sess-ws-1", text: "Keep diff minimal", contextFiles: [{ path: "/work/vibevalley/src/main.rs" }] },
  });
  expect(app.count("id:chat-composer-attachments")).toBe(0);

  expect(app.count("id:chat-telemetry-drawer")).toBe(0);
  expect(app.count("id:chat-telemetry-toggle")).toBe(1);
  expect(app.texts()).not.toContain(t("web.shell.chat.telemetryDetails"));
  await app.press("id:chat-telemetry-toggle");
  await host.pump(app);
  expect(app.count("id:chat-telemetry-drawer")).toBe(1);
  expect(app.texts()).toContain(t("web.shell.chat.telemetryCacheTitle"));
  await app.press("id:chat-telemetry-toggle");
  await host.pump(app);
  expect(app.count("id:chat-telemetry-drawer")).toBe(0);

  const freshHost = workspaceHost({ view: "workspace-chat", tabId: 43, runtime: "antigravity", cwd: "/work/vibevalley" }, { "runtime.list": [] });
  const freshApp = await open("../App.story.tsx", { width: 400, height: 760, colorScheme: "light", platform: "macos", host: freshHost.options });
  await freshHost.pump(freshApp);
  expect(freshApp.count("id:chat-telemetry-toggle")).toBe(0);
  expect(freshApp.count("id:chat-swarm-pill")).toBe(0);
  expect(freshApp.count("id:chat-cwd-chip")).toBe(1);
});

test("workspace SwarmPanel hides pill when absent, switches Overview/Roster/Board tabs, filters board, and loads child transcripts", async () => {
  const baseSession = {
    id: "sess-swarm-1",
    controller: "user" as const,
    name: "Antigravity",
    runtime: "antigravity",
    brief: "Swarm run",
    cwd: "/work/vibevalley",
    policy: { kind: "directCwd" as const, repo: "vibevalley", permissionMode: "acceptEdits" as const },
    bindings: [],
    hiredAt: 1_700_000_000_000,
    runs: 1,
    phase: { _tag: "working" as const, since: 1_700_000_000_000, doing: { action: "thinking" as const, label: "Coordinating" } },
  };
  const host = workspaceHost(
    { view: "workspace-chat", tabId: 50, sessionId: "sess-swarm-1", runtime: "antigravity", cwd: "/work/vibevalley" },
    {
      "runtime.list": [],
      "session.childTranscript": {
        conversationId: "conv-worker-1",
        steps: [
          {
            stepIndex: 1,
            source: "transcript",
            kind: "planner",
            model: "gemini-4-neon",
            thinking: "Reading swarm files",
            content: "Implemented antigravity_swarm.rs reader.",
            toolCalls: [{ name: "edit_file", args: "antigravity_swarm.rs" }],
            inputTokens: 4_200,
            outputTokens: 640,
          },
        ],
      },
    },
    ["session.childTranscript"],
  );

  const app = await open("../App.story.tsx", {
    width: 820,
    height: 760,
    colorScheme: "light",
    platform: "macos",
    clock: { time: 1_700_000_000_000 },
    host: host.options,
  });
  const clock = app.clock;
  if (!clock) throw new Error("SwarmPanel test requires a manual virtual clock");
  await host.pump(app);

  await host.emitSub(app, "session.watch", {
    kind: "state",
    session: baseSession,
    permissionMode: "acceptEdits",
    pendingPermissions: [],
    pendingInteractions: [],
  });
  expect(app.count("id:chat-swarm-pill")).toBe(0);

  await host.emitSub(app, "session.watch", {
    kind: "state",
    session: baseSession,
    permissionMode: "acceptEdits",
    pendingPermissions: [],
    pendingInteractions: [],
    swarm: {
      swarmId: "swarm-1",
      title: "Antigravity Swarm V1",
      workingCount: 1,
      activeCount: 3,
      members: [
        {
          name: "coordinator",
          conversationId: "conv-coord",
          role: "coordinator",
          state: "waiting",
          wakeMode: "mentions",
          waitSince: 2,
          model: "gemini-4-neon",
        },
        {
          name: "content-hub",
          conversationId: "conv-worker-1",
          role: "worker",
          state: "working",
          model: "gemini-4-neon",
          workspaceMode: "inherit",
          task: "Build antigravity_swarm.rs",
        },
        { name: "verifier", conversationId: "conv-worker-2", role: "worker", state: "stopped", model: "gemini-4-neon" },
      ],
      overview: {
        goalTitle: "Ship Antigravity Swarm V1",
        goalLine: "OAR + Protocol + Workspace ChatUI",
        threads: [{ id: "t1", title: "Runtime & UI", goal: "Read-only swarm state", members: ["content-hub", "verifier"] }],
        tasks: { "content-hub": "Implement bounded sidecar reader", verifier: "Live GPUI verification" },
      },
      messages: [
        { seq: 1, agent: "coordinator", text: "@content-hub Implement sidecar reader for #171", time: "2026-11-22 13:50:00", kind: "brief" },
        { seq: 2, agent: "content-hub", text: "@coordinator [done] Reader ready per @all", time: "2026-11-22 13:51:00" },
      ],
      totalMessages: 2,
    },
  });

  expect(app.count("id:chat-swarm-pill")).toBe(1);
  expect(app.texts()).toContain("Swarm · 1/3");
  expect(app.count("id:chat-swarm-panel")).toBe(0);

  await app.press("id:chat-swarm-pill");
  expect(app.count("id:chat-swarm-panel")).toBe(1);
  expect(app.count("id:swarm-overview")).toBe(1);
  expect(app.texts()).toContain("Ship Antigravity Swarm V1");
  expect(app.count("id:swarm-thread-t1")).toBe(1);

  await app.press("id:swarm-tab-board");
  expect(app.count("id:swarm-board")).toBe(1);
  expect(app.count("id:swarm-msg-1")).toBe(1);
  expect(app.count("id:swarm-msg-2")).toBe(1);

  await app.press("id:swarm-board-filter-content-hub");
  expect(app.count("id:swarm-msg-1")).toBe(0);
  expect(app.count("id:swarm-msg-2")).toBe(1);

  await app.press("id:swarm-msg-agent-2");
  expect(app.count("id:swarm-roster")).toBe(1);
  expect(host.calls).toContainEqual({
    op: "session.childTranscript",
    payload: { id: "sess-swarm-1", conversationId: "conv-worker-1", limit: 25 },
  });
  expect(app.count("id:swarm-transcript-skeleton")).toBe(0);
  await clock.fastForward(160);
  await host.pump(app);
  expect(app.count("id:swarm-transcript-skeleton")).toBe(1);

  await host.releaseDeferred(app);
  expect(app.count("id:swarm-transcript-skeleton")).toBe(0);
  expect(app.count("id:swarm-transcript-step-1")).toBe(1);
  expect(app.texts()).toContain("Implemented antigravity_swarm.rs reader.");
});

test("workspace skeletons: 150ms anti-flash gate suppresses fast loads and renders delayed FileTree, GitPanel, and Palette skeletons", async () => {
  const host = workspaceHost({ view: "sidebar", role: "inspector" });
  const app = await open("../App.story.tsx", {
    width: 320,
    height: 760,
    colorScheme: "light",
    platform: "macos",
    clock: { time: 1_700_000_000_000 },
    host: host.options,
  });
  const clock = app.clock;
  if (!clock) throw new Error("skeleton anti-flash test requires a manual virtual clock");
  await host.pump(app);

  await host.pushFrame(app, "rail", { panel: "files", projects: [] });
  await host.pushFrame(app, "files", { root: "/work/app", name: "app", items: [], loading: true });
  expect(app.count("id:file-tree-skeleton")).toBe(0);
  expect(app.texts()).not.toContain(t("web.shell.fileTree.loading"));
  await clock.fastForward(80);
  await host.pump(app);
  expect(app.count("id:file-tree-skeleton")).toBe(0);

  await host.pushFrame(app, "files", {
    root: "/work/app",
    name: "app",
    expanded: ["/work/app/src"],
    items: [
      {
        id: "/work/app/src",
        label: "src",
        tone: "clean",
        children: [{ id: "/work/app/src/__loading", label: "…", tone: "placeholder", loading: true }],
      },
    ],
  } satisfies FilesFrame);
  await clock.fastForward(200);
  await host.pump(app);
  expect(app.count("id:file-tree-skeleton")).toBe(0);
  expect(app.count("id:file-tree-row-skeleton")).toBe(1);
  expect(app.texts()).not.toContain("…");

  await host.pushFrame(app, "files", { root: "/work/app", name: "app", items: [], loading: true });
  await clock.fastForward(100);
  await host.pump(app);
  expect(app.count("id:file-tree-skeleton")).toBe(0);
  await clock.fastForward(60);
  await host.pump(app);
  expect(app.count("id:file-tree-skeleton")).toBe(1);

  await host.pushFrame(app, "rail", { panel: "git", projects: [] });
  await host.pushFrame(app, "git", { repo: false, busy: true });
  expect(app.count("id:git-panel-skeleton")).toBe(0);
  expect(app.texts()).not.toContain(t("web.shell.git.loading"));
  await clock.fastForward(160);
  await host.pump(app);
  expect(app.count("id:git-panel-skeleton")).toBe(1);
  await host.pushFrame(app, "git", { repo: false, busy: false });
  expect(app.count("id:git-panel-skeleton")).toBe(0);
  expect(app.texts()).toContain(t("web.shell.git.notRepo"));

  const palHost = workspaceHost({ view: "palette" });
  const pal = await open("../App.story.tsx", {
    width: 640,
    height: 420,
    colorScheme: "light",
    platform: "macos",
    clock: { time: 1_700_000_000_000 },
    host: palHost.options,
  });
  const palClock = pal.clock;
  if (!palClock) throw new Error("palette skeleton test requires a manual virtual clock");
  await palHost.pump(pal);
  await palHost.pushFrame(pal, "palette", { mode: "search", query: "foo", loading: true, note: null, items: [] });
  expect(pal.count("id:palette-skeleton")).toBe(0);
  expect(pal.texts()).not.toContain(t("web.shell.palette.empty.search"));
  await palClock.fastForward(160);
  await palHost.pump(pal);
  expect(pal.count("id:palette-skeleton")).toBe(1);
  await palHost.pushFrame(pal, "palette", {
    mode: "search",
    query: "foo",
    loading: false,
    note: null,
    items: [{ id: "m1", label: "foo.ts", detail: "src" }],
  });
  expect(pal.count("id:palette-skeleton")).toBe(0);
});

test("regression: ChatPane hides thought level and omits effort for Orchestrator (Neon) with empty effortLevels", async () => {
  const baseSession = {
    id: "sess-orch-1",
    controller: "user" as const,
    name: "Antigravity",
    runtime: "antigravity",
    brief: "Orchestrator chat",
    cwd: "/work/vibevalley",
    policy: { kind: "directCwd" as const, repo: "vibevalley", permissionMode: "acceptEdits" as const },
    bindings: [],
    hiredAt: 1_700_000_000_000,
    runs: 1,
    phase: { _tag: "resting" as const },
  };
  const host = workspaceHost(
    { view: "workspace-chat", tabId: 44, runtime: "antigravity", cwd: "/work/vibevalley", repo: "vibevalley" },
    {
      "runtime.list": [
        {
          id: "antigravity",
          preset: {
            id: "antigravity",
            label: "Antigravity",
            blurb: "ACP",
            look: { species: null, outfit: null, orchestrator: null, build: "biped", head: "rounded", body: "blue", trim: "navy", hat: "slate", eye: "ink" },
          },
          support: { steer: true, refused: {}, capabilities: ["listModels"], inProcess: false, inSessionConfig: true },
          installation: { status: "available", via: "executable", command: "agy", version: "1.5.14" },
          models: [
            { id: "gemini-4-neon", name: "Gemini 4 Neon", effortLevels: ["low", "medium", "high", "xhigh"], defaultEffort: "high", isDefault: true },
            { id: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)", effortLevels: [], isDefault: false },
          ],
          usage: null,
          skills: null,
          mcpServers: null,
          tools: null,
          settings: { enabled: true, binPath: "", defaultModel: "gemini-4-neon", defaultEffort: "high", env: {} },
          stop: "ok",
          checkedAt: 1_700_000_000_000,
        },
      ] satisfies RuntimeInfo[],
      "session.openWorkspace": {
        id: "sess-orch-1",
        session: baseSession,
        model: "gemini-pro-orchestrator-neon",
        permissionMode: "acceptEdits",
      },
      "session.send": baseSession,
      "session.setConfig": {
        id: "sess-orch-1",
        session: baseSession,
        model: "gemini-4-neon",
        permissionMode: "acceptEdits",
      },
    },
  );

  const app = await open("../App.story.tsx", { width: 820, height: 760, colorScheme: "light", platform: "macos", host: host.options });
  await host.pump(app);

  expect(app.count("id:chat-thought-level")).toBe(1);

  await app.press("id:chat-model-select");
  await app.press("id:chat-model-option-gemini-pro-orchestrator-neon");
  await host.pump(app);
  expect(app.count("id:chat-thought-level")).toBe(0);

  host.clearCalls();
  await app.type("id:chat-composer-input", "Plan the rollout");
  await app.press("id:chat-send");
  await host.pump(app);

  const openCall = host.calls.find((c) => c.op === "session.openWorkspace");
  expect(openCall).toBeDefined();
  const payload = openCall?.payload as Record<string, unknown>;
  expect(payload.model).toBe("gemini-pro-orchestrator-neon");
  expect("effort" in payload).toBe(false);
  expect(app.count("id:chat-thought-level")).toBe(0);

  host.clearCalls();
  await app.press("id:chat-model-select");
  await app.press("id:chat-model-option-gemini-4-neon");
  await host.pump(app);
  expect(app.count("id:chat-thought-level")).toBe(1);
  expect(host.calls).toContainEqual({ op: "session.setConfig", payload: { id: "sess-orch-1", model: "gemini-4-neon" } });
});
