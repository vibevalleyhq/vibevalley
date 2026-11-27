import { cleanup, effect, signal, untracked, type Accessor } from "nsh";
import { z } from "zod";

import type {
  BaseRow,
  Note,
  NoteEvent,
  NoteFileContent,
  NoteFileDeleteResult,
  NoteFileMeta,
  NoteFileWriteItem,
  NoteFileWriteResult,
  NoteId,
  NotePresence,
  NotePresenceEvent,
  NoteType,
  NoteViewContext,
  Suggestion,
  SuggestionCreate,
  SuggestionId,
} from "@vibevalley/protocol";
import { noteId } from "@vibevalley/protocol/schema";

import { api, reasonOf } from "../../infra/api";
import { saveFile } from "../../infra/attachmentFile";
import { followNote, followNotePresence, followSuggestions } from "../../infra/gateway";
import { defineQuery } from "../../infra/query";
import { transport } from "../../infra/transport";
import { noteSuffixOf } from "./html";

/** Live state of whichever note viewer is currently mounted, attached to outgoing chat/reply messages. */
export const activeNoteViewContext = signal<NoteViewContext | undefined>(undefined);

/** Monotonic: consumers react to a bump, never to the number itself. */
export const noteChatFocus = signal(0);

export function requestNoteChatFocus(): void {
  noteChatFocus.set(untracked(noteChatFocus) + 1);
}

export function clearActiveNoteViewContext(): void {
  activeNoteViewContext.set(undefined);
}

export function useReportViewContext(id: () => NoteId, compute: () => Omit<NoteViewContext, "noteId">) {
  effect(() => {
    const next: NoteViewContext = { noteId: id(), ...compute() };
    activeNoteViewContext.set(next);
  });
  cleanup(() => {
    const ownId = untracked(id);
    if (untracked(activeNoteViewContext)?.noteId === ownId) {
      activeNoteViewContext.set(undefined);
    }
  });
}

function isTextMime(mime: string, path: string): boolean {
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/javascript" || mime === "image/svg+xml") return true;
  return /\.(?:md|markdown|json|html|htm|css|js|mjs|ts|tsx|svg|csv|txt|yaml|yml)$/iu.test(path);
}

export interface DirectorySnapshot {
  readonly seq: number;
  readonly files: ReadonlyMap<string, NoteFileMeta>;
  readonly contents: ReadonlyMap<string, NoteFileContent>;
  readonly loading: boolean;
  readonly error: string | undefined;
}

export class DirectoryNoteClient {
  private readonly listeners = new Set<() => void>();
  private filesMap = new Map<string, NoteFileMeta>();
  private contentsMap = new Map<string, NoteFileContent>();
  private currentSeq = 0;
  private isLoading = true;
  private lastError: string | undefined;
  private stopFollow: (() => void) | undefined;
  private disposed = false;

  readonly id: NoteId;
  readonly version: number | undefined;

  constructor(id: NoteId, version?: number) {
    this.id = id;
    this.version = version;
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private snapshotCache: DirectorySnapshot = {
    seq: 0,
    files: new Map(),
    contents: new Map(),
    loading: true,
    error: undefined,
  };

  private notify() {
    this.snapshotCache = {
      seq: this.currentSeq,
      files: new Map(this.filesMap),
      contents: new Map(this.contentsMap),
      loading: this.isLoading,
      error: this.lastError,
    };
    for (const fn of this.listeners) fn();
  }

  readonly get = (): DirectorySnapshot => this.snapshotCache;

  async load(): Promise<void> {
    this.isLoading = true;
    this.lastError = undefined;
    this.notify();
    try {
      const listed = await api.note.file.list({ id: this.id });
      if (this.disposed) return;
      this.filesMap = new Map(listed.files.map((f) => [f.path, f]));
      this.currentSeq = listed.seq;

      const textPaths = listed.files.filter((f) => isTextMime(f.mime, f.path)).map((f) => f.path);
      const fetched = await Promise.all(
        textPaths.map(async (path) => {
          try {
            return await api.note.file.get({
              id: this.id,
              path,
              ...(this.version !== undefined ? { version: this.version } : {}),
            });
          } catch {
            return undefined;
          }
        }),
      );
      if (this.disposed) return;
      this.contentsMap = new Map();
      for (const item of fetched) {
        if (item) this.contentsMap.set(item.path, item);
      }
      this.isLoading = false;
      this.notify();
      if (this.version === undefined) {
        this.startFollow();
      }
    } catch (e) {
      if (this.disposed) return;
      this.isLoading = false;
      this.lastError = reasonOf(e);
      this.notify();
    }
  }

  private startFollow() {
    this.stopFollow?.();
    this.stopFollow = followNote(String(this.id), this.currentSeq, (ev) => {
      void this.handleEvent(ev);
    });
  }

  private async handleEvent(ev: NoteEvent): Promise<void> {
    if (this.disposed) return;
    if (ev._tag === "Reset") {
      await this.load();
      return;
    }
    for (const path of ev.deleted) {
      this.filesMap.delete(path);
      this.contentsMap.delete(path);
    }
    const toFetch: string[] = [];
    for (const meta of ev.files) {
      const prev = this.contentsMap.get(meta.path);
      this.filesMap.set(meta.path, meta);
      if (isTextMime(meta.mime, meta.path) && prev?.hash !== meta.hash) {
        toFetch.push(meta.path);
      }
    }
    if (toFetch.length > 0) {
      const loaded = await Promise.all(
        toFetch.map(async (path) => {
          try {
            return await api.note.file.get({ id: this.id, path });
          } catch {
            return undefined;
          }
        }),
      );
      if (this.disposed) return;
      for (const item of loaded) {
        if (item) this.contentsMap.set(item.path, item);
      }
    }
    if (ev.seq > this.currentSeq) this.currentSeq = ev.seq;
    this.notify();
  }

  async readFile(path: string): Promise<NoteFileContent> {
    const file = await api.note.file.get({
      id: this.id,
      path,
      ...(this.version !== undefined ? { version: this.version } : {}),
    });
    if (!this.disposed) {
      this.contentsMap.set(file.path, file);
      this.notify();
    }
    return file;
  }

  async writeFiles(
    files: readonly NoteFileWriteItem[],
    opts?: { readonly origin?: string; readonly summary?: string; readonly announce?: boolean },
  ): Promise<NoteFileWriteResult> {
    const res = await api.note.file.write({
      id: this.id,
      files: [...files],
      ...(opts?.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts?.summary !== undefined ? { summary: opts.summary } : {}),
      ...(opts?.announce !== undefined ? { announce: opts.announce } : {}),
    });
    if (!this.disposed) {
      const byPath = new Map(files.map((f) => [f.path, f]));
      for (const meta of res.files) {
        this.filesMap.set(meta.path, meta);
        const written = byPath.get(meta.path);
        if (written) {
          this.contentsMap.set(meta.path, {
            noteId: this.id,
            path: meta.path,
            mime: meta.mime,
            encoding: written.encoding ?? "utf8",
            content: written.content,
            size: meta.size,
            hash: meta.hash,
            updatedAt: meta.updatedAt,
          });
        }
      }
      if (res.seq > this.currentSeq) this.currentSeq = res.seq;
      this.notify();
    }
    return res;
  }

  async deleteFile(path: string, opts?: { readonly origin?: string; readonly summary?: string }): Promise<NoteFileDeleteResult> {
    const res = await api.note.file.delete({
      id: this.id,
      path,
      ...(opts?.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts?.summary !== undefined ? { summary: opts.summary } : {}),
    });
    if (!this.disposed) {
      this.filesMap.delete(path);
      this.contentsMap.delete(path);
      if (res.seq > this.currentSeq) this.currentSeq = res.seq;
      this.notify();
    }
    return res;
  }

  dispose() {
    this.disposed = true;
    this.stopFollow?.();
    this.stopFollow = undefined;
    this.listeners.clear();
  }
}

export function useNoteDirectory(
  id: () => NoteId,
  version?: () => number | undefined,
  reloadKey?: () => number,
): {
  readonly client: Accessor<DirectoryNoteClient>;
  readonly snapshot: Accessor<DirectorySnapshot>;
} {
  const initialClient = new DirectoryNoteClient(untracked(id), version ? untracked(version) : undefined);
  const clientSig = signal<DirectoryNoteClient>(initialClient);
  const snapshot = signal<DirectorySnapshot>(initialClient.get());

  effect(() => {
    const curId = id();
    const curVer = version ? version() : undefined;
    const _reload = reloadKey ? reloadKey() : 0;
    void _reload;
    const client = new DirectoryNoteClient(curId, curVer);
    clientSig.set(client);
    snapshot.set(client.get());
    const unsub = client.subscribe(() => snapshot.set(client.get()));
    void client.load();
    return () => {
      unsub();
      client.dispose();
    };
  });

  return { client: clientSig, snapshot };
}

export interface NoteSuggestionsHandle {
  readonly suggestions: Accessor<readonly Suggestion[]>;
  readonly open: Accessor<readonly Suggestion[]>;
  readonly accept: (suggestion: SuggestionId) => Promise<Suggestion>;
  readonly reject: (suggestion: SuggestionId) => Promise<Suggestion>;
  readonly create: (input: SuggestionCreate) => Promise<Suggestion>;
}

export function useNoteSuggestions(id: () => NoteId): NoteSuggestionsHandle {
  const suggestions = signal<readonly Suggestion[]>([]);

  effect(() => {
    const currentId = id();
    let active = true;
    suggestions.set([]);
    void api.note.suggestion.list({ id: currentId }).then(
      (list) => {
        if (active) suggestions.set(list);
      },
      () => {},
    );
    const stop = followSuggestions(String(currentId), (ev) => {
      if (active) suggestions.set(ev.suggestions);
    });
    return () => {
      active = false;
      stop();
    };
  });

  const open = () => suggestions().filter((s) => s.status === "open");

  const accept = async (suggestion: SuggestionId): Promise<Suggestion> => {
    const res = await api.note.suggestion.accept({ id: untracked(id), suggestion });
    suggestions.set(untracked(suggestions).map((s) => (s.id === suggestion ? res : s)));
    return res;
  };

  const reject = async (suggestion: SuggestionId): Promise<Suggestion> => {
    const res = await api.note.suggestion.reject({ id: untracked(id), suggestion });
    suggestions.set(untracked(suggestions).map((s) => (s.id === suggestion ? res : s)));
    return res;
  };

  const create = async (input: SuggestionCreate): Promise<Suggestion> => {
    const res = await api.note.suggestion.create({ id: untracked(id), ...input });
    suggestions.set([...untracked(suggestions), res]);
    return res;
  };

  return { suggestions, open, accept, reject, create };
}

export function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "bigint") return `${val}`;
  return JSON.stringify(val) ?? "";
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const pieces = Array.from({ length: Math.ceil(bytes.length / 0x8000) }, (_, i) => String.fromCharCode(...bytes.subarray(i * 0x8000, (i + 1) * 0x8000)));
  return btoa(pieces.join(""));
}

const AttachmentPathData = z.object({ path: z.string() });

// Native save dialog via temp attachment; nsh has no browser download.
export async function saveBase64File(filename: string, mime: string, base64: string): Promise<boolean> {
  const att = await api.attachment.create({ name: filename, type: mime, data: base64 });
  const env = await transport().call("attachment.file", { id: att.id });
  if (env.bizCode !== 0) throw new Error(env.message);
  const file = AttachmentPathData.parse(env.data);
  const res = await saveFile(file.path, filename);
  return res.saved;
}

export async function saveTextFile(filename: string, mime: string, text: string): Promise<boolean> {
  return saveBase64File(filename, mime, utf8ToBase64(text));
}

export async function exportNoteDirectory(note: Note, activeVersion?: number): Promise<boolean> {
  const safeName = (note.title.trim() || "note").replace(/[\\/:*?"<>|]/gu, "-");
  const suffix = noteSuffixOf(note);
  if (note.noteType === "doc") {
    const res = await api.note.content.get({
      id: note.id,
      ...(activeVersion !== undefined && activeVersion > 0 ? { version: activeVersion } : {}),
    });
    return saveTextFile(`${safeName}${suffix}`, "text/markdown;charset=utf-8", res.content);
  }
  const listed = await api.note.file.list({ id: note.id });
  const files = await Promise.all(
    listed.files.map(async (f) => {
      try {
        return await api.note.file.get({
          id: note.id,
          path: f.path,
          ...(activeVersion !== undefined && activeVersion > 0 ? { version: activeVersion } : {}),
        });
      } catch {
        return undefined;
      }
    }),
  );
  const bundle = {
    id: note.id,
    title: note.title,
    noteType: note.noteType,
    seq: listed.seq,
    files: files.filter((f): f is NoteFileContent => f !== undefined),
  };
  return saveTextFile(`${safeName}${suffix}`, "application/json;charset=utf-8", `${JSON.stringify(bundle, null, 2)}\n`);
}

export async function exportCsvFile(name: string, rows: readonly Record<string, unknown>[]): Promise<boolean> {
  const safeName = (name.trim() || "data").replace(/[\\/:*?"<>|]/gu, "-");
  if (rows.length === 0) {
    return saveTextFile(`${safeName}.csv`, "text/csv;charset=utf-8", "");
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escapeCell = (val: unknown) => {
    const str = formatCellValue(val);
    return /[",\n\r]/u.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
  };
  const lines = [cols.map(escapeCell).join(","), ...rows.map((r) => cols.map((c) => escapeCell(r[c])).join(","))];
  return saveTextFile(`${safeName}.csv`, "text/csv;charset=utf-8", lines.join("\n"));
}

const presenceThrottleMs = 100;

export interface NotePresenceHandle {
  readonly peers: Accessor<readonly NotePresence[]>;
  readonly publish: (presence: Omit<NotePresence, "updatedAt">) => void;
  readonly clear: (peerId?: string) => void;
}

export function useNotePresence(id: () => NoteId, opts?: { readonly enabled?: () => boolean }): NotePresenceHandle {
  const peers = signal<readonly NotePresence[]>([]);
  const map = new Map<string, NotePresence>();
  let lastSentAt = 0;
  let pending: Omit<NotePresence, "updatedAt"> | undefined;
  let throttleTimer: ReturnType<typeof setTimeout> | undefined;
  let publishedPeerId: string | undefined;
  let activeNoteId = untracked(id);

  const applyEvent = (ev: NotePresenceEvent) => {
    switch (ev._tag) {
      case "Snapshot":
        map.clear();
        for (const p of ev.peers) map.set(p.id, p);
        peers.set([...map.values()]);
        return;
      case "Upsert":
        map.set(ev.peer.id, ev.peer);
        peers.set([...map.values()]);
        return;
      case "Remove":
        if (map.delete(ev.peerId)) peers.set([...map.values()]);
        return;
    }
  };

  const sendUpdate = (targetId: NoteId, presence: Omit<NotePresence, "updatedAt">) => {
    lastSentAt = Date.now();
    publishedPeerId = presence.id;
    void api.note.presence.update({ id: targetId, presence: { ...presence, updatedAt: lastSentAt } }).catch(() => {});
  };

  const flushPending = () => {
    throttleTimer = undefined;
    if (pending === undefined) return;
    const next = pending;
    pending = undefined;
    sendUpdate(activeNoteId, next);
  };

  const clear = (peerId?: string) => {
    clearTimeout(throttleTimer);
    throttleTimer = undefined;
    pending = undefined;
    const targetPeer = peerId ?? publishedPeerId;
    if (!targetPeer) return;
    if (targetPeer === publishedPeerId) publishedPeerId = undefined;
    void api.note.presence.update({ id: activeNoteId, peerId: targetPeer }).catch(() => {});
  };

  const publish = (presence: Omit<NotePresence, "updatedAt">) => {
    const now = Date.now();
    const wait = presenceThrottleMs - (now - lastSentAt);
    if (wait <= 0) {
      clearTimeout(throttleTimer);
      throttleTimer = undefined;
      pending = undefined;
      sendUpdate(activeNoteId, presence);
      return;
    }
    pending = presence;
    throttleTimer ??= setTimeout(flushPending, wait);
  };

  effect(() => {
    const currentId = id();
    const enabled = opts?.enabled ? opts.enabled() : true;
    activeNoteId = currentId;
    map.clear();
    peers.set([]);
    if (!enabled) return;
    const stop = followNotePresence(currentId, applyEvent);
    return () => {
      stop();
      clear();
    };
  });

  return { peers, publish, clear };
}

export async function createTypedNote(
  noteType: NoteType,
  title: string,
  opts?: {
    readonly parentId?: NoteId;
    readonly sortOrder?: number;
    readonly channel?: string;
    readonly issue?: string;
    readonly content?: string;
    readonly files?: readonly NoteFileWriteItem[];
  },
): Promise<Note> {
  return api.note.create({
    title,
    noteType,
    ...(opts?.parentId !== undefined ? { parentId: opts.parentId } : {}),
    ...(opts?.sortOrder !== undefined ? { sortOrder: opts.sortOrder } : {}),
    ...(opts?.content !== undefined ? { content: opts.content } : {}),
    ...(opts?.files !== undefined ? { files: [...opts.files] } : {}),
    ...(opts?.channel ? { channel: opts.channel } : {}),
    ...(opts?.issue ? { issue: opts.issue } : {}),
  });
}

export const noteDocQuery = defineQuery({
  key: (id: string) => ["note-doc", id],
  fetch: (id, context) => api.note.doc.view({ id: noteId(id) }, context),
});

export const noteLinksQuery = defineQuery({
  key: (id: string) => ["note-links", "note", id],
  fetch: (id, context) => api.note.link.list({ entityKind: "note", entityId: id }, context),
});

export interface NoteBaseQueryInput {
  readonly id: string;
  readonly sheetId?: string | undefined;
  readonly viewId?: string | undefined;
}

export const noteBaseQuery = defineQuery({
  key: (req: NoteBaseQueryInput) => ["note-base", req.id, req.sheetId ?? null, req.viewId ?? null],
  fetch: (req, context) =>
    api.note.base.view(
      {
        id: noteId(req.id),
        ...(req.sheetId !== undefined ? { sheetId: req.sheetId } : {}),
        ...(req.viewId !== undefined ? { viewId: req.viewId } : {}),
      },
      context,
    ),
});

const BaseRowStub = z.looseObject({
  id: z.string(),
  pageNoteId: z.string().optional(),
});

const BaseSheetStub = z.looseObject({
  id: z.string(),
  rows: z.array(BaseRowStub).optional(),
});

const BaseFileStub = z.looseObject({
  version: z.number().optional(),
  sheets: z.array(BaseSheetStub).optional(),
});

/** Creates a child `doc` subpage for a `base` row and records its `pageNoteId` in `structure/base.json`. */
export async function createBaseRowPage(baseNote: Note, row: BaseRow, activeSheetId?: string): Promise<NoteId> {
  const firstText = Object.values(row.cells).find((c) => c._tag === "text");
  const title = firstText && firstText._tag === "text" && firstText.value.trim() ? firstText.value.trim() : baseNote.title;
  const made = await api.note.create({ title, noteType: "doc", parentId: baseNote.id });
  try {
    const file = await api.note.file.get({ id: baseNote.id, path: "structure/base.json" });
    const parsed = BaseFileStub.safeParse(JSON.parse(file.content));
    if (parsed.success && Array.isArray(parsed.data.sheets)) {
      const targetSheet = parsed.data.sheets.find((s) => s.id === activeSheetId) ?? parsed.data.sheets[0];
      const targetRow = targetSheet?.rows?.find((r) => r.id === row.id);
      if (targetRow) {
        targetRow.pageNoteId = made.id;
        await api.note.file.write({
          id: baseNote.id,
          files: [{ path: "structure/base.json", content: `${JSON.stringify(parsed.data, null, 2)}\n`, mime: "application/json" }],
          summary: `Link row ${row.id} to page ${made.id}`,
        });
      }
    }
  } catch {
    // Fallback when base.json is absent in synthetic test mocks
  }
  return made.id;
}
