import { cleanup, effect, signal, untracked, type Accessor } from "nsh";
import { z } from "zod";

import type {
  BaseRow,
  Note,
  NoteFileContent,
  NoteFileWriteItem,
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

import { api } from "../../infra/api";
import { saveFile } from "../../infra/attachmentFile";
import { followNotePresence, followSuggestions } from "../../infra/gateway";
import { defineQuery } from "../../infra/query";
import { transport } from "../../infra/transport";
import { noteSuffixOf } from "./html";

/** Live state of whichever note viewer is currently mounted, attached to outgoing chat/reply messages. */
export const activeNoteViewContext = signal<NoteViewContext | undefined>(undefined);

/** Monotonic: consumers react to a bump, never to the number itself. */
export const noteChatFocus = signal(0);

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

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const pieces = Array.from({ length: Math.ceil(bytes.length / 0x8000) }, (_, i) => String.fromCharCode(...bytes.subarray(i * 0x8000, (i + 1) * 0x8000)));
  return btoa(pieces.join(""));
}

const AttachmentPathData = z.object({ path: z.string() });

// Native save dialog via temp attachment; nsh has no browser download.
async function saveBase64File(filename: string, mime: string, base64: string): Promise<boolean> {
  const att = await api.attachment.create({ name: filename, type: mime, data: base64 });
  const env = await transport().call("attachment.file", { id: att.id });
  if (env.bizCode !== 0) throw new Error(env.message);
  const file = AttachmentPathData.parse(env.data);
  const res = await saveFile(file.path, filename);
  return res.saved;
}

async function saveTextFile(filename: string, mime: string, text: string): Promise<boolean> {
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
        ...(req.sheetId !== undefined && req.sheetId !== "" ? { sheetId: req.sheetId } : {}),
        ...(req.viewId !== undefined && req.viewId !== "" ? { viewId: req.viewId } : {}),
      },
      context,
    ),
});

const BaseViewRefStub = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["table", "board", "gallery", "timeline"]),
});

const BaseSheetViewsStub = z.object({
  id: z.string(),
  views: z.array(BaseViewRefStub).optional(),
});

const BaseViewsDocStub = z.object({
  sheets: z.array(BaseSheetViewsStub).optional(),
});

export type BaseViewSummaryRef = z.output<typeof BaseViewRefStub>;

export const noteBaseSheetViewsQuery = defineQuery({
  key: (id: string) => ["note-base-views", id],
  fetch: async (id, context): Promise<ReadonlyMap<string, readonly BaseViewSummaryRef[]>> => {
    const file = await api.note.file.get({ id: noteId(id), path: "structure/base.json" }, context);
    const parsed = BaseViewsDocStub.safeParse(JSON.parse(file.content));
    const map = new Map<string, readonly BaseViewSummaryRef[]>();
    if (parsed.success && Array.isArray(parsed.data.sheets)) {
      for (const sh of parsed.data.sheets) {
        if (sh.views) map.set(sh.id, sh.views);
      }
    }
    return map;
  },
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
