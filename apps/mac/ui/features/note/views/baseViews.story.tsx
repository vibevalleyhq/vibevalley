import "../../../infra/polyfill";
import { mount, signal, Text, View } from "nsh";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import {
  type BaseRunAgentColumnRequest,
  type BaseUpsertRowRequest,
  type BaseViewSnapshot,
  type Issue,
  type IssueId,
  type Note,
  type NoteFileContent,
  type NoteFileMeta,
  type NoteHistoryEntry,
  type NoteId,
  type NotePresence,
  type Suggestion,
  type SuggestionId,
} from "@vibevalley/protocol";
import { issueId as toIssueId, noteId as toNoteId, sessionId as toSessionId } from "@vibevalley/protocol/schema";

import { Button } from "../../../design/Button";
import { createSlices, SlicesContext } from "../../../infra/frame";
import { QueryProvider } from "../../../infra/query";
import { pageRegistry, RegistryContext } from "../../../infra/state/atom";
import { setTransport } from "../../../infra/transport";
import { CollabToolbar } from "../CollabToolbar";
import { HistoryPanel } from "../HistoryPanel";
import { NoteDirectoryView } from "../NoteDirectoryView";
import { BaseView } from "./BaseView";
import { CanvasView } from "./CanvasView";
import { MediaView } from "./MediaView";

setLocale("en");

const NOW = 1_764_250_000_000;

const baseNote: Note = {
  id: toNoteId("note-base-1"),
  title: "Roadmap Base",
  noteType: "base",
  sortOrder: 0,
  by: "user",
  byName: "You",
  version: 1,
  seq: 3,
  versions: [{ version: 1, size: 120, note: "Initial", by: "user", byName: "You", at: NOW - 3600_000, channel: "" }],
  at: NOW - 7200_000,
  updated: NOW - 60_000,
};

const pageNote: Note = {
  id: toNoteId("note-page-1"),
  title: "Auth Design Doc",
  noteType: "doc",
  parentId: toNoteId("note-base-1"),
  sortOrder: 1,
  by: "user",
  byName: "You",
  version: 0,
  seq: 1,
  versions: [],
  at: NOW - 3600_000,
  updated: NOW - 30_000,
  preview: { _tag: "doc", excerpt: "Token rotation and session guard design.", blockCount: 4, slideCount: 1, outline: [] },
};

const canvasNote: Note = {
  id: toNoteId("note-canvas-1"),
  title: "System Canvas",
  noteType: "canvas",
  sortOrder: 2,
  by: "user",
  byName: "You",
  version: 0,
  seq: 2,
  versions: [],
  at: NOW - 3600_000,
  updated: NOW - 30_000,
};

const mediaNote: Note = {
  id: toNoteId("note-media-1"),
  title: "Launch Reel & Audio",
  noteType: "media",
  sortOrder: 3,
  by: "user",
  byName: "You",
  version: 0,
  seq: 2,
  versions: [],
  at: NOW - 3600_000,
  updated: NOW - 30_000,
};

const NOTES: Note[] = [baseNote, pageNote, canvasNote, mediaNote];

const ISSUES: Issue[] = [
  {
    id: "iss-101" as IssueId,
    number: 101,
    title: "Harden OAuth refresh",
    description: "",
    mandate: { strength: "explicit", maxBotReviewRounds: 2, autoSubmitPr: false },
    assignments: [],
    priority: "high",
    createdAt: NOW - 5000,
    status: "in_progress",
    moves: [],
    deliver: "change",
    findings: [],
    questions: [],
    criteria: [],
    checks: [],
    stage: { state: "working", acts: [] },
    blockedBy: [],
  },
];

const initialSnapshot: BaseViewSnapshot = {
  noteId: "note-base-1" as NoteId,
  sheets: [
    { id: "sheet1", name: "Tasks", rowCount: 2 },
    { id: "sheet2", name: "Metrics", rowCount: 1 },
  ],
  activeSheetId: "sheet1",
  activeViewId: "v_table",
  activeViewKind: "table",
  columns: [
    { id: "c_title", name: "Title", kind: "text" },
    { id: "c_score", name: "Score", kind: "number" },
    {
      id: "c_status",
      name: "Status",
      kind: "select",
      options: [
        { value: "todo", label: "Todo", color: "stone" },
        { value: "doing", label: "Doing", color: "amber" },
        { value: "done", label: "Done", color: "green" },
      ],
    },
    {
      id: "c_tags",
      name: "Tags",
      kind: "multiSelect",
      options: [
        { value: "core", label: "Core" },
        { value: "ui", label: "UI" },
      ],
    },
    { id: "c_due", name: "Due", kind: "date" },
    { id: "c_ready", name: "Ready", kind: "checkbox" },
    { id: "c_media", name: "Media", kind: "media" },
    { id: "c_issue", name: "Issue", kind: "issueRef" },
    { id: "c_agent", name: "Agent", kind: "agentRef" },
    { id: "c_note", name: "Spec", kind: "noteRef" },
    { id: "c_formula", name: "Double Score", kind: "formula", formula: "{c_score} * 2" },
    {
      id: "c_action",
      name: "Triage",
      kind: "agentAction",
      agentConfig: { promptTemplate: "Review {{Title}}" },
    },
  ],
  rows: [
    {
      id: "r1",
      pageNoteId: "note-page-1" as NoteId,
      createdAt: NOW - 86_400_000 * 3,
      updatedAt: NOW - 10_000,
      cells: {
        c_title: { _tag: "text", value: "Auth hardening" },
        c_score: { _tag: "number", value: 21 },
        c_status: { _tag: "text", value: "doing" },
        c_tags: { _tag: "strings", items: ["core"] },
        c_due: { _tag: "text", value: "2026-12-01" },
        c_ready: { _tag: "bool", value: true },
        c_media: { _tag: "text", value: "asset/cover.png" },
        c_issue: { _tag: "issueRef", issueId: "iss-101" as IssueId },
        c_agent: { _tag: "agentRef", agentId: "agent-arch" },
        c_note: { _tag: "noteRef", noteId: "note-page-1" as NoteId },
        c_formula: { _tag: "number", value: 42 },
        c_action: {
          _tag: "agentRun",
          status: "spawned",
          summary: "Created #101",
          spawnedIssueId: toIssueId("iss-101"),
          sessionId: toSessionId("sess-abcdef12"),
          updatedAt: NOW - 5_000,
        },
      },
    },
    {
      id: "r2",
      createdAt: NOW - 86_400_000,
      updatedAt: NOW - 5_000,
      cells: {
        c_title: { _tag: "text", value: "Docs pass" },
        c_score: { _tag: "number", value: 9 },
        c_status: { _tag: "text", value: "todo" },
        c_tags: { _tag: "strings", items: ["ui"] },
        c_due: { _tag: "text", value: "2026-12-05" },
        c_ready: { _tag: "bool", value: false },
        c_media: { _tag: "text", value: "" },
        c_issue: { _tag: "issueRef", issueId: toIssueId("") },
        c_agent: { _tag: "agentRef", agentId: "" },
        c_note: { _tag: "noteRef", noteId: toNoteId("") },
        c_formula: { _tag: "number", value: 18 },
      },
    },
  ],
  groups: [
    { key: "todo", label: "Todo", rowIds: ["r2"], count: 1 },
    { key: "doing", label: "Doing", rowIds: ["r1"], count: 1 },
  ],
  summaries: [{ columnId: "c_score", op: "sum", value: "30" }],
  totalRows: 2,
};

const filesStore = new Map<string, Map<string, NoteFileContent>>([
  [
    "note-canvas-1",
    new Map([
      [
        "structure/board.json",
        {
          noteId: "note-canvas-1" as NoteId,
          path: "structure/board.json",
          mime: "application/json",
          encoding: "utf8",
          content: JSON.stringify({
            version: 1,
            grid: "architectural",
            viewport: { x: 0, y: 0, zoom: 1 },
            elements: {
              t1: { id: "t1", type: "text", label: "Gateway Node", x: 60, y: 40 },
            },
          }),
          size: 160,
          hash: "h-board-1",
          updatedAt: NOW,
        },
      ],
    ]),
  ],
  [
    "note-media-1",
    new Map([
      [
        "structure/media.json",
        {
          noteId: "note-media-1" as NoteId,
          path: "structure/media.json",
          mime: "application/json",
          encoding: "utf8",
          content: JSON.stringify({
            version: 1,
            title: "Launch Reel & Audio",
            mediaKind: "audio",
            durationSec: 12.5,
            items: [
              {
                id: "m1",
                kind: "audio",
                src: "asset/audio/briefing.wav",
                title: "Kickoff Briefing",
                durationSec: 12.5,
                transcript: [{ id: "c1", startSec: 0.5, endSec: 4.0, speaker: "Lead", text: "Welcome to Note 3+1!" }],
              },
            ],
            shots: [
              {
                id: "sh01",
                scene: "Opening Hook",
                durationSec: 3,
                framing: "wide",
                camera: "pan",
                visual: "Workbench panorama",
                dialogue: "Everything in one directory.",
                status: "approved",
              },
            ],
            scenes: [
              {
                id: "sc1",
                start: 0,
                end: 4,
                title: "Intro Title",
                layers: [{ id: "l1", kind: "text", text: "VibeValley Note" }],
              },
            ],
          }),
          size: 420,
          hash: "h-media-1",
          updatedAt: NOW,
        },
      ],
      [
        "asset/audio/briefing.wav",
        {
          noteId: "note-media-1" as NoteId,
          path: "asset/audio/briefing.wav",
          mime: "audio/wav",
          encoding: "base64",
          content: "UklGRg==",
          size: 2048,
          hash: "h-wav-1",
          updatedAt: NOW,
        },
      ],
    ]),
  ],
  [
    "note-base-1",
    new Map([
      [
        "manifest.json",
        {
          noteId: "note-base-1" as NoteId,
          path: "manifest.json",
          mime: "application/json",
          encoding: "utf8",
          content: JSON.stringify({ id: "note-base-1", noteType: "base", title: "Roadmap Base" }, null, 2),
          size: 72,
          hash: "h-man-1",
          updatedAt: NOW,
        },
      ],
      [
        "structure/base.json",
        {
          noteId: "note-base-1" as NoteId,
          path: "structure/base.json",
          mime: "application/json",
          encoding: "utf8",
          content: JSON.stringify({ version: 1, sheets: [] }, null, 2),
          size: 32,
          hash: "h-base-1",
          updatedAt: NOW,
        },
      ],
    ]),
  ],
]);

const historyEntries: NoteHistoryEntry[] = [
  { frontiers: "f-latest", author: "user", origin: "user", summary: "Latest edit", at: NOW - 10_000 },
  {
    frontiers: "f-agent-1",
    author: "agent-arch",
    agent: "agent-arch",
    turn: 2,
    origin: "session:s1:turn:2",
    summary: "Agent populated scores",
    at: NOW - 60_000,
  },
];

const toMeta = (f: NoteFileContent): NoteFileMeta => ({
  path: f.path,
  mime: f.mime,
  size: f.size,
  hash: f.hash,
  updatedAt: f.updatedAt,
});

setTransport({
  call: async (op, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (op === "agent.list") {
      return {
        bizCode: 0,
        message: "ok",
        data: [
          {
            id: "agent-arch",
            name: "Architect",
            duty: "Designs architecture",
            tags: [],
            runtime: "claude",
            enabled: true,
            worktree: false,
            look: { species: "owl", outfit: "farmer", build: "slim", head: "round", body: "#f3e9da", trim: "#2f9d8f", hat: "#f2b53a", eye: "#ffffff" },
          },
        ],
      };
    }
    if (op === "note.get") {
      const n = NOTES.find((x) => x.id === p.id) ?? baseNote;
      return { bizCode: 0, message: "ok", data: n };
    }
    if (op === "note.file.list") {
      const idStr = typeof p.id === "string" ? p.id : "";
      const m = filesStore.get(idStr) ?? new Map<string, NoteFileContent>();
      return { bizCode: 0, message: "ok", data: { noteId: idStr, seq: 3, files: [...m.values()].map(toMeta) } };
    }
    if (op === "note.file.get") {
      const idStr = typeof p.id === "string" ? p.id : "";
      const pathStr = typeof p.path === "string" ? p.path : "";
      const f = filesStore.get(idStr)?.get(pathStr);
      if (!f) return { bizCode: 404, message: "missing file" };
      return { bizCode: 0, message: "ok", data: f };
    }
    if (op === "note.file.write") {
      const idStr = typeof p.id === "string" ? p.id : "";
      let m = filesStore.get(idStr);
      if (!m) {
        m = new Map();
        filesStore.set(idStr, m);
      }
      const items = (p.files as { path: string; content: string; mime?: string }[]) ?? [];
      for (const item of items) {
        m.set(item.path, {
          noteId: toNoteId(idStr),
          path: item.path,
          mime: item.mime ?? "text/plain",
          encoding: "utf8",
          content: item.content,
          size: item.content.length,
          hash: `h-${Date.now()}`,
          updatedAt: NOW,
        });
      }
      return { bizCode: 0, message: "ok", data: { noteId: idStr, seq: 4, files: [...m.values()].map(toMeta) } };
    }
    if (op === "note.file.delete") {
      const idStr = typeof p.id === "string" ? p.id : "";
      const pathStr = typeof p.path === "string" ? p.path : "";
      filesStore.get(idStr)?.delete(pathStr);
      return { bizCode: 0, message: "ok", data: { noteId: idStr, seq: 5, path: pathStr } };
    }
    if (op === "note.history.list") {
      return { bizCode: 0, message: "ok", data: historyEntries };
    }
    if (op === "note.history.preview") {
      const idStr = typeof p.id === "string" ? p.id : "";
      const frontiersStr = typeof p.frontiers === "string" ? p.frontiers : "";
      const f = filesStore.get(idStr)?.get("structure/base.json");
      return {
        bizCode: 0,
        message: "ok",
        data: {
          noteId: idStr,
          noteType: "base",
          frontiers: frontiersStr,
          entry: historyEntries[1],
          files: f ? [f] : [],
        },
      };
    }
    if (op === "note.history.restore" || op === "note.history.undoOrigin" || op === "note.history.compact") {
      return { bizCode: 0, message: "ok", data: { ...baseNote, seq: 6 } };
    }
    if (op === "note.history.fork") {
      return { bizCode: 0, message: "ok", data: { ...baseNote, id: "note-fork-1", title: "Roadmap Base (Fork)" } };
    }
    if (op === "note.version.create") {
      return { bizCode: 0, message: "ok", data: { ...baseNote, version: 2 } };
    }
    if (op === "note.presence.update") {
      return { bizCode: 0, message: "ok", data: null };
    }
    return { bizCode: 0, message: "ok", data: null };
  },
  slice: (kind, listener) => {
    queueMicrotask(() => {
      if (kind === "sessions") (listener as (d: unknown) => void)({ seq: 1, sessions: [], machines: [] });
      if (kind === "board") (listener as (d: unknown) => void)({ seq: 1, issues: ISSUES });
    });
    return () => {};
  },
  live: () => () => {},
  subscribe: () => () => {},
});

function BaseViewsBench() {
  const mode = signal<"base" | "canvas" | "media" | "files">("base");
  const snap = signal<BaseViewSnapshot>(initialSnapshot);
  const lastEvent = signal("none");
  const historyOpen = signal(false);
  const suggestions = signal<Suggestion[]>([
    {
      id: "sug-1" as SuggestionId,
      noteId: "note-base-1" as NoteId,
      path: "structure/base.json",
      author: "Architect",
      baseRev: 3,
      change: { summary: "Add security audit row" },
      status: "open",
      createdAt: NOW - 1000,
    },
  ]);

  const peers: NotePresence[] = [
    {
      id: "agent-arch",
      name: "Architect",
      kind: "cursor",
      status: "editing",
      updatedAt: NOW,
    },
  ];

  const handleUpsert = (req: BaseUpsertRowRequest) => {
    const cur = snap();
    const existing = req.rowId ? cur.rows.find((r) => r.id === req.rowId) : undefined;
    const nextRows = existing
      ? cur.rows.map((r) => (r.id === req.rowId ? { ...r, cells: req.cells, updatedAt: NOW } : r))
      : [...cur.rows, { id: `r-${cur.rows.length + 1}`, cells: req.cells, createdAt: NOW, updatedAt: NOW }];
    snap.set({ ...cur, rows: nextRows, totalRows: nextRows.length });
    lastEvent.set(`upsert:${req.rowId ?? "new"}`);
  };

  const handleRunAgent = async (req: BaseRunAgentColumnRequest) => {
    lastEvent.set(`run:${req.columnId}:${req.rowIds?.join(",") ?? "all"}`);
    return {
      noteId: req.id,
      sheetId: req.sheetId ?? "sheet1",
      columnId: req.columnId,
      executed: req.rowIds?.length ?? snap().rows.length,
      updatedRowIds: req.rowIds ? [...req.rowIds] : snap().rows.map((r) => r.id),
      spawnedIssueIds: ["iss-101"],
    };
  };

  return (
    <SlicesContext.Provider value={createSlices()}>
      <RegistryContext.Provider value={pageRegistry}>
        <QueryProvider>
          <View testID="base-views-bench" class="flex-1 bg-page">
            <View class="flex-row items-center justify-between gap-2 border-b border-line bg-side px-3 py-2">
              <View class="flex-row items-center gap-1.5">
                <Button size="compact" tone={mode() === "base" ? "primary" : "plain"} testID="bench-tab-base" onPress={() => mode.set("base")}>
                  Base
                </Button>
                <Button size="compact" tone={mode() === "canvas" ? "primary" : "plain"} testID="bench-tab-canvas" onPress={() => mode.set("canvas")}>
                  Canvas
                </Button>
                <Button size="compact" tone={mode() === "media" ? "primary" : "plain"} testID="bench-tab-media" onPress={() => mode.set("media")}>
                  Media
                </Button>
                <Button size="compact" tone={mode() === "files" ? "primary" : "plain"} testID="bench-tab-files" onPress={() => mode.set("files")}>
                  Files
                </Button>
                <Text testID="bench-last-event" class="ml-2 font-mono text-xs text-muted">
                  {lastEvent()}
                </Text>
              </View>

              <CollabToolbar
                note={baseNote}
                peers={peers}
                suggestions={suggestions()}
                onAcceptSuggestion={(id) => {
                  suggestions.set(suggestions().map((s) => (s.id === id ? { ...s, status: "accepted" } : s)));
                  lastEvent.set(`accept:${id}`);
                }}
                onRejectSuggestion={(id) => {
                  suggestions.set(suggestions().map((s) => (s.id === id ? { ...s, status: "rejected" } : s)));
                  lastEvent.set(`reject:${id}`);
                }}
                onToggleHistory={() => historyOpen.set(!historyOpen())}
                onToggleFiles={() => mode.set(mode() === "files" ? "base" : "files")}
              />
            </View>

            <View class="min-h-0 flex-1 flex-row">
              <View class="min-h-0 min-w-0 flex-1">
                <If when={mode() === "base"}>
                  <BaseView
                    note={baseNote}
                    snapshot={snap()}
                    notes={NOTES}
                    issues={ISSUES}
                    onSelectView={(sheetId, viewId) => lastEvent.set(`selectView:${sheetId}:${viewId}`)}
                    onUpsertRow={handleUpsert}
                    onRunAgentColumn={handleRunAgent}
                    onOpenNote={(id) => lastEvent.set(`openNote:${id}`)}
                    onOpenIssue={(id) => lastEvent.set(`openIssue:${id}`)}
                    onCreatePageForRow={async (row) => {
                      const createdId = toNoteId(`note-page-${row.id}`);
                      const cur = snap();
                      snap.set({
                        ...cur,
                        rows: cur.rows.map((r) => (r.id === row.id ? { ...r, pageNoteId: createdId } : r)),
                      });
                      lastEvent.set(`createPage:${row.id}:${createdId}`);
                      return createdId;
                    }}
                  />
                </If>
                <If when={mode() === "canvas"}>
                  <CanvasView note={canvasNote} onRefresh={() => lastEvent.set("canvas:refresh")} />
                </If>
                <If when={mode() === "media"}>
                  <MediaView note={mediaNote} onOpenIssue={(id) => lastEvent.set(`openIssue:${id}`)} />
                </If>
                <If when={mode() === "files"}>
                  <NoteDirectoryView noteId={baseNote.id} onOpenNote={(id) => lastEvent.set(`openNote:${id}`)} />
                </If>
              </View>

              <HistoryPanel
                noteId={baseNote.id}
                open={historyOpen()}
                onClose={() => historyOpen.set(false)}
                onChanged={(n) => lastEvent.set(`historyChanged:${n.id}`)}
              />
            </View>
          </View>
        </QueryProvider>
      </RegistryContext.Provider>
    </SlicesContext.Provider>
  );
}

mount(() => <BaseViewsBench />);
