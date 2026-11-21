import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { t } from "@vibevalley/i18n";

import type { FilesFrame } from "./FileTree";
import type { GitFrame } from "./GitPanel";

type App = Awaited<ReturnType<typeof open>>;

function workspaceHost(params: Record<string, unknown>, rpcResponses: Record<string, unknown> = {}) {
  const queue: [string, unknown][] = [];
  const acts: { type: string; [key: string]: unknown }[] = [];
  const pixelDir = decodeURI(new URL("../../../../assets/pixel", import.meta.url).pathname);
  const responses: Record<string, unknown> = {
    "host.pixelDir": { path: pixelDir },
    "repo.list": [],
    ...rpcResponses,
  };
  let rev = 0;

  const action = (data: unknown) => {
    const a = data as { type: string; id?: string; op?: string; payload?: unknown };
    if (a.type === "call") {
      const op = a.op ?? "";
      const answer = op in responses ? responses[op] : null;
      const body = typeof answer === "function" ? (answer as (p: unknown) => unknown)(a.payload) : answer;
      queue.push([`reply:${a.id}`, { bizCode: 0, message: "ok", data: body }]);
    } else if (!["watch", "applied", "ready", "subscribe", "unsubscribe"].includes(a.type)) {
      acts.push(a);
    }
    return null;
  };

  const pump = async (app: App) => {
    for (let round = 0; round < 30 && queue.length > 0; round++) {
      for (const [name, data] of queue.splice(0)) await app.host.send(name, data);
    }
  };

  const pushFrame = async (app: App, topic: string, data: unknown) => {
    await app.host.send(`frame:${topic}`, { rev: ++rev, data });
    await pump(app);
  };

  return {
    options: { params: { pixelDir, ...params }, handlers: { action, ready: null } },
    acts,
    clearActs: () => {
      acts.length = 0;
    },
    pump,
    pushFrame,
  };
}

test("workspace sidebar renders repos, tabs, collapse toggle, and posts project/tab actions", async () => {
  const host = workspaceHost(
    { view: "sidebar" },
    {
      "repo.list": [{ name: "vibevalley", path: "/work/vibevalley", git: true }],
    },
  );
  const app = await open("../App.tsx", { width: 280, height: 760, colorScheme: "light", platform: "macos", host: host.options });
  await host.pump(app);

  await host.pushFrame(app, "state", { seq: 1, state: { sessions: [], issues: [] } });
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
  expect(app.texts()).toContain("notes");

  host.clearActs();
  await app.press("text:README.md");
  expect(host.acts).toContainEqual({ type: "activate_tab", path: "/work/vibevalley", tab_id: 102 });

  await app.press("text:notes");
  expect(host.acts).toContainEqual({ type: "activate_path", path: "/tmp/notes" });

  await app.press(`label:${t("web.shell.sidebar.manageRepos")}`);
  expect(host.acts).toContainEqual({ type: "open_route", path: "/repos" });

  await app.press(`label:${t("web.shell.sidebar.addRepo")}`);
  expect(host.acts).toContainEqual({ type: "add_project" });

  await app.hover("text:README.md");
  await app.press(`label:${t("web.shell.sidebar.closeTab", { title: "README.md" })}`);
  expect(host.acts).toContainEqual({ type: "close_tab_at", path: "/work/vibevalley", tab_id: 102 });

  await app.press(`label:${t("web.shell.sidebar.collapseAll")}`);
  expect(app.texts()).not.toContain("README.md");
  await app.press(`label:${t("web.shell.sidebar.expandCurrent")}`);
  expect(app.texts()).toContain("README.md");
});

test("workspace inspector FileTree expands, collapses, opens files, and handles context menus", async () => {
  const host = workspaceHost({ view: "sidebar", role: "inspector" });
  const app = await open("../App.tsx", { width: 320, height: 760, colorScheme: "light", platform: "macos", host: host.options });
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
  const app = await open("../App.tsx", { width: 340, height: 820, colorScheme: "light", platform: "macos", host: host.options });
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
  const app = await open("../App.tsx", { width: 640, height: 420, colorScheme: "light", platform: "macos", host: host.options });
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

test("workspace MarkdownPane renders pushed markdown documents and error states", async () => {
  const host = workspaceHost({ view: "markdown" });
  const app = await open("../App.tsx", { width: 720, height: 600, colorScheme: "light", platform: "macos", host: host.options });
  await host.pump(app);

  expect(app.count("id:markdown-pane")).toBe(1);
  expect(app.texts()).toContain("Loading preview…");

  await host.pushFrame(app, "doc", { path: "README.md", markdown: "# Architecture\n\nRendered paragraph body." });
  expect(app.texts().some((s) => s.includes("Architecture"))).toBe(true);
  expect(app.texts().some((s) => s.includes("Rendered paragraph body."))).toBe(true);

  await host.pushFrame(app, "doc", { path: "missing.md", markdown: null, error: "File disappeared on disk" });
  expect(app.texts()).toContain("File disappeared on disk");
});
