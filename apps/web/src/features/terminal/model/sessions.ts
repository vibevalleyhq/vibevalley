import { z } from "zod";

import { currentHost } from "#/infra/host.ts";
import { defineAtom } from "#/state/atom.ts";
import { defineStored } from "#/state/stored.ts";

import {
  activateTab,
  addTabToGroup,
  allTabs,
  closeTabInTree,
  createInitialGroup,
  detectAgentTui,
  findGroup,
  findGroupContainingTab,
  firstGroup,
  folderBasename,
  type LayoutNode,
  resizeSplitNode,
  splitGroup,
  type TerminalTab,
  updateTab,
} from "./layout";

const maxBufferBytes = 262_144;

interface LiveSession {
  spawned: boolean;
  spawning: boolean;
  cols: number;
  rows: number;
  bytes: number;
  readonly chunks: Uint8Array[];
  readonly listeners: Set<(chunk: Uint8Array) => void>;
}

export interface TerminalWorkspaceState {
  readonly root: LayoutNode | null;
  readonly focusedGroupId: string;
}

export const terminalWorkspace = defineAtom<TerminalWorkspaceState>({
  root: null,
  focusedGroupId: "",
});

export const lastTerminalCwd = defineStored("terminal.cwd", z.string(), "");

const liveSessions = new Map<string, LiveSession>();
let hostAttached = false;
let idSeq = 1;

const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${idSeq++}`;

const encoder = new TextEncoder();

function encodeUtf8Base64(text: string): string {
  const bytes = encoder.encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function getOrCreateLive(tabId: string): LiveSession {
  const existing = liveSessions.get(tabId);
  if (existing) return existing;
  const created: LiveSession = {
    spawned: false,
    spawning: false,
    cols: 80,
    rows: 24,
    bytes: 0,
    chunks: [],
    listeners: new Set(),
  };
  liveSessions.set(tabId, created);
  return created;
}

function ensureHostListeners() {
  if (hostAttached) return;
  const terminal = currentHost().terminal;
  if (!terminal) return;
  hostAttached = true;
  terminal.onData(({ id, data }) => {
    const session = liveSessions.get(id);
    if (!session) return;
    const chunk = decodeBase64Bytes(data);
    if (chunk.byteLength === 0) return;
    session.chunks.push(chunk);
    session.bytes += chunk.byteLength;
    while (session.bytes > maxBufferBytes && session.chunks.length > 1) {
      const dropped = session.chunks.shift();
      if (dropped) session.bytes -= dropped.byteLength;
    }
    for (const fn of session.listeners) fn(chunk);
  });
  terminal.onExit(({ id, code }) => {
    const session = liveSessions.get(id);
    if (session) {
      session.spawned = false;
      session.spawning = false;
    }
    terminalWorkspace.update((state) => (state.root ? { ...state, root: updateTab(state.root, id, { exitedCode: code, agentTui: null }) } : state));
  });
}

export function attachTerminalOutput(tab: TerminalTab, cols: number, rows: number, onChunk: (chunk: Uint8Array) => void): () => void {
  ensureHostListeners();
  const live = getOrCreateLive(tab.id);
  live.cols = cols;
  live.rows = rows;
  for (const chunk of live.chunks) onChunk(chunk);
  live.listeners.add(onChunk);

  const terminal = currentHost().terminal;
  if (terminal && !live.spawned && !live.spawning && tab.exitedCode === null) {
    live.spawning = true;
    void terminal.spawn({ id: tab.id, cwd: tab.cwd, cols, rows }).then(
      () => {
        live.spawning = false;
        live.spawned = true;
        terminal.resize({ id: tab.id, cols: live.cols, rows: live.rows });
      },
      (e: unknown) => {
        live.spawning = false;
        const msg = `\r\n[pty error] ${e instanceof Error ? e.message : String(e)}\r\n`;
        const errBytes = encoder.encode(msg);
        live.chunks.push(errBytes);
        live.bytes += errBytes.byteLength;
        for (const fn of live.listeners) fn(errBytes);
        terminalWorkspace.update((state) => (state.root ? { ...state, root: updateTab(state.root, tab.id, { exitedCode: 1 }) } : state));
      },
    );
  }
  return () => {
    live.listeners.delete(onChunk);
  };
}

export function sendTerminalInput(tabId: string, text: string) {
  if (!text) return;
  currentHost().terminal?.write({ id: tabId, data: encodeUtf8Base64(text) });
}

export function resizeTerminal(tabId: string, cols: number, rows: number) {
  const safeCols = Math.max(2, Math.floor(cols));
  const safeRows = Math.max(1, Math.floor(rows));
  const live = liveSessions.get(tabId);
  if (live) {
    live.cols = safeCols;
    live.rows = safeRows;
    if (!live.spawned) return;
  }
  currentHost().terminal?.resize({ id: tabId, cols: safeCols, rows: safeRows });
}

function makeTab(cwd: string, title?: string): TerminalTab {
  const cleanTitle = title?.trim() || (cwd ? folderBasename(cwd) : "~");
  return {
    id: nextId("pty"),
    title: cleanTitle,
    cwd,
    liveCwd: cwd,
    exitedCode: null,
    agentTui: null,
  };
}

export function openTerminalIn(cwd: string, title?: string): TerminalTab {
  if (cwd) lastTerminalCwd.set(cwd);
  const tab = makeTab(cwd, title);
  getOrCreateLive(tab.id);
  terminalWorkspace.update((state) => {
    if (!state.root) {
      const groupId = nextId("grp");
      return { root: createInitialGroup(groupId, tab), focusedGroupId: groupId };
    }
    const target = findGroup(state.root, state.focusedGroupId) ?? firstGroup(state.root);
    return {
      root: addTabToGroup(state.root, target.id, tab),
      focusedGroupId: target.id,
    };
  });
  return tab;
}

export function focusTerminalTab(tabId: string) {
  terminalWorkspace.update((state) => {
    if (!state.root) return state;
    const group = findGroupContainingTab(state.root, tabId);
    if (!group) return state;
    return {
      root: activateTab(state.root, group.id, tabId),
      focusedGroupId: group.id,
    };
  });
}

export function focusTerminalGroup(groupId: string) {
  terminalWorkspace.update((state) => (state.focusedGroupId === groupId ? state : { ...state, focusedGroupId: groupId }));
}

export function splitTerminalGroup(groupId: string, direction: "row" | "col", fallbackCwd = "") {
  terminalWorkspace.update((state) => {
    if (!state.root) return state;
    const group = findGroup(state.root, groupId);
    if (!group) return state;
    const active = group.tabs.find((t) => t.id === group.activeTabId) ?? group.tabs[0];
    const cwd = active?.liveCwd || active?.cwd || fallbackCwd;
    const tab = makeTab(cwd);
    getOrCreateLive(tab.id);
    const newGroupId = nextId("grp");
    return {
      root: splitGroup(state.root, groupId, nextId("spl"), newGroupId, direction, tab),
      focusedGroupId: newGroupId,
    };
  });
}

export function closeTerminalTab(tabId: string) {
  liveSessions.delete(tabId);
  currentHost().terminal?.kill(tabId);
  terminalWorkspace.update((state) => {
    if (!state.root) return state;
    const nextRoot = closeTabInTree(state.root, tabId);
    if (!nextRoot) return { root: null, focusedGroupId: "" };
    const stillExists = findGroup(nextRoot, state.focusedGroupId);
    return {
      root: nextRoot,
      focusedGroupId: stillExists ? state.focusedGroupId : firstGroup(nextRoot).id,
    };
  });
}

export function reopenTerminalTab(tabId: string) {
  const state = terminalWorkspace.get();
  if (!state.root) return;
  const tab = allTabs(state.root).find((t) => t.id === tabId);
  if (!tab) return;
  const live = getOrCreateLive(tabId);
  live.chunks.length = 0;
  live.bytes = 0;
  live.spawned = false;
  live.spawning = false;
  terminalWorkspace.set({
    ...state,
    root: updateTab(state.root, tabId, { exitedCode: null, agentTui: null }),
  });
}

export function setTerminalSplitRatio(splitId: string, ratio: number) {
  terminalWorkspace.update((state) => (state.root ? { ...state, root: resizeSplitNode(state.root, splitId, ratio) } : state));
}

export async function pollActiveTerminals(): Promise<void> {
  const terminal = currentHost().terminal;
  const root = terminalWorkspace.get().root;
  if (!terminal || !root) return;
  const tabs = allTabs(root).filter((t) => t.exitedCode === null);
  await Promise.allSettled(
    tabs.map(async (tab) => {
      const live = liveSessions.get(tab.id);
      if (live?.spawned !== true) return;
      const info = await terminal.inspect(tab.id);
      const nextCwd = info.cwd || tab.liveCwd;
      const nextAgent = detectAgentTui(info.command);
      if (nextCwd === tab.liveCwd && nextAgent === tab.agentTui) return;
      terminalWorkspace.update((state) =>
        state.root
          ? {
              ...state,
              root: updateTab(state.root, tab.id, {
                liveCwd: nextCwd,
                title: folderBasename(nextCwd),
                agentTui: nextAgent,
              }),
            }
          : state,
      );
    }),
  );
}
