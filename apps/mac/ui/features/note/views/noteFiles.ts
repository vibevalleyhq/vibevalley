import { effect, signal, untracked, type Accessor } from "nsh";
import { z } from "zod";

import type { NoteEvent, NoteFileContent, NoteFileDeleteResult, NoteFileMeta, NoteFileWriteItem, NoteFileWriteResult, NoteId } from "@vibevalley/protocol";

import { api, reasonOf } from "../../../infra/api";
import { saveFile } from "../../../infra/attachmentFile";
import { followNote } from "../../../infra/gateway";
import { transport } from "../../../infra/transport";

function isTextMime(mime: string, path: string): boolean {
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/javascript" || mime === "image/svg+xml") return true;
  return /\.(?:md|markdown|json|html|htm|css|js|mjs|ts|tsx|svg|csv|txt|yaml|yml)$/iu.test(path);
}

interface NoteDirectorySnapshot {
  readonly seq: number;
  readonly files: ReadonlyMap<string, NoteFileMeta>;
  readonly contents: ReadonlyMap<string, NoteFileContent>;
  readonly loading: boolean;
  readonly error: string | undefined;
}

export class NoteDirectoryClient {
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

  private snapshotCache: NoteDirectorySnapshot = {
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

  readonly get = (): NoteDirectorySnapshot => this.snapshotCache;

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
  readonly client: Accessor<NoteDirectoryClient>;
  readonly snapshot: Accessor<NoteDirectorySnapshot>;
} {
  const initialClient = new NoteDirectoryClient(untracked(id), version ? untracked(version) : undefined);
  const clientSig = signal<NoteDirectoryClient>(initialClient);
  const snapshot = signal<NoteDirectorySnapshot>(initialClient.get());

  effect(() => {
    const curId = id();
    const curVer = version ? version() : undefined;
    const _reload = reloadKey ? reloadKey() : 0;
    void _reload;
    const client = new NoteDirectoryClient(curId, curVer);
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

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const pieces = Array.from({ length: Math.ceil(bytes.length / 0x8000) }, (_, i) => String.fromCharCode(...bytes.subarray(i * 0x8000, (i + 1) * 0x8000)));
  return btoa(pieces.join(""));
}

const AttachmentPathData = z.object({ path: z.string() });

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

export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const SANDBOX_POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`;

function injectSandboxPolicy(page: string): string {
  const head = /<head(\s[^>]*)?>/iu.exec(page);
  if (head) return page.slice(0, head.index + head[0].length) + SANDBOX_POLICY_META + page.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(page);
  if (doctype) return doctype[0] + SANDBOX_POLICY_META + page.slice(doctype[0].length);
  return SANDBOX_POLICY_META + page;
}

function escapeCloseTag(raw: string, tag: "style" | "script"): string {
  return raw.replace(new RegExp(`</${tag}`, "giu"), `<\\/${tag}`);
}

function lookupRelFile(files: ReadonlyMap<string, string>, rawRef: string): string | undefined {
  const normalized = rawRef.replace(/^(?:\.\.\/)+/u, "").replace(/^\.\//u, "");
  return files.get(`structure/${normalized}`) ?? files.get(normalized) ?? files.get(`asset/${normalized}`);
}

/** Assembles a self-contained CSP-sandboxed HTML document with inlined local assets and `connect-src 'none'`. */
export function buildSandboxedHtml(files: ReadonlyMap<string, string>, entryPath?: string): string {
  const rawHtml =
    (entryPath !== undefined ? files.get(entryPath) : undefined) ??
    files.get("structure/index.html") ??
    '<!doctype html><html><head><meta charset="utf-8" /></head><body><main id="app"></main></body></html>';

  let assembled = rawHtml.replace(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/giu, (match, rel: string) => {
    const css = lookupRelFile(files, rel);
    return css !== undefined ? `<style>\n${escapeCloseTag(css, "style")}\n</style>` : match;
  });

  assembled = assembled.replace(/<img\b([^>]*)src=["']([^"']+\.svg)["']([^>]*)>/giu, (match, before: string, rel: string, after: string) => {
    const svg = lookupRelFile(files, rel);
    if (svg === undefined) return match;
    return `<img${before}src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}"${after}>`;
  });

  assembled = assembled.replace(/<script\b([^>]*)src=["']([^"']+\.m?js)["']([^>]*)><\/script>/giu, (match, before: string, rel: string, after: string) => {
    const js = lookupRelFile(files, rel);
    if (js === undefined) return match;
    const isModule = /\btype=["']module["']/iu.test(`${before} ${after}`);
    return `<script${isModule ? ' type="module"' : ""}>\n${escapeCloseTag(js, "script")}\n</script>`;
  });

  return injectSandboxPolicy(assembled);
}
