import { z } from "zod";

import { shellThemeOf } from "@vibevalley/artifact/shell";
import {
  applyJsonMergePatch,
  canonicalJson,
  entryMaxBytes,
  entryMaxCount,
  entryPathProblem,
  formatStoreSummary,
  inferEntryKind,
  inferEntryMime,
  inlineEventMaxBytes,
} from "@vibevalley/artifact/store";
import { renderStoreArtifactHtml, sanitizeWhiteboardSvg, storeHtmlProblem, storeViewHeaders } from "@vibevalley/artifact/viewers";
import { Hub, Semaphore, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import { dayMs } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";

import { BizCode, missing, refuseIn } from "#/base/errors.ts";
import { jsonOf, jsonText } from "#/base/json.ts";
import { bounded } from "#/core/core.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Attachment } from "#/platform/attachment/attachment.ts";
import * as qa from "#db/artifact.sql.ts";
import * as qe from "#db/artifact_entry.sql.ts";
import * as qec from "#db/artifact_entry_change.sql.ts";

const refused = refuseIn(BizCode.ArtifactRefused);
const pathsOf = jsonOf(z.array(z.string()), "artifact_entry_change.paths");
const deletedOf = jsonOf(z.array(z.string()), "artifact_entry_change.deleted");
const keptDays = 30;
const catchUpMax = 200;

export interface StoreMaker {
  readonly from: string;
  readonly by: string;
  readonly run?: string;
}

export interface StoreViewInput {
  readonly theme?: string | null;
  readonly path?: string | null;
  readonly elementId?: string | null;
  readonly print?: boolean;
  readonly origin?: string;
}

export interface StoreViewResult {
  readonly html: string;
  readonly headers: Record<string, string>;
}

export interface EntryStore {
  readonly count: (id: T.ArtifactId) => Promise<number>;
  readonly summary: (row: qa.ArtifactResult) => Promise<string>;
  readonly list: (req: T.ArtifactEntryListRequest) => Promise<T.ArtifactEntrySnapshot>;
  readonly get: (req: T.ArtifactEntryGetRequest) => Promise<T.ArtifactEntry>;
  readonly batch: (maker: StoreMaker, req: T.ArtifactEntryBatchRequest) => Promise<T.ArtifactEntryBatchResult>;
  readonly follow: (id: T.ArtifactId, after: number, signal?: AbortSignal) => AsyncIterable<T.ArtifactEntryEvent>;
  readonly renderView: (id: T.ArtifactId, input: StoreViewInput) => Promise<StoreViewResult>;
  readonly close: () => Promise<void>;
}

export interface EntryStoreDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
  readonly attachment: Attachment;
  readonly channel: Channel;
  readonly found: (id: T.ArtifactId) => Promise<qa.ArtifactResult>;
  readonly assemble: (row: qa.ArtifactResult) => Promise<T.Artifact>;
}

function entryOf(r: qe.ArtifactEntriesResult, includeValue: boolean): T.ArtifactEntry {
  return {
    artifactId: r.artifact_id,
    path: r.path,
    kind: r.kind,
    mime: r.mime,
    size: r.size,
    rev: r.rev,
    updatedBy: r.updated_by,
    updated: r.updated_at,
    ...(includeValue && r.value !== null ? { value: r.value } : {}),
    ...(r.attachment_id !== null ? { attachmentId: r.attachment_id } : {}),
  };
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeWhiteboardElementJson(artifactType: T.ArtifactType | undefined, path: string, canonicalText: string): string {
  if (artifactType !== "whiteboard" || !path.startsWith("elements/")) return canonicalText;
  const parsed: unknown = JSON.parse(canonicalText);
  if (!isPlainRecord(parsed)) return canonicalText;
  if (parsed.type === "svg" && typeof parsed.svg === "string") {
    return JSON.stringify({ ...parsed, svg: sanitizeWhiteboardSvg(parsed.svg) });
  }
  if (parsed.type === "html" && typeof parsed.html === "string") {
    const hp = storeHtmlProblem(parsed.html);
    if (hp) throw refused(hp);
  }
  return canonicalText;
}

export async function makeEntryStore(deps: EntryStoreDeps): Promise<EntryStore> {
  const { db, clock, attachment: kept, channel: chat, found, assemble } = deps;
  const log = deps.log.child("artifact/entries");
  const lock = new Semaphore(1);
  const tasks = new TaskGroup({ name: "artifact.entries", onError: (task, e) => log.warn(`${task} failed`, e) });
  const changes = new Hub<{
    readonly artifact: T.ArtifactId;
    readonly seq: number;
    readonly entries: T.ArtifactEntry[];
    readonly deleted: string[];
  }>();

  tasks.run("artifact.entries.prune", async (signal) => {
    for (;;) {
      const before = clock.now() - keptDays * dayMs;
      await qec.pruneArtifactEntryChanges(db.sql, { before });
      await clock.sleep(dayMs, signal);
    }
  });

  const foundStore = async (id: T.ArtifactId) => {
    const row = await found(id);
    if (row.body !== "store") throw refused(t("server.artifact.notStore", { title: row.title }));
    return row;
  };

  const checkPath = (path: string) => {
    const why = entryPathProblem(path);
    if (why) throw refused(t("server.artifact.entry.badPath", { path, why }));
  };

  const words = (base: string, note: string | undefined) => (note ? t("server.artifact.withNote", { said: base, note }) : base);

  const batchLocked = async (maker: StoreMaker, req: T.ArtifactEntryBatchRequest): Promise<T.ArtifactEntryBatchResult> => {
    const row = await foundStore(req.id);
    if (req.writes.length === 0) return { applied: true, seq: row.seq, entries: [], conflicts: [] };

    for (const w of req.writes) {
      checkPath(w.path);
      if (w.op === "copy") {
        if (!w.from || w.from.trim() === "") throw refused(t("server.artifact.entry.noFrom", { path: w.path }));
        checkPath(w.from);
      }
    }

    let eventPayload:
      | {
          readonly seq: number;
          readonly eventEntries: T.ArtifactEntry[];
          readonly removedPaths: string[];
        }
      | undefined;

    const result = await db.tx(async (): Promise<T.ArtifactEntryBatchResult> => {
      const currentRows = await qe.artifactEntries(db.sql, { artifact_id: req.id });
      const working = new Map<string, qe.ArtifactEntriesResult>(currentRows.map((r) => [r.path, r]));
      const conflicts: T.ArtifactEntryBatchResult["conflicts"] = [];

      // Check optimistic concurrency preconditions against the current snapshot before mutating any entry.
      const seenPaths = new Set<string>();
      for (const w of req.writes) {
        if (w.ifRev === undefined || seenPaths.has(w.path)) continue;
        seenPaths.add(w.path);
        const existing = working.get(w.path);
        const actualRev = existing?.rev ?? 0;
        if (w.ifRev !== actualRev) {
          conflicts.push({
            path: w.path,
            expectedRev: w.ifRev,
            actualRev,
            current: existing ? entryOf(existing, true) : null,
          });
        }
      }
      if (conflicts.length > 0) {
        return { applied: false, seq: row.seq, entries: [], conflicts };
      }

      // Resolve any referenced attachments upfront so `working` mutations stay synchronous without read-await-write.
      const resolvedAssets = new Map<string, T.Attachment>();
      for (const w of req.writes) {
        if (w.op !== "set") continue;
        const candidateKind = w.kind ?? working.get(w.path)?.kind ?? inferEntryKind(w.path);
        if (candidateKind !== "asset") continue;
        if (w.value === undefined) throw refused(t("server.artifact.entry.noValue", { path: w.path }));
        const attId = w.value.trim();
        if (resolvedAssets.has(attId)) continue;
        let att: T.Attachment | undefined;
        try {
          [att] = await kept.of([attId]);
        } catch {
          throw refused(t("server.artifact.entry.noAttachment", { id: attId, path: w.path }));
        }
        if (!att) throw refused(t("server.artifact.entry.noAttachment", { id: attId, path: w.path }));
        resolvedAssets.set(attId, att);
      }

      const now = clock.now();
      const upsertedPaths = new Set<string>();
      const deletedPaths = new Set<string>();

      for (const w of req.writes) {
        switch (w.op) {
          case "delete": {
            if (working.has(w.path)) {
              working.delete(w.path);
              upsertedPaths.delete(w.path);
              deletedPaths.add(w.path);
            }
            break;
          }
          case "copy": {
            const fromPath = w.from ?? "";
            const src = working.get(fromPath);
            if (!src) throw missing(t("server.artifact.entry.missing", { title: row.title, path: fromPath }), [], BizCode.ArtifactNotFound);
            const prev = working.get(w.path);
            const nextKind = w.kind ?? src.kind;
            const nextMime = w.mime?.trim() || src.mime || inferEntryMime(w.path, nextKind);
            working.set(w.path, {
              ...src,
              path: w.path,
              kind: nextKind,
              mime: nextMime,
              rev: (prev?.rev ?? 0) + 1,
              updated_by: maker.by,
              updated_at: now,
            });
            deletedPaths.delete(w.path);
            upsertedPaths.add(w.path);
            break;
          }
          case "set": {
            if (w.value === undefined) throw refused(t("server.artifact.entry.noValue", { path: w.path }));
            const prev = working.get(w.path);
            const kind = w.kind ?? prev?.kind ?? inferEntryKind(w.path);
            const mime = w.mime?.trim() || inferEntryMime(w.path, kind);
            if (kind === "asset") {
              const attId = w.value.trim();
              const att = resolvedAssets.get(attId);
              if (!att) throw refused(t("server.artifact.entry.noAttachment", { id: attId, path: w.path }));
              working.set(w.path, {
                artifact_id: req.id,
                path: w.path,
                kind: "asset",
                mime: w.mime?.trim() || att.type || mime,
                value: null,
                attachment_id: att.id,
                size: att.size,
                rev: (prev?.rev ?? 0) + 1,
                updated_by: maker.by,
                updated_at: now,
              });
            } else if (kind === "json") {
              const canon = canonicalJson(w.value);
              if (!canon.ok) throw refused(t("server.artifact.entry.badJson", { path: w.path, why: canon.why }));
              const checkedJson = sanitizeWhiteboardElementJson(row.artifact_type ?? undefined, w.path, canon.value);
              const size = Buffer.byteLength(checkedJson, "utf8");
              if (size > entryMaxBytes) throw refused(t("server.artifact.entry.tooBig", { path: w.path, kb: Math.round(entryMaxBytes / 1024) }));
              working.set(w.path, {
                artifact_id: req.id,
                path: w.path,
                kind: "json",
                mime,
                value: checkedJson,
                attachment_id: null,
                size,
                rev: (prev?.rev ?? 0) + 1,
                updated_by: maker.by,
                updated_at: now,
              });
            } else {
              const textVal = mime === "image/svg+xml" || w.path.endsWith(".svg") ? sanitizeWhiteboardSvg(w.value) : w.value;
              const size = Buffer.byteLength(textVal, "utf8");
              if (size > entryMaxBytes) throw refused(t("server.artifact.entry.tooBig", { path: w.path, kb: Math.round(entryMaxBytes / 1024) }));
              if (mime === "text/html" || w.path.endsWith(".html")) {
                const hp = storeHtmlProblem(textVal);
                if (hp) throw refused(hp);
              }
              working.set(w.path, {
                artifact_id: req.id,
                path: w.path,
                kind: "text",
                mime,
                value: textVal,
                attachment_id: null,
                size,
                rev: (prev?.rev ?? 0) + 1,
                updated_by: maker.by,
                updated_at: now,
              });
            }
            deletedPaths.delete(w.path);
            upsertedPaths.add(w.path);
            break;
          }
          case "patch": {
            if (w.value === undefined) throw refused(t("server.artifact.entry.noValue", { path: w.path }));
            const prev = working.get(w.path);
            const kind = prev?.kind ?? w.kind ?? inferEntryKind(w.path);
            if (kind !== "json") throw refused(t("server.artifact.entry.notJson", { path: w.path, kind }));
            const merged = applyJsonMergePatch(prev?.value ?? undefined, w.value);
            if (!merged.ok) throw refused(t("server.artifact.entry.badJson", { path: w.path, why: merged.why }));
            const checkedJson = sanitizeWhiteboardElementJson(row.artifact_type ?? undefined, w.path, merged.value);
            const size = Buffer.byteLength(checkedJson, "utf8");
            if (size > entryMaxBytes) throw refused(t("server.artifact.entry.tooBig", { path: w.path, kb: Math.round(entryMaxBytes / 1024) }));
            const mime = w.mime?.trim() || prev?.mime || "application/json";
            working.set(w.path, {
              artifact_id: req.id,
              path: w.path,
              kind: "json",
              mime,
              value: checkedJson,
              attachment_id: null,
              size,
              rev: (prev?.rev ?? 0) + 1,
              updated_by: maker.by,
              updated_at: now,
            });
            deletedPaths.delete(w.path);
            upsertedPaths.add(w.path);
            break;
          }
        }
      }

      if (working.size > entryMaxCount) {
        throw refused(t("server.artifact.entry.tooMany", { max: entryMaxCount }));
      }
      if (upsertedPaths.size === 0 && deletedPaths.size === 0) {
        return { applied: true, seq: row.seq, entries: [], conflicts: [] };
      }

      const removedPaths = [...deletedPaths].toSorted();
      const changedPaths = [...upsertedPaths].toSorted();

      for (const p of removedPaths) {
        await qe.deleteArtifactEntry(db.sql, { artifact_id: req.id, path: p });
      }
      for (const p of changedPaths) {
        const next = working.get(p);
        if (next) await qe.upsertArtifactEntry(db.sql, next);
      }

      const seq = row.seq + 1;
      await qec.addArtifactEntryChange(db.sql, {
        artifact_id: req.id,
        seq,
        actor: maker.by,
        paths: jsonText(changedPaths),
        deleted: jsonText(removedPaths),
        created_at: now,
      });
      await qa.artifactAccepted(db.sql, { id: req.id, seq, updated_at: now });

      const writtenRows = changedPaths.length > 0 ? await qe.artifactEntriesByPaths(db.sql, { artifact_id: req.id, paths: changedPaths }) : [];
      const fullEntries = writtenRows.map((r) => entryOf(r, true));
      const eventEntries = writtenRows.map((r) => entryOf(r, r.size <= inlineEventMaxBytes));
      eventPayload = { seq, eventEntries, removedPaths };
      return { applied: true, seq, entries: fullEntries, conflicts: [] };
    });

    if (eventPayload) {
      changes.publish({
        artifact: req.id,
        seq: eventPayload.seq,
        entries: eventPayload.eventEntries,
        deleted: eventPayload.removedPaths,
      });
      if (req.announce === true) {
        const channel = await chat.placeOf(maker.from, row.channel_id ?? "");
        const note = req.note?.trim() || undefined;
        const card: T.ArtifactCard = {
          id: row.id,
          title: row.title,
          body: "store",
          version: eventPayload.seq,
          note: note ?? "",
          ...(row.artifact_type !== null ? { artifactType: row.artifact_type } : {}),
        };
        const { message: said } = await chat.post({
          from: maker.from,
          channel,
          text: words(t("server.artifact.entry.updated", { title: row.title, seq: eventPayload.seq }), note),
          made: { card },
          ...(maker.run ? { run: maker.run } : {}),
        });
        if (row.message_id === null) await qa.artifactSaid(db.sql, { id: row.id, message_id: said.id });
      }
    }

    return result;
  };

  async function* follow(id: T.ArtifactId, after: number, signal?: AbortSignal): AsyncGenerator<T.ArtifactEntryEvent> {
    await foundStore(id);
    const live = changes.subscribe();
    try {
      const missed = await qec.artifactEntryChangesAfter(db.sql, { artifact_id: id, seq: after, n: catchUpMax + 1 });
      if (missed.length > catchUpMax) {
        yield { _tag: "Reset" };
        return;
      }
      const upto = missed.at(-1)?.seq ?? after;
      for (const change of missed) {
        const changedPaths = pathsOf(change.paths);
        const deleted = deletedOf(change.deleted);
        const rows = changedPaths.length > 0 ? await qe.artifactEntriesByPaths(db.sql, { artifact_id: id, paths: changedPaths }) : [];
        yield {
          _tag: "Entries",
          seq: change.seq,
          entries: rows.map((r) => entryOf(r, r.size <= inlineEventMaxBytes)),
          deleted,
        };
      }
      for await (const change of bounded(live, "artifact.entry.follow", log, 64, signal)) {
        if (change.artifact === id && change.seq > upto) {
          yield { _tag: "Entries", seq: change.seq, entries: change.entries, deleted: change.deleted };
        }
      }
    } finally {
      live.close();
    }
  }

  return {
    count: async (id) => (await qe.artifactEntryCount(db.sql, { artifact_id: id }))?.n ?? 0,
    summary: async (row) => {
      const entries = (await qe.artifactEntries(db.sql, { artifact_id: row.id })).map((r) => entryOf(r, true));
      return formatStoreSummary({ title: row.title, artifactType: row.artifact_type ?? undefined, seq: row.seq }, entries);
    },
    list: async (req) => {
      const row = await foundStore(req.id);
      const prefix = req.prefix?.trim() ?? "";
      const includeValues = req.includeValues === true;
      const rows =
        prefix !== ""
          ? (await qe.artifactEntriesByPrefix(db.sql, { artifact_id: req.id, prefix_like: `${prefix.replaceAll("%", "\\%").replaceAll("_", "\\_")}%` })).filter(
              (r) => r.path.startsWith(prefix),
            )
          : await qe.artifactEntries(db.sql, { artifact_id: req.id });
      return {
        artifact: await assemble(row),
        seq: row.seq,
        entries: rows.map((r) => entryOf(r, includeValues)),
      };
    },
    get: async (req) => {
      const row = await foundStore(req.id);
      checkPath(req.path);
      const entry = await qe.artifactEntry(db.sql, { artifact_id: req.id, path: req.path });
      if (!entry) throw missing(t("server.artifact.entry.missing", { title: row.title, path: req.path }), [], BizCode.ArtifactNotFound);
      return entryOf(entry, true);
    },
    batch: (maker, req) => lock.with(() => batchLocked(maker, req)),
    follow,
    renderView: async (id, input) => {
      const row = await foundStore(id);
      const rows = await qe.artifactEntries(db.sql, { artifact_id: id });
      const entries = rows.map((r) => entryOf(r, true));
      let defaultTokensJson: string | undefined;
      const defaultDs = await qa.defaultDesignSystemArtifact(db.sql);
      if (defaultDs && defaultDs.id !== id) {
        const tokensEntry = await qe.artifactEntry(db.sql, { artifact_id: defaultDs.id, path: "project/tokens.json" });
        if (tokensEntry?.value) defaultTokensJson = tokensEntry.value;
      }
      const html = renderStoreArtifactHtml(row.artifact_type ?? undefined, entries, {
        theme: shellThemeOf(input.theme ?? null),
        ...(input.path ? { path: input.path } : {}),
        ...(input.elementId ? { elementId: input.elementId } : {}),
        ...(defaultTokensJson ? { defaultTokensJson } : {}),
      });
      return {
        html,
        headers: storeViewHeaders(input.origin, input.print === true),
      };
    },
    close: async () => {
      await tasks.close();
      changes.end();
    },
  };
}
