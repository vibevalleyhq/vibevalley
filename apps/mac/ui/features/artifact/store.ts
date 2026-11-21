import { cleanup, effect, signal, untracked, type Accessor } from "nsh";
import { z } from "zod";

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
import { ArtifactEntryBatchResult as ArtifactEntryBatchResultSchema, artifactId } from "@vibevalley/protocol/schema";

import { api, reasonOf } from "../../infra/api";
import { saveFile } from "../../infra/attachmentFile";
import { createExternal } from "../../infra/base/external";
import { fetchArtifactView, followArtifactEntries } from "../../infra/gateway";
import { transport } from "../../infra/transport";
import type { ShellTheme } from "./shell";

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

export interface StoreEntriesSnapshot {
  readonly seq: number;
  readonly entries: ReadonlyMap<string, ArtifactEntry>;
  readonly loading: boolean;
  readonly error: string | undefined;
}

export class StoreEntryClient {
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

  private snapshotCache: StoreEntriesSnapshot = {
    seq: 0,
    entries: new Map(),
    loading: true,
    error: undefined,
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

export function useStoreEntries(id: () => ArtifactId): {
  readonly client: StoreEntryClient;
  readonly snapshot: Accessor<StoreEntriesSnapshot>;
} {
  const client = new StoreEntryClient(untracked(id));
  void client.load();
  cleanup(() => client.dispose());
  const snapshot = createExternal(client.subscribe, client.get);
  return { client, snapshot };
}

export function useStoreViewHtml(
  params: () =>
    | {
        readonly id: ArtifactId;
        readonly theme?: ShellTheme;
        readonly path?: string;
        readonly elementId?: string;
        readonly print?: boolean;
        readonly seq?: number;
      }
    | undefined,
): {
  readonly html: Accessor<string | undefined>;
  readonly loading: Accessor<boolean>;
  readonly error: Accessor<string | undefined>;
  readonly refetch: () => void;
} {
  const html = signal<string | undefined>(undefined);
  const loading = signal(false);
  const error = signal<string | undefined>(undefined);
  const tick = signal(0);

  let runId = 0;
  effect(() => {
    const p = params();
    tick();
    const myRun = ++runId;
    if (!p) {
      html.set(undefined);
      loading.set(false);
      error.set(undefined);
      return;
    }
    loading.set(true);
    error.set(undefined);
    void fetchArtifactView({
      id: String(p.id),
      ...(p.theme !== undefined ? { theme: p.theme } : {}),
      ...(p.path !== undefined ? { path: p.path } : {}),
      ...(p.elementId !== undefined ? { elementId: p.elementId } : {}),
      ...(p.print !== undefined ? { print: p.print } : {}),
    }).then(
      (page) => {
        if (myRun !== runId) return;
        html.set(page.content);
        loading.set(false);
      },
      (err) => {
        if (myRun !== runId) return;
        error.set(reasonOf(err));
        loading.set(false);
      },
    );
  });

  return {
    html,
    loading,
    error,
    refetch: () => tick.set(untracked(tick) + 1),
  };
}

export interface InspectedColorSwatch {
  readonly id: string;
  readonly group: string;
  readonly light: string;
  readonly dark: string;
  readonly note: string;
  readonly contrastLight?: number;
  readonly contrastDark?: number;
}

export interface InspectedTypeFamily {
  readonly id: string;
  readonly value: string;
  readonly note: string;
}

export interface InspectedTokenValue {
  readonly id: string;
  readonly value: string;
}

export interface InspectedTypeStyle {
  readonly id: string;
  readonly family: string;
  readonly size: string;
  readonly weight: string;
  readonly lineHeight: string;
  readonly letterSpacing: string;
  readonly sample: string;
}

export interface InspectedTokensSpec {
  readonly themes: readonly string[];
  readonly defaultTheme: string;
  readonly colors: readonly InspectedColorSwatch[];
  readonly families: readonly InspectedTypeFamily[];
  readonly scale: readonly InspectedTokenValue[];
  readonly styles: readonly InspectedTypeStyle[];
  readonly space: readonly InspectedTokenValue[];
  readonly radius: readonly InspectedTokenValue[];
  readonly css: string;
}

export const EMPTY_INSPECTED_TOKENS: InspectedTokensSpec = {
  themes: ["light", "dark"],
  defaultTheme: "light",
  colors: [],
  families: [],
  scale: [],
  styles: [],
  space: [],
  radius: [],
  css: "",
};

const ArtifactPageData = z.object({ content: z.string() });
const AttachmentPathData = z.object({ path: z.string() });

/** Parses design-system tokens, computes WCAG contrast ratios, and compiles CSS via the Rust server. */
export async function inspectDesignTokens(raw: string): Promise<InspectedTokensSpec> {
  const env = await transport().call("artifact.tokens.inspect", { raw });
  if (env.bizCode !== 0) throw new Error(env.message);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Rust `artifact.tokens.inspect` returns InspectedTokensSpec
  return env.data as InspectedTokensSpec;
}

/** Rewrites `data-props` defaults inside a `.dc.html` store entry via the Rust server. */
export async function writeArtifactEntryProps(input: {
  readonly id: ArtifactId;
  readonly path: string;
  readonly values: Readonly<Record<string, string | number | boolean>>;
}): Promise<ArtifactEntryBatchResult> {
  const env = await transport().call("artifact.entry.writeProps", input);
  if (env.bizCode !== 0) throw new Error(env.message);
  return ArtifactEntryBatchResultSchema.parse(env.data);
}

/** Fetches an HTML artifact's shell-wrapped page from the Rust server (`artifact.page`). */
export function useArtifactPage(
  params: () =>
    | {
        readonly id: string;
        readonly version: number;
        readonly theme: ShellTheme;
      }
    | undefined,
): {
  readonly html: Accessor<string | undefined>;
  readonly loading: Accessor<boolean>;
  readonly error: Accessor<string | undefined>;
} {
  const html = signal<string | undefined>(undefined);
  const loading = signal(false);
  const error = signal<string | undefined>(undefined);

  let runId = 0;
  effect(() => {
    const p = params();
    const myRun = ++runId;
    if (!p) {
      html.set(undefined);
      loading.set(false);
      error.set(undefined);
      return;
    }
    loading.set(true);
    error.set(undefined);
    void transport()
      .call("artifact.page", { id: p.id, version: p.version, shell: true, theme: p.theme })
      .then(async (env) => {
        if (env.bizCode === 0) return ArtifactPageData.parse(env.data).content;
        // Fixtures that only stub `artifact.content.get` return RouteNotFound (100005).
        if (env.bizCode === 100005) {
          const raw = await api.artifact.content.get({ id: artifactId(p.id), version: p.version });
          return raw.content;
        }
        throw new Error(env.message);
      })
      .then(
        (content) => {
          if (myRun !== runId) return;
          html.set(content);
          loading.set(false);
        },
        (err) => {
          if (myRun !== runId) return;
          error.set(reasonOf(err));
          loading.set(false);
        },
      );
  });

  return { html, loading, error };
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

/** Saves UTF-8 text via a temporary attachment + native host.saveFile dialog (no browser `<a download>`). */
export async function saveTextFile(filename: string, mime: string, text: string): Promise<boolean> {
  const att = await api.attachment.create({ name: filename, type: mime, data: utf8ToBase64(text) });
  const env = await transport().call("attachment.file", { id: att.id });
  if (env.bizCode !== 0) throw new Error(env.message);
  const file = AttachmentPathData.parse(env.data);
  const res = await saveFile(file.path, filename);
  return res.saved;
}

export async function exportMarkdownFile(id: ArtifactId, title: string): Promise<boolean> {
  const res = await api.artifact.markdown.get({ id });
  const safeName = (title.trim() || "document").replace(/[\\/:*?"<>|]/gu, "-");
  return saveTextFile(`${safeName}.md`, "text/markdown;charset=utf-8", res.markdown);
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

function videoExtensionFor(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("mp4")) return "mp4";
  if (lower.includes("quicktime") || lower.includes("mov")) return "mov";
  return "webm";
}

export async function saveVideoToLibrary(title: string, base64: string, mimeType: string): Promise<void> {
  const safeTitle = (title.trim() || "motion").replace(/[\\/:*?"<>|]/gu, "-");
  const mime = mimeType || "video/webm";
  const filename = `${safeTitle}.${videoExtensionFor(mime)}`;
  const att = await api.attachment.create({ name: filename, type: mime, data: base64 });
  await api.library.item.add({ attachment: att.id, name: filename });
}

export async function createTypedArtifact(
  choice: ArtifactType | "html",
  title: string,
  opts?: { readonly channel?: string; readonly issue?: string },
): Promise<Artifact> {
  const scope = {
    ...(opts?.channel ? { channel: opts.channel } : {}),
    ...(opts?.issue ? { issue: opts.issue } : {}),
  };
  if (choice === "html") {
    return api.artifact.create({
      title,
      kind: "html",
      display: "page",
      content: `<!doctype html>\n<html lang="zh">\n<head><meta charset="utf-8" /><title>${title}</title></head>\n<body style="padding:32px"><h1>${title}</h1><p>Ready to edit.</p></body>\n</html>`,
      ...scope,
    });
  }
  if (choice === "docs") {
    return api.artifact.create({ title, kind: "markdown", artifactType: "docs", ...scope });
  }
  return api.artifact.create({
    title,
    kind: "store",
    artifactType: choice,
    ...scope,
  });
}
