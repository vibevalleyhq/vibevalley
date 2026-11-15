import { describe, expect, test } from "vite-plus/test";

import type { Issue, RepoSummary, Session } from "@vibevalley/protocol";

import {
  activateTab,
  addTabToGroup,
  allTabs,
  closeTabInTree,
  createInitialGroup,
  detectAgentTui,
  findGroup,
  folderBasename,
  resizeSplitNode,
  splitGroup,
  type TerminalTab,
  updateTab,
  workspaceFoldersOf,
} from "./layout";

const mkTab = (id: string, cwd = "/work/demo"): TerminalTab => ({
  id,
  title: folderBasename(cwd),
  cwd,
  liveCwd: cwd,
  exitedCode: null,
  agentTui: null,
});

describe("terminal layout tree", () => {
  test("adds, activates, splits, resizes, and collapses panes immutably when last tab closes", () => {
    const initial = createInitialGroup("g1", mkTab("t1"));
    const withSecond = addTabToGroup(initial, "g1", mkTab("t2"));
    expect(findGroup(withSecond, "g1")?.activeTabId).toBe("t2");

    const activated = activateTab(withSecond, "g1", "t1");
    expect(findGroup(activated, "g1")?.activeTabId).toBe("t1");

    const split = splitGroup(activated, "g1", "s1", "g2", "row", mkTab("t3", "/work/notes"));
    expect(split.kind).toBe("split");
    expect(allTabs(split).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);

    const resized = resizeSplitNode(split, "s1", 0.95);
    expect(resized.kind === "split" && resized.ratio).toBe(0.85);

    const updated = updateTab(resized, "t3", { agentTui: "claude", exitedCode: 0 });
    expect(findGroup(updated, "g2")?.tabs[0]).toMatchObject({ agentTui: "claude", exitedCode: 0 });

    const collapsed = closeTabInTree(updated, "t3");
    expect(collapsed?.kind).toBe("group");
    expect(allTabs(collapsed).map((t) => t.id)).toEqual(["t1", "t2"]);

    const oneLeft = closeTabInTree(collapsed!, "t1");
    expect(findGroup(oneLeft!, "g1")?.activeTabId).toBe("t2");

    expect(closeTabInTree(oneLeft!, "t2")).toBeNull();
  });

  test("detects foreground coding-agent TUIs from native binaries and Node argv", () => {
    expect(detectAgentTui("node /opt/homebrew/bin/claude --continue")).toBe("claude");
    expect(detectAgentTui("/usr/local/bin/codex")).toBe("codex");
    expect(detectAgentTui("node /Users/dev/.nvm/bin/gemini")).toBe("gemini");
    expect(detectAgentTui("opencode")).toBe("opencode");
    expect(detectAgentTui("-zsh")).toBeNull();
  });

  test("groups active issue worktrees under their repository and skips closed issues", () => {
    const repos = [{ name: "demo", path: "/repos/demo", git: true, maxSessions: 6 }] as RepoSummary[];
    const issues = [
      { id: "i1", number: 12, title: "Add terminal", status: "in_progress" },
      { id: "i2", number: 9, title: "Old done work", status: "done" },
    ] as unknown as Issue[];
    const sessions = [
      { id: "s1", repo: "demo", issue: "i1", worktree: "/worktrees/demo.12", branch: "vibevalley/issue-12" },
      { id: "s2", repo: "demo", issue: "i2", worktree: "/worktrees/demo.9", branch: "vibevalley/issue-9" },
    ] as unknown as Session[];

    const groups = workspaceFoldersOf(repos, issues, sessions);
    expect(groups).toEqual([
      {
        name: "demo",
        path: "/repos/demo",
        worktrees: [
          {
            cwd: "/worktrees/demo.12",
            issueId: "i1",
            number: 12,
            title: "Add terminal",
            branch: "vibevalley/issue-12",
          },
        ],
      },
    ]);
  });
});
