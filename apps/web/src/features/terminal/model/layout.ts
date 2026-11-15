import type { Issue, RepoSummary, Session } from "@vibevalley/protocol";
import { issueScopeOf } from "@vibevalley/protocol/rules";

export interface TerminalTab {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly liveCwd: string;
  readonly exitedCode: number | null;
  readonly agentTui: string | null;
}

export interface PaneGroup {
  readonly kind: "group";
  readonly id: string;
  readonly tabs: readonly TerminalTab[];
  readonly activeTabId: string;
}

export interface PaneSplit {
  readonly kind: "split";
  readonly id: string;
  readonly direction: "row" | "col";
  readonly ratio: number;
  readonly first: LayoutNode;
  readonly second: LayoutNode;
}

export type LayoutNode = PaneGroup | PaneSplit;

export interface WorktreeFolder {
  readonly cwd: string;
  readonly issueId: string;
  readonly number: number;
  readonly title: string;
  readonly branch: string;
}

export interface WorkspaceRepoGroup {
  readonly name: string;
  readonly path: string;
  readonly worktrees: readonly WorktreeFolder[];
}

export function folderBasename(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  if (!trimmed) return "/";
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

const agentMatchers: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: "claude", pattern: /(?:^|[\s/])claude(?:\s|$)/iu },
  { id: "codex", pattern: /(?:^|[\s/])codex(?:\s|$)/iu },
  { id: "opencode", pattern: /(?:^|[\s/])opencode(?:\s|$)/iu },
  { id: "gemini", pattern: /(?:^|[\s/])gemini(?:\s|$)/iu },
  { id: "cursor", pattern: /(?:^|[\s/])cursor(?:-agent)?(?:\s|$)/iu },
  { id: "kimi", pattern: /(?:^|[\s/])kimi(?:\s|$)/iu },
  { id: "pi", pattern: /(?:^|[\s/])pi(?:\s|$)/iu },
  { id: "aider", pattern: /(?:^|[\s/])aider(?:\s|$)/iu },
];

export function detectAgentTui(command: string): string | null {
  const text = command.trim();
  if (!text) return null;
  for (const m of agentMatchers) {
    if (m.pattern.test(text)) return m.id;
  }
  return null;
}

export function workspaceFoldersOf(repos: readonly RepoSummary[], issues: readonly Issue[], sessions: readonly Session[]): readonly WorkspaceRepoGroup[] {
  const issueById = new Map(issues.map((item) => [item.id, item]));
  const worktreesByRepo = new Map<string, Map<string, WorktreeFolder>>();

  for (const session of sessions) {
    const issueId = issueScopeOf(session);
    if (!session.worktree || !session.repo || !issueId) continue;
    const issue = issueById.get(issueId);
    if (!issue || issue.status === "done" || issue.status === "canceled") continue;
    let map = worktreesByRepo.get(session.repo);
    if (!map) {
      map = new Map();
      worktreesByRepo.set(session.repo, map);
    }
    if (!map.has(session.worktree)) {
      map.set(session.worktree, {
        cwd: session.worktree,
        issueId: issue.id,
        number: issue.number,
        title: issue.title,
        branch: session.branch ?? "",
      });
    }
  }

  return repos.map((repo) => {
    const map = worktreesByRepo.get(repo.name);
    const worktrees = map ? [...map.values()].toSorted((a, b) => a.number - b.number) : [];
    return {
      name: repo.name,
      path: repo.path,
      worktrees,
    };
  });
}

export function createInitialGroup(groupId: string, tab: TerminalTab): PaneGroup {
  return {
    kind: "group",
    id: groupId,
    tabs: [tab],
    activeTabId: tab.id,
  };
}

export function firstGroup(node: LayoutNode): PaneGroup {
  return node.kind === "group" ? node : firstGroup(node.first);
}

export function findGroup(node: LayoutNode, groupId: string): PaneGroup | undefined {
  if (node.kind === "group") return node.id === groupId ? node : undefined;
  return findGroup(node.first, groupId) ?? findGroup(node.second, groupId);
}

export function findGroupContainingTab(node: LayoutNode, tabId: string): PaneGroup | undefined {
  if (node.kind === "group") return node.tabs.some((t) => t.id === tabId) ? node : undefined;
  return findGroupContainingTab(node.first, tabId) ?? findGroupContainingTab(node.second, tabId);
}

export function allTabs(node: LayoutNode | null): readonly TerminalTab[] {
  if (!node) return [];
  if (node.kind === "group") return node.tabs;
  return [...allTabs(node.first), ...allTabs(node.second)];
}

export function addTabToGroup(node: LayoutNode, groupId: string, tab: TerminalTab): LayoutNode {
  if (node.kind === "group") {
    if (node.id !== groupId) return node;
    return {
      ...node,
      tabs: [...node.tabs, tab],
      activeTabId: tab.id,
    };
  }
  const first = addTabToGroup(node.first, groupId, tab);
  const second = addTabToGroup(node.second, groupId, tab);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function activateTab(node: LayoutNode, groupId: string, tabId: string): LayoutNode {
  if (node.kind === "group") {
    if (node.id !== groupId || !node.tabs.some((t) => t.id === tabId) || node.activeTabId === tabId) return node;
    return { ...node, activeTabId: tabId };
  }
  const first = activateTab(node.first, groupId, tabId);
  const second = activateTab(node.second, groupId, tabId);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function updateTab(node: LayoutNode, tabId: string, patch: Partial<Omit<TerminalTab, "id">>): LayoutNode {
  if (node.kind === "group") {
    let changed = false;
    const tabs = node.tabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      changed = true;
      return { ...tab, ...patch };
    });
    return changed ? { ...node, tabs } : node;
  }
  const first = updateTab(node.first, tabId, patch);
  const second = updateTab(node.second, tabId, patch);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function closeTabInTree(node: LayoutNode, tabId: string): LayoutNode | null {
  if (node.kind === "group") {
    const idx = node.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return node;
    const nextTabs = node.tabs.filter((t) => t.id !== tabId);
    const [firstTab] = nextTabs;
    if (!firstTab) return null;
    const activeTabId = node.activeTabId === tabId ? (nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? firstTab.id) : node.activeTabId;
    return { ...node, tabs: nextTabs, activeTabId };
  }
  const first = closeTabInTree(node.first, tabId);
  const second = closeTabInTree(node.second, tabId);
  if (first === null) return second;
  if (second === null) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function splitGroup(node: LayoutNode, groupId: string, splitId: string, newGroupId: string, direction: "row" | "col", tab: TerminalTab): LayoutNode {
  if (node.kind === "group") {
    if (node.id !== groupId) return node;
    return {
      kind: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: node,
      second: createInitialGroup(newGroupId, tab),
    };
  }
  const first = splitGroup(node.first, groupId, splitId, newGroupId, direction, tab);
  const second = splitGroup(node.second, groupId, splitId, newGroupId, direction, tab);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function resizeSplitNode(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.kind === "group") return node;
  const clamped = Math.min(0.85, Math.max(0.15, ratio));
  if (node.id === splitId) {
    return node.ratio === clamped ? node : { ...node, ratio: clamped };
  }
  const first = resizeSplitNode(node.first, splitId, clamped);
  const second = resizeSplitNode(node.second, splitId, clamped);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}
