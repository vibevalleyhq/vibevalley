import { cleanup, effect, signal, untracked, type Accessor } from "nsh";
import { z } from "zod";

import type {
  Artifact,
  ArtifactEvent,
  ArtifactFileContent,
  ArtifactFileDeleteResult,
  ArtifactFileMeta,
  ArtifactFileWriteItem,
  ArtifactFileWriteResult,
  ArtifactId,
  ArtifactPresence,
  ArtifactPresenceEvent,
  ArtifactType,
  ArtifactViewContext,
  Suggestion,
  SuggestionCreate,
  SuggestionId,
} from "@vibevalley/protocol";

import { api, reasonOf } from "../../infra/api";
import { saveFile } from "../../infra/attachmentFile";
import { followArtifact, followArtifactPresence, followSuggestions } from "../../infra/gateway";
import { transport } from "../../infra/transport";
import { artifactSuffixOf } from "./html";

/** Live state of whichever artifact viewer is currently mounted, attached to outgoing chat/reply messages. */
export const activeArtifactViewContext = signal<ArtifactViewContext | undefined>(undefined);

/** Monotonic: consumers react to a bump, never to the number itself. */
export const artifactChatFocus = signal(0);

export function requestArtifactChatFocus(): void {
  artifactChatFocus.set(untracked(artifactChatFocus) + 1);
}

export function clearActiveArtifactViewContext(): void {
  activeArtifactViewContext.set(undefined);
}

export function useReportViewContext(id: () => ArtifactId, compute: () => Omit<ArtifactViewContext, "artifactId">) {
  effect(() => {
    const next: ArtifactViewContext = { artifactId: id(), ...compute() };
    activeArtifactViewContext.set(next);
  });
  cleanup(() => {
    const ownId = untracked(id);
    if (untracked(activeArtifactViewContext)?.artifactId === ownId) {
      activeArtifactViewContext.set(undefined);
    }
  });
}

function isTextMime(mime: string, path: string): boolean {
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/javascript" || mime === "image/svg+xml") return true;
  return /\.(?:md|markdown|json|html|htm|css|js|mjs|ts|tsx|svg|csv|txt|yaml|yml)$/iu.test(path);
}

export interface DirectorySnapshot {
  readonly seq: number;
  readonly files: ReadonlyMap<string, ArtifactFileMeta>;
  readonly contents: ReadonlyMap<string, ArtifactFileContent>;
  readonly loading: boolean;
  readonly error: string | undefined;
}

export class DirectoryArtifactClient {
  private readonly listeners = new Set<() => void>();
  private filesMap = new Map<string, ArtifactFileMeta>();
  private contentsMap = new Map<string, ArtifactFileContent>();
  private currentSeq = 0;
  private isLoading = true;
  private lastError: string | undefined;
  private stopFollow: (() => void) | undefined;
  private disposed = false;

  readonly id: ArtifactId;
  readonly version: number | undefined;

  constructor(id: ArtifactId, version?: number) {
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
      const listed = await api.artifact.file.list({ id: this.id });
      if (this.disposed) return;
      this.filesMap = new Map(listed.files.map((f) => [f.path, f]));
      this.currentSeq = listed.seq;

      const textPaths = listed.files.filter((f) => isTextMime(f.mime, f.path)).map((f) => f.path);
      const fetched = await Promise.all(
        textPaths.map(async (path) => {
          try {
            return await api.artifact.file.get({
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
    this.stopFollow = followArtifact(String(this.id), this.currentSeq, (ev) => {
      void this.handleEvent(ev);
    });
  }

  private async handleEvent(ev: ArtifactEvent): Promise<void> {
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
            return await api.artifact.file.get({ id: this.id, path });
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

  async readFile(path: string): Promise<ArtifactFileContent> {
    const file = await api.artifact.file.get({
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
    files: readonly ArtifactFileWriteItem[],
    opts?: { readonly origin?: string; readonly summary?: string; readonly announce?: boolean },
  ): Promise<ArtifactFileWriteResult> {
    const res = await api.artifact.file.write({
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
            artifactId: this.id,
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

  async deleteFile(path: string, opts?: { readonly origin?: string; readonly summary?: string }): Promise<ArtifactFileDeleteResult> {
    const res = await api.artifact.file.delete({
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

export function useArtifactDirectory(
  id: () => ArtifactId,
  version?: () => number | undefined,
): {
  readonly client: Accessor<DirectoryArtifactClient>;
  readonly snapshot: Accessor<DirectorySnapshot>;
} {
  const initialClient = new DirectoryArtifactClient(untracked(id), version ? untracked(version) : undefined);
  const clientSig = signal<DirectoryArtifactClient>(initialClient);
  const snapshot = signal<DirectorySnapshot>(initialClient.get());

  effect(() => {
    const curId = id();
    const curVer = version ? version() : undefined;
    const client = new DirectoryArtifactClient(curId, curVer);
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

export interface ArtifactSuggestionsHandle {
  readonly suggestions: Accessor<readonly Suggestion[]>;
  readonly open: Accessor<readonly Suggestion[]>;
  readonly accept: (suggestion: SuggestionId) => Promise<Suggestion>;
  readonly reject: (suggestion: SuggestionId) => Promise<Suggestion>;
  readonly create: (input: SuggestionCreate) => Promise<Suggestion>;
}

export function useArtifactSuggestions(id: () => ArtifactId): ArtifactSuggestionsHandle {
  const suggestions = signal<readonly Suggestion[]>([]);

  effect(() => {
    const currentId = id();
    let active = true;
    suggestions.set([]);
    void api.artifact.suggestion.list({ id: currentId }).then(
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
    const res = await api.artifact.suggestion.accept({ id: untracked(id), suggestion });
    suggestions.set(untracked(suggestions).map((s) => (s.id === suggestion ? res : s)));
    return res;
  };

  const reject = async (suggestion: SuggestionId): Promise<Suggestion> => {
    const res = await api.artifact.suggestion.reject({ id: untracked(id), suggestion });
    suggestions.set(untracked(suggestions).map((s) => (s.id === suggestion ? res : s)));
    return res;
  };

  const create = async (input: SuggestionCreate): Promise<Suggestion> => {
    const res = await api.artifact.suggestion.create({ id: untracked(id), ...input });
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

export async function exportArtifactDirectory(artifact: Artifact, activeVersion?: number): Promise<boolean> {
  const safeName = (artifact.title.trim() || "artifact").replace(/[\\/:*?"<>|]/gu, "-");
  const suffix = artifactSuffixOf(artifact);
  if (artifact.artifactType === "docs" || artifact.artifactType === "prototype") {
    const res = await api.artifact.content.get({
      id: artifact.id,
      ...(activeVersion !== undefined && activeVersion > 0 ? { version: activeVersion } : {}),
    });
    const mime = artifact.artifactType === "prototype" ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8";
    return saveTextFile(`${safeName}${suffix}`, mime, res.content);
  }
  const listed = await api.artifact.file.list({ id: artifact.id });
  const files = await Promise.all(
    listed.files.map(async (f) => {
      try {
        return await api.artifact.file.get({
          id: artifact.id,
          path: f.path,
          ...(activeVersion !== undefined && activeVersion > 0 ? { version: activeVersion } : {}),
        });
      } catch {
        return undefined;
      }
    }),
  );
  const bundle = {
    id: artifact.id,
    title: artifact.title,
    artifactType: artifact.artifactType,
    seq: listed.seq,
    files: files.filter((f): f is ArtifactFileContent => f !== undefined),
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

export interface ArtifactPresenceHandle {
  readonly peers: Accessor<readonly ArtifactPresence[]>;
  readonly publish: (presence: Omit<ArtifactPresence, "updatedAt">) => void;
  readonly clear: (peerId?: string) => void;
}

export function useArtifactPresence(id: () => ArtifactId, opts?: { readonly enabled?: () => boolean }): ArtifactPresenceHandle {
  const peers = signal<readonly ArtifactPresence[]>([]);
  const map = new Map<string, ArtifactPresence>();
  let lastSentAt = 0;
  let pending: Omit<ArtifactPresence, "updatedAt"> | undefined;
  let throttleTimer: ReturnType<typeof setTimeout> | undefined;
  let publishedPeerId: string | undefined;
  let activeArtifactId = untracked(id);

  const applyEvent = (ev: ArtifactPresenceEvent) => {
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

  const sendUpdate = (targetId: ArtifactId, presence: Omit<ArtifactPresence, "updatedAt">) => {
    lastSentAt = Date.now();
    publishedPeerId = presence.id;
    void api.artifact.presence.update({ id: targetId, presence: { ...presence, updatedAt: lastSentAt } }).catch(() => {});
  };

  const flushPending = () => {
    throttleTimer = undefined;
    if (pending === undefined) return;
    const next = pending;
    pending = undefined;
    sendUpdate(activeArtifactId, next);
  };

  const clear = (peerId?: string) => {
    clearTimeout(throttleTimer);
    throttleTimer = undefined;
    pending = undefined;
    const targetPeer = peerId ?? publishedPeerId;
    if (!targetPeer) return;
    if (targetPeer === publishedPeerId) publishedPeerId = undefined;
    void api.artifact.presence.update({ id: activeArtifactId, peerId: targetPeer }).catch(() => {});
  };

  const publish = (presence: Omit<ArtifactPresence, "updatedAt">) => {
    const now = Date.now();
    const wait = presenceThrottleMs - (now - lastSentAt);
    if (wait <= 0) {
      clearTimeout(throttleTimer);
      throttleTimer = undefined;
      pending = undefined;
      sendUpdate(activeArtifactId, presence);
      return;
    }
    pending = presence;
    throttleTimer ??= setTimeout(flushPending, wait);
  };

  effect(() => {
    const currentId = id();
    const enabled = opts?.enabled ? opts.enabled() : true;
    activeArtifactId = currentId;
    map.clear();
    peers.set([]);
    if (!enabled) return;
    const stop = followArtifactPresence(currentId, applyEvent);
    return () => {
      stop();
      clear();
    };
  });

  return { peers, publish, clear };
}

export async function createTypedArtifact(
  artifactType: ArtifactType,
  title: string,
  opts?: { readonly channel?: string; readonly issue?: string; readonly content?: string; readonly files?: readonly ArtifactFileWriteItem[] },
): Promise<Artifact> {
  return api.artifact.create({
    title,
    artifactType,
    ...(opts?.content !== undefined ? { content: opts.content } : {}),
    ...(opts?.files !== undefined ? { files: [...opts.files] } : {}),
    ...(opts?.channel ? { channel: opts.channel } : {}),
    ...(opts?.issue ? { issue: opts.issue } : {}),
  });
}
