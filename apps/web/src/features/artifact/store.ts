import { createEffect, onSettled, untrack } from "solid-js";

import { starterEntriesForType } from "@vibevalley/artifact/starters";
import type {
  Artifact,
  ArtifactEntry,
  ArtifactEntryBatchResult,
  ArtifactEntryEvent,
  ArtifactEntryWriteInput,
  ArtifactId,
  ArtifactType,
  ArtifactViewContext,
} from "@vibevalley/protocol";

import { createExternal } from "#/base/external.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { followArtifactEntries } from "#/infra/gateway.ts";
import { defineAtom } from "#/state/atom.ts";

/** Live state of whichever artifact viewer is currently mounted, attached to outgoing chat/reply messages. */
export const activeArtifactViewContext = defineAtom<ArtifactViewContext | undefined>(undefined);

export function useReportViewContext(id: () => ArtifactId, compute: () => Omit<ArtifactViewContext, "artifactId">) {
  createEffect(
    () => ({ artifactId: id(), ...compute() }),
    (next) => {
      activeArtifactViewContext.set(next);
    },
  );
  onSettled(() => {
    const ownId = untrack(id);
    return () => {
      if (activeArtifactViewContext.get()?.artifactId === ownId) {
        activeArtifactViewContext.set(undefined);
      }
    };
  });
}

export interface StoreEntriesSnapshot {
  readonly seq: number;
  readonly entries: ReadonlyMap<string, ArtifactEntry>;
  readonly loading: boolean;
  readonly error: string | undefined;
}

class StoreEntryClient {
  private readonly listeners = new Set<() => void>();
  private map = new Map<string, ArtifactEntry>();
  private currentSeq = 0;
  private isLoading = true;
  private lastError: string | undefined;
  private stopFollow: (() => void) | undefined;
  private disposed = false;

  readonly id: ArtifactId;

  constructor(id: ArtifactId) {
    this.id = id;
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private notify() {
    this.snapshotCache = {
      seq: this.currentSeq,
      entries: new Map(this.map),
      loading: this.isLoading,
      error: this.lastError,
    };
    for (const fn of this.listeners) fn();
  }

  private snapshotCache: StoreEntriesSnapshot = {
    seq: 0,
    entries: new Map(),
    loading: true,
    error: undefined,
  };

  readonly get = (): StoreEntriesSnapshot => this.snapshotCache;

  async load(): Promise<void> {
    this.isLoading = true;
    this.lastError = undefined;
    this.notify();
    try {
      const snap = await api.artifact.entry.list({ id: this.id, includeValues: true });
      if (this.disposed) return;
      this.map = new Map(snap.entries.map((e) => [e.path, e]));
      this.currentSeq = snap.seq;
      this.isLoading = false;
      this.notify();
      this.startFollow();
    } catch (e) {
      if (this.disposed) return;
      this.isLoading = false;
      this.lastError = reasonOf(e);
      this.notify();
    }
  }

  private startFollow() {
    this.stopFollow?.();
    this.stopFollow = followArtifactEntries(String(this.id), this.currentSeq, (ev) => {
      void this.handleEvent(ev);
    });
  }

  private async handleEvent(ev: ArtifactEntryEvent): Promise<void> {
    if (this.disposed) return;
    if (ev._tag === "Reset") {
      await this.load();
      return;
    }
    for (const path of ev.deleted) {
      this.map.delete(path);
    }
    for (const entry of ev.entries) {
      if (entry.value === undefined && entry.kind !== "asset") {
        try {
          const full = await api.artifact.entry.get({ id: this.id, path: entry.path });
          if (!this.disposed) this.map.set(entry.path, full);
        } catch (e) {
          this.lastError = reasonOf(e);
          this.map.set(entry.path, entry);
        }
      } else {
        this.map.set(entry.path, entry);
      }
    }
    if (ev.seq > this.currentSeq) this.currentSeq = ev.seq;
    this.notify();
  }

  async batch(writes: ArtifactEntryWriteInput[], note?: string): Promise<ArtifactEntryBatchResult> {
    const res = await api.artifact.entry.batch({
      id: this.id,
      writes,
      ...(note !== undefined ? { note } : {}),
    });
    if (res.applied) {
      for (const w of writes) {
        if (w.op === "delete") this.map.delete(w.path);
      }
      for (const entry of res.entries) {
        this.map.set(entry.path, entry);
      }
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

export function useStoreEntries(id: () => ArtifactId) {
  const client = new StoreEntryClient(untrack(id));
  onSettled(() => {
    void client.load();
    return () => client.dispose();
  });
  const snapshot = createExternal(client.subscribe, client.get);
  return { client, snapshot };
}

export function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "bigint") return `${val}`;
  return JSON.stringify(val) ?? "";
}

function triggerDownload(filename: string, mime: string, text: string) {
  const a = document.createElement("a");
  a.href = `data:${mime},${encodeURIComponent(text)}`;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

export async function exportMarkdownFile(id: ArtifactId, title: string): Promise<void> {
  const res = await api.artifact.markdown.get({ id });
  const safeName = (title.trim() || "document").replace(/[\\/:*?"<>|]/gu, "-");
  triggerDownload(`${safeName}.md`, "text/markdown;charset=utf-8", res.markdown);
}

export function exportCsvFile(name: string, rows: readonly Record<string, unknown>[]): void {
  if (rows.length === 0) {
    triggerDownload(`${name}.csv`, "text/csv;charset=utf-8", "");
    return;
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escapeCell = (val: unknown) => {
    const str = formatCellValue(val);
    return /[",\n\r]/u.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
  };
  const lines = [cols.map(escapeCell).join(","), ...rows.map((r) => cols.map((c) => escapeCell(r[c])).join(","))];
  triggerDownload(`${name.replace(/[\\/:*?"<>|]/gu, "-")}.csv`, "text/csv;charset=utf-8", lines.join("\n"));
}

export async function saveVideoToLibrary(title: string, base64: string, mimeType: string): Promise<void> {
  const safeTitle = (title.trim() || "motion").replace(/[\\/:*?"<>|]/gu, "-");
  const filename = `${safeTitle}.webm`;
  const att = await api.attachment.create({ name: filename, type: mimeType || "video/webm", data: base64 });
  await api.library.item.add({ attachment: att.id, name: filename });
}

export async function createTypedArtifact(choice: ArtifactType | "html", title: string): Promise<Artifact> {
  if (choice === "html") {
    return api.artifact.create({
      title,
      kind: "html",
      display: "page",
      content: `<!doctype html>\n<html lang="zh">\n<head><meta charset="utf-8" /><title>${title}</title></head>\n<body style="padding:32px"><h1>${title}</h1><p>Ready to edit.</p></body>\n</html>`,
    });
  }
  if (choice === "docs") {
    return api.artifact.create({ title, kind: "markdown", artifactType: "docs" });
  }
  return api.artifact.create({
    title,
    kind: "store",
    artifactType: choice,
    entries: starterEntriesForType(choice, title),
  });
}
