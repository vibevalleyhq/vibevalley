import { join } from "node:path";

import { Clock, Context, Effect, FileSystem, Layer, Option, Ref, Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { list, t } from "@vibevalley/i18n";
import { ownerId } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";
import { flatBlocks, slugOf } from "@vibevalley/protocol/rules";

import { newId } from "#/base/ids.ts";
import { type ApiError, Inconsistent, lookIn, missing, reasonOf, refused } from "#/errors.ts";
import { pkmDir, ServerConfig } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import { termsList } from "#/memory/recall.ts";
import * as changes from "#db/pkm_change.sql.ts";
import * as q from "#db/pkm_comment.sql.ts";
import * as terms from "#db/pkm_term.sql.ts";

import {
  backlinks,
  blockOf,
  clipOf,
  clustered,
  exportMarkdown,
  keepLinks,
  pageOf,
  queryWords,
  radar,
  refsInto,
  renameLinks,
  search,
  summaryOf,
  transclusions,
  type Vault,
  wireOf,
} from "./graph.ts";
import { applyOps } from "./ops.ts";
import { carryIds, edgesOf, find, type Node, outlineOf, type Page, parse, print, spansOf, walk, withoutSpans } from "./outline.ts";
import { fileNameOf, fileOf, journalTitle, journalTitleOf, ownFolder, tierFolder, titleOfFile } from "./para.ts";

/** Only the newest this many changes can be undone. */
const changeKeep = 200;

export class Pkm extends Context.Service<
  Pkm,
  {
    /** The vault's folder. */
    readonly root: string;
    readonly list: () => Effect.Effect<T.PkmVault>;
    readonly page: (ref: string) => Effect.Effect<T.PkmPageView, ApiError>;
    readonly save: (req: T.PkmPageRequest) => Effect.Effect<T.PkmPage, ApiError>;
    readonly move: (req: T.PkmMoveRequest) => Effect.Effect<T.PkmPage, ApiError>;
    readonly apply: (req: T.PkmMutation) => Effect.Effect<T.PkmPage, ApiError>;
    readonly search: (req: T.PkmSearchRequest) => Effect.Effect<T.PkmSearchHit[]>;
    /** text read as an outline (outlineOf). page: at that page's end as it is. */
    readonly capture: (text: string, by?: string, page?: string) => Effect.Effect<T.PkmPage, ApiError>;
    readonly source: (ref: string) => Effect.Effect<T.PkmSource, ApiError>;
    readonly sourceUpdate: (req: T.PkmSourceUpdate) => Effect.Effect<T.PkmPage, ApiError>;
    /** A day, YYYY-MM-DD. */
    readonly journal: (day: string) => Effect.Effect<T.PkmPage, ApiError>;
    readonly radar: (staleDays: number | undefined) => Effect.Effect<T.PkmRadar>;
    readonly comments: (page: string | undefined) => Effect.Effect<T.PkmComment[], ApiError>;
    /** by: who proposes it, the owner or an agent's id. */
    readonly suggest: (req: T.PkmProposalRequest, by: string) => Effect.Effect<T.PkmProposal, ApiError>;
    readonly resolve: (req: T.PkmResolveRequest) => Effect.Effect<T.PkmPage, ApiError>;
    readonly clip: (req: T.PkmClipRequest) => Effect.Effect<T.PkmClip, ApiError>;
    readonly cluster: (req: T.PkmClusterRequest) => Effect.Effect<T.PkmCluster, ApiError>;
    readonly rename: (req: T.PkmRenameRequest) => Effect.Effect<T.PkmRename, ApiError>;
    readonly markdown: (ref: string) => Effect.Effect<string, ApiError>;
    readonly undo: () => Effect.Effect<T.PkmUndo, ApiError>;
    readonly scan: () => Effect.Effect<T.PkmScan>;
  }
>()("vibevalley/Pkm") {
  static readonly layer = Layer.effect(
    Pkm,
    Effect.suspend(() => make),
  );
}

/** No page by that name: the closest few by title and words are named, so the next try is right. */
const noPage = (ref: string, vault: Vault) => {
  const like = [...new Set(search(vault, { text: ref, limit: 10 }).map((h) => h.pageTitle))].slice(0, 3);
  return missing(like.length > 0 ? t("server.pkm.noPageLike", { page: ref, like: list(like) }) : t("server.pkm.noPage", { page: ref }), [lookIn.pkm]);
};

const commentOf = (row: q.CommentResult): T.PkmComment => ({
  id: row.id,
  page: row.page,
  block: row.block,
  ...(row.span !== null ? { span: row.span } : {}),
  by: row.author,
  body: row.body,
  status: row.status,
  ...(row.suggested !== null ? { suggested: row.suggested } : {}),
  ...(row.rationale !== null ? { rationale: row.rationale } : {}),
  created: row.created_at,
  ...(row.resolved_at !== null ? { resolved: row.resolved_at } : {}),
});

/** The props a new page writes: its title too when the file's name would not say it. */
const titled = (title: string, props: Record<string, string>) => (titleOfFile(fileNameOf(title)) === title || props.title ? props : { title, ...props });

/** A file of the vault that could not be read or written, told as it is. */
const notOnDisk = (e: PlatformError) => refused(e.message);

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const db = yield* Db;
  const root = pkmDir(config);
  // Every read that may read a file again and every write, one at a time: a page is read, changed and written whole.
  const lock = yield* Semaphore.make(1);
  const pages = yield* Ref.make<Map<string, Page>>(new Map());
  const loaded = yield* Ref.make(false);

  const now = Clock.currentTimeMillis;
  const abs = (file: string) => join(root, file);
  const mtimeOf = (file: string) =>
    fs.stat(abs(file)).pipe(
      Effect.map((info) => Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() })),
      Effect.option,
    );
  const vault = (): Effect.Effect<Vault> => Ref.get(pages);

  /** The remarks the owner wrote in a page's file, kept so their status outlives a reading. */
  const keepRemarks = (page: Page) =>
    Effect.gen(function* () {
      const at = yield* now;
      const remarks: q.KeepRemarkParams[] = [];
      for (const node of walk(page.blocks)) {
        for (const [i, span] of spansOf(node.body).entries())
          remarks.push({
            id: `span:${node.id}:${i + 1}`,
            page: page.slug,
            block: node.id,
            span: span.text,
            author: ownerId,
            body: span.remark,
            created_at: at,
          });
        if (node.props.comment)
          remarks.push({ id: `prop:${node.id}`, page: page.slug, block: node.id, span: null, author: ownerId, body: node.props.comment, created_at: at });
      }
      yield* Effect.forEach(remarks, (r) => db.run(q.keepRemark(r)), { discard: true });
    });

  const remarked = () => Effect.map(db.run(q.remarkedBlocks()), (rows) => new Set(rows.map((r) => r.block)));

  /** A page's blocks in the full-text index (pkm_term), as they read now. */
  const indexed = (page: Page) =>
    Effect.andThen(
      db.run(terms.clearPageTerms({ page: page.slug })),
      db.run(
        terms.addTerms({
          rows: JSON.stringify(
            flatBlocks(page.blocks).map((b) => ({ block: b.id, page: page.slug, terms: termsList(`${page.title}\n${b.path}\n${b.body}`).join(" ") })),
          ),
        }),
      ),
    );
  const unindexed = (slug: string) => db.run(terms.clearPageTerms({ page: slug }));

  /** A file read as the page it is now; was: the page as held, whose ids carry over to the blocks that did not change. */
  const readPage = (file: string, mtime: number, was: Page | undefined) =>
    Effect.gen(function* () {
      const text = yield* fs.readFileString(abs(file)).pipe(Effect.mapError(notOnDisk));
      const read = parse(text, file, mtime);
      if (was && read.sha === was.sha) return { ...was, file, mtime };
      const page = was ? carryIds(was, read) : read;
      yield* keepRemarks(page);
      yield* indexed(page);
      return page;
    });

  const markdownFiles = Effect.gen(function* () {
    const found: string[] = [];
    yield* Effect.forEach(
      Object.values(tierFolder),
      (folder) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(abs(folder), { recursive: true });
          const names = yield* fs.readDirectory(abs(folder), { recursive: true });
          for (const name of names) {
            const file = `${folder}/${name.replace(/\\/gu, "/")}`;
            if (file.endsWith(".md") && !file.split("/").some((part) => part.startsWith("."))) found.push(file);
          }
        }).pipe(Effect.ignore({ log: "Warn", message: `pkm: the ${folder} folder could not be read; its pages are left out` })),
      { discard: true },
    );
    return found.toSorted();
  });

  /** Every file read again that changed since it was read; pages whose file is gone are dropped. */
  const rescan = Effect.gen(function* () {
    const files = yield* markdownFiles;
    const held = yield* Ref.get(pages);
    const byFile = new Map([...held.values()].map((p) => [p.file, p]));
    const next = new Map<string, Page>();
    let updated = 0;
    yield* Effect.forEach(
      files,
      (file) =>
        Effect.gen(function* () {
          const mtime = Option.getOrElse(yield* mtimeOf(file), () => 0);
          const was = byFile.get(file);
          // One that cannot be read now stays as it was held, or is left out until it can.
          const page =
            was && was.mtime === mtime
              ? was
              : yield* readPage(file, mtime, was).pipe(
                  Effect.catch((e) => Effect.as(Effect.logWarning(`pkm: ${file} could not be read: ${reasonOf(e)}`), was)),
                );
          if (!page) return;
          if (page !== was) updated += 1;
          next.set(page.slug, page);
        }),
      { discard: true },
    );
    const gone = [...held.values()].filter((p) => !files.includes(p.file) || next.get(p.slug)?.file !== p.file);
    yield* Effect.forEach(gone, (p) => (next.has(p.slug) ? Effect.void : unindexed(p.slug)), { discard: true });
    const removed = [...held.values()].filter((p) => !files.includes(p.file)).length;
    yield* Ref.set(pages, next);
    yield* Ref.set(loaded, true);
    return { scanned: files.length, updated, removed } satisfies T.PkmScan;
  });

  // The index is made again from the files the first time: what it held may be of files changed since.
  const ready = Effect.gen(function* () {
    if (yield* Ref.get(loaded)) return;
    yield* db.run(terms.clearAllTerms());
    yield* rescan;
  });

  /** The page a name means, read again first when its file changed on disk. */
  const fresh = (ref: string) =>
    Effect.gen(function* () {
      yield* ready;
      const held = pageOf(yield* vault(), ref);
      if (!held) return yield* Effect.fail(noPage(ref, yield* vault()));
      const mtime = yield* mtimeOf(held.file);
      if (Option.isNone(mtime)) {
        yield* Ref.update(pages, (m) => {
          const next = new Map(m);
          next.delete(held.slug);
          return next;
        });
        yield* unindexed(held.slug);
        return yield* Effect.fail(noPage(ref, yield* vault()));
      }
      if (mtime.value === held.mtime) return held;
      const page = yield* readPage(held.file, mtime.value, held);
      yield* Ref.update(pages, (m) => new Map(m).set(page.slug, page));
      return page;
    });

  const textAt = (file: string) => fs.readFileString(abs(file)).pipe(Effect.option, Effect.map(Option.getOrUndefined));

  /** Writes page as its file, says the change for undo and holds the page as written: the blocks whose id the file now says are written ones. */
  const write = (page: Page, what: string, from: string = page.file): Effect.Effect<Page, ApiError> =>
    Effect.gen(function* () {
      const held = yield* vault();
      const others = new Map(held);
      others.set(page.slug, page);
      const referenced = new Set([...refsInto(others), ...(yield* remarked())]);
      const pinned = pin(page.blocks, referenced);
      const text = print({ props: page.props, blocks: pinned }, referenced);
      const before = yield* textAt(from);
      const tmp = abs(`${page.file}.tmp-${newId()}`);
      yield* Effect.all([fs.makeDirectory(join(root, page.file, ".."), { recursive: true }), fs.writeFileString(tmp, text), fs.rename(tmp, abs(page.file))], {
        discard: true,
      }).pipe(Effect.mapError(notOnDisk));
      if (from !== page.file) yield* fs.remove(abs(from)).pipe(Effect.ignore({ log: "Warn", message: `pkm: ${from} could not be removed after the move` }));
      const mtime = Option.getOrElse(yield* mtimeOf(page.file), () => 0);
      const written: Page = { ...parse(text, page.file, mtime), blocks: pinned };
      // Writing a block's id is not a change to undo.
      if (what !== "pin") {
        yield* db.run(
          changes.addChange({
            at: yield* now,
            what,
            page: written.slug,
            before_file: before === undefined ? null : from,
            after_file: written.file,
            before_text: before ?? null,
            after_text: text,
          }),
        );
        yield* db.run(changes.trimChanges({ keep: changeKeep }));
      }
      yield* keepRemarks(written);
      const replaced = [...(yield* vault()).values()].filter((p) => (p.file === from || p.file === written.file) && p.slug !== written.slug);
      yield* Effect.forEach(replaced, (p) => unindexed(p.slug), { discard: true });
      yield* indexed(written);
      yield* Ref.update(pages, (m) => {
        const next = new Map(m);
        for (const [slug, p] of next) if (p.file === from || p.file === written.file) next.delete(slug);
        return next.set(written.slug, written);
      });
      // Refs into blocks whose ids their own files do not say yet.
      const targets = new Set(edgesOf(written).flatMap((e) => (e.target ? [e.target] : [])));
      const unpinned = [...(yield* vault()).values()].filter(
        (p) => p.slug !== written.slug && [...walk(p.blocks)].some((n) => targets.has(n.id) && !n.explicit),
      );
      yield* Effect.forEach(unpinned, (p) => write(p, "pin"), { discard: true });
      return written;
    });

  const viewOf = (page: Page) =>
    Effect.gen(function* () {
      const v = yield* vault();
      const ids = new Set([...walk(page.blocks)].map((n) => n.id));
      const rows = yield* db.run(q.openComments({ page: page.slug }));
      const linking = backlinks(v, page.slug);
      return {
        page: wireOf(page),
        transclusions: transclusions(
          v,
          page,
          { circular: (id) => t("server.pkm.circular", { id }), broken: (id) => t("server.pkm.brokenRef", { id }) },
          Object.values(linking).flat(),
        ),
        backlinks: linking,
        comments: rows.filter((r) => ids.has(r.block)).map(commentOf),
      } satisfies T.PkmPageView;
    });

  /** The page with that title made (in tier, with props and the outline markdown), or the one there with props set and
   * moved to tier. */
  const upsert = (req: T.PkmPageRequest, what: string) =>
    Effect.gen(function* () {
      const title = req.title.trim();
      if (title === "") return yield* Effect.fail(refused(t("server.pkm.noTitle")));
      yield* ready;
      const there = pageOf(yield* vault(), title);
      if (there) {
        const page = yield* fresh(there.slug);
        const tier = req.tier ?? page.tier;
        const file = tier === page.tier ? page.file : fileOf(tier, page.title);
        const props = { ...page.props, ...req.props, ...(page.props.para !== undefined ? { para: tier } : {}) };
        return yield* write({ ...page, tier, file, props }, what, page.file);
      }
      const tier = req.tier ?? "inbox";
      const file = fileOf(tier, title);
      const outline = parse(req.markdown ?? "", file, 0);
      const page: Page = { ...outline, slug: slugOf(title), title, tier, props: titled(title, { ...outline.props, ...req.props }) };
      return yield* write(page, what);
    });

  const mutate = (ref: string, ops: readonly T.PkmBlockOp[], what: string) =>
    Effect.gen(function* () {
      const page = yield* fresh(ref);
      return yield* write({ ...page, blocks: applyOps(page.blocks, ops, () => newId()) }, what);
    });

  const locked = <A, E>(work: Effect.Effect<A, E>) => lock.withPermits(1)(work);

  const shape = Pkm.of({
    root,
    list: Effect.fn("Pkm.list")(function* () {
      yield* locked(rescan);
      const all = [...(yield* vault()).values()]
        .map(summaryOf)
        .toSorted((a, b) => (b.updated !== a.updated ? b.updated - a.updated : a.slug.localeCompare(b.slug)));
      return { root, pages: all };
    }),
    page: Effect.fn("Pkm.page")(function* (ref) {
      return yield* locked(Effect.flatMap(fresh(ref), viewOf));
    }),
    save: Effect.fn("Pkm.save")(function* (req) {
      return wireOf(yield* locked(upsert(req, "save")));
    }),
    move: Effect.fn("Pkm.move")(function* (req) {
      return yield* locked(
        Effect.gen(function* () {
          const page = yield* fresh(req.page);
          return wireOf(yield* upsert({ title: page.title, tier: req.tier }, "move"));
        }),
      );
    }),
    apply: Effect.fn("Pkm.apply")(function* (req) {
      return wireOf(yield* locked(mutate(req.page, req.ops, "apply")));
    }),
    search: Effect.fn("Pkm.search")(function* (req) {
      yield* locked(ready);
      const text = req.text?.trim() ?? "";
      if (text === "") return search(yield* vault(), req);
      const rows = yield* db.run(terms.matchTerms({ words: queryWords(text) }));
      return search(yield* vault(), req, new Map(rows.map((r) => [r.block, r.score])));
    }),
    capture: Effect.fn("Pkm.capture")(function* (text, by, page) {
      const blocks = outlineOf(text, newId);
      if (blocks.length === 0) return yield* Effect.fail(refused(t("server.pkm.noText")));
      if (page !== undefined)
        return yield* locked(
          Effect.gen(function* () {
            const there = yield* fresh(page);
            return wireOf(yield* write({ ...there, blocks: [...there.blocks, ...blocks] }, "capture"));
          }),
        );
      // Into the journal as things to come back to: LATER and #inbox on each, the agent's name on the first.
      const marked = blocks.map((b, i) => {
        const said = i === 0 && by ? t("server.pkm.notedBy", { text: b.body, name: by }) : b.body;
        return { ...b, marker: b.marker ?? ("LATER" as const), body: /(?:^|\s)#inbox\b/u.test(said) ? said : `${said} #inbox` };
      });
      const title = journalTitle(yield* now);
      return yield* locked(
        Effect.gen(function* () {
          yield* ready;
          const there = pageOf(yield* vault(), title);
          if (there) {
            const journal = yield* fresh(there.slug);
            return wireOf(yield* write({ ...journal, blocks: [...journal.blocks, ...marked] }, "capture"));
          }
          const file = fileOf("journal", title);
          const empty = parse("", file, 0);
          return wireOf(yield* write({ ...empty, slug: slugOf(title), title, tier: "journal", props: titled(title, empty.props), blocks: marked }, "capture"));
        }),
      );
    }),
    source: Effect.fn("Pkm.source")(function* (ref) {
      return yield* locked(
        Effect.gen(function* () {
          const page = yield* fresh(ref);
          const markdown = (yield* textAt(page.file)) ?? print(page);
          return { page: page.slug, title: page.title, markdown, updated: page.mtime } satisfies T.PkmSource;
        }),
      );
    }),
    sourceUpdate: Effect.fn("Pkm.sourceUpdate")(function* (req) {
      return yield* locked(
        Effect.gen(function* () {
          const page = yield* fresh(req.page);
          // Written since it was read (the app, another editor): not overwritten.
          if (page.mtime !== req.updated) return yield* Effect.fail(refused(t("server.pkm.changedSince", { page: page.title })));
          const read = parse(req.markdown, page.file, 0);
          return wireOf(yield* write({ ...page, props: titled(page.title, read.props), blocks: read.blocks }, "edit"));
        }),
      );
    }),
    journal: Effect.fn("Pkm.journal")(function* (day) {
      const title = journalTitleOf(day);
      return yield* locked(
        Effect.gen(function* () {
          yield* ready;
          const there = pageOf(yield* vault(), title);
          if (there) return wireOf(yield* fresh(there.slug));
          return wireOf(yield* upsert({ title, tier: "journal", markdown: "- \n" }, "journal"));
        }),
      );
    }),
    radar: Effect.fn("Pkm.radar")(function* (staleDays) {
      yield* locked(rescan);
      return radar(yield* vault(), yield* now, staleDays ?? 14);
    }),
    comments: Effect.fn("Pkm.comments")(function* (ref) {
      if (ref === undefined || ref === "") return (yield* db.run(q.openComments({ page: null }))).map(commentOf);
      const page = yield* locked(fresh(ref));
      return (yield* db.run(q.openComments({ page: page.slug }))).map(commentOf);
    }),
    suggest: Effect.fn("Pkm.suggest")(function* (req, by) {
      return yield* locked(
        Effect.gen(function* () {
          yield* ready;
          const at = blockOf(yield* vault(), req.block);
          if (!at) return yield* Effect.fail(missing(t("server.pkm.noBlock", { id: req.block }), [lookIn.pkm]));
          const page = yield* fresh(at.page.slug);
          const node = find(page.blocks, req.block) ?? at.node;
          const kept = keepLinks(node.body, req.suggested);
          const rationale = req.rationale ?? t("server.pkm.kept");
          const answering = req.comment ? yield* db.one(q.comment({ id: req.comment })) : yield* db.one(q.newestOn({ block: req.block }));
          if (req.comment && !answering) return yield* Effect.fail(missing(t("server.pkm.noComment", { id: req.comment }), [lookIn.pkm]));
          const id = answering && (answering.status === "open" || answering.status === "suggested") ? answering.id : newId();
          if (id === answering?.id) yield* db.run(q.suggest({ id, suggested: kept.text, rationale }));
          else
            yield* db.run(
              q.addSuggestion({ id, page: page.slug, block: req.block, author: by, body: rationale, suggested: kept.text, rationale, created_at: yield* now }),
            );
          // The block's id goes into its file, so the suggestion still finds it once the file is read again.
          if (!node.explicit) yield* write(page, "pin");
          const row = yield* db.one(q.comment({ id }));
          if (!row) return yield* Effect.die(new Inconsistent({ message: "a suggestion just written must read back" }));
          return { comment: commentOf(row), kept: kept.kept, restored: kept.restored } satisfies T.PkmProposal;
        }),
      );
    }),
    resolve: Effect.fn("Pkm.resolve")(function* (req) {
      return yield* locked(
        Effect.gen(function* () {
          const row = yield* db.one(q.comment({ id: req.id }));
          if (!row) return yield* Effect.fail(missing(t("server.pkm.noComment", { id: req.id }), [lookIn.pkm]));
          yield* ready;
          const at = blockOf(yield* vault(), row.block);
          const page = yield* fresh(at?.page.slug ?? row.page);
          const when = yield* now;
          if (!req.accept) {
            yield* db.run(q.resolve({ id: row.id, status: "rejected", resolved_at: when }));
            return wireOf(page);
          }
          const node = find(page.blocks, row.block);
          if (!node) return yield* Effect.fail(missing(t("server.pkm.noBlock", { id: row.block }), [lookIn.pkm]));
          const props = { ...node.props };
          delete props.comment;
          const written = yield* write({ ...page, blocks: replaced(page.blocks, row.block, withoutSpans(row.suggested ?? node.body), props) }, "resolve");
          yield* db.run(q.resolveOn({ block: row.block, resolved_at: when }));
          return wireOf(written);
        }),
      );
    }),
    clip: Effect.fn("Pkm.clip")(function* (req) {
      const url = req.url.trim().replace(/\/+$/u, "");
      return yield* locked(
        Effect.gen(function* () {
          yield* ready;
          const highlights = req.highlights ?? [];
          const there = clipOf(yield* vault(), url);
          if (there) {
            const quotes = highlights.map((h): T.PkmBlockOp => ({
              op: "append",
              body: `> ${h.text}`,
              props: { "source-anchor": `${there.slug}#${h.anchor}` },
            }));
            if (quotes.length > 0) yield* mutate(there.slug, quotes, "clip");
            return { duplicate: true, page: there.slug, snapshot: there.props.snapshot ?? "" } satisfies T.PkmClip;
          }
          const title = req.title.trim();
          if (title === "") return yield* Effect.fail(refused(t("server.pkm.noTitle")));
          const slug = slugOf(title);
          const snapshot = `${ownFolder}/snapshots/${fileNameOf(title).replace(/\.md$/u, "")}.raw.md`;
          yield* Effect.andThen(fs.makeDirectory(abs(`${ownFolder}/snapshots`), { recursive: true }), fs.writeFileString(abs(snapshot), req.content)).pipe(
            Effect.mapError(notOnDisk),
          );
          const gist = req.tldr ?? req.content.slice(0, 120).replace(/\n+/gu, " ");
          const lines =
            highlights.length > 0
              ? highlights.map((h) => `  - > ${h.text}\n    source-anchor:: ${slug}#${h.anchor}`)
              : [`  - ${gist}\n    source-anchor:: ${slug}#L1`];
          const page = yield* upsert(
            {
              title,
              tier: req.tier ?? "inbox",
              props: {
                "material-type": "article",
                "source-url": url,
                ...(req.author ? { author: req.author } : {}),
                "read-status": "unread",
                "clipped-at": journalTitle(yield* now).replace(/_/gu, "-"),
                snapshot,
                tags: (req.tags ?? ["clipped"]).map((tag) => (tag.startsWith("[[") ? tag : `[[${tag}]]`)).join(", "),
                tldr: gist,
              },
              markdown: `- ${t("server.pkm.clipHeading")}\n${lines.join("\n")}\n`,
            },
            "clip",
          );
          return { duplicate: false, page: page.slug, snapshot } satisfies T.PkmClip;
        }),
      );
    }),
    cluster: Effect.fn("Pkm.cluster")(function* (req) {
      return yield* locked(
        Effect.gen(function* () {
          yield* ready;
          const found = clustered(yield* vault(), req.topic);
          const lines = found.map(({ page, node }) => `  - ${t("server.pkm.clusterLine", { title: page.title, id: node.id })}`);
          const page = yield* upsert(
            {
              title: req.title,
              tier: "resource",
              props: { tags: `[[${req.topic}]]`, tldr: t("server.pkm.clusterTldr", { topic: req.topic, count: found.length }) },
              markdown: `- ${t("server.pkm.clusterHeading", { topic: req.topic })}\n${lines.join("\n")}\n`,
            },
            "cluster",
          );
          return { page: page.slug, blocks: found.map((f) => f.node.id) } satisfies T.PkmCluster;
        }),
      );
    }),
    rename: Effect.fn("Pkm.rename")(function* (req) {
      const from = req.from.trim();
      const to = req.to.trim();
      if (from === "" || to === "") return yield* Effect.fail(refused(t("server.pkm.noTitle")));
      if (slugOf(from) === slugOf(to)) return yield* Effect.fail(refused(t("server.pkm.sameName")));
      return yield* locked(
        Effect.gen(function* () {
          yield* ready;
          const v = yield* vault();
          const old = pageOf(v, from);
          const target = pageOf(v, to);
          if (!old && !target) return yield* Effect.fail(refused(t("server.pkm.noRename", { from, to })));
          const aliased = (props: Record<string, string>) => {
            const names = (props.alias ?? "")
              .split(",")
              .map((a) => a.trim())
              .filter((a) => a !== "");
            return { ...props, alias: [...new Set([...names, from])].join(", ") };
          };
          if (old && !target) {
            const page = yield* fresh(old.slug);
            const file = fileOf(page.tier, to);
            yield* write(
              { ...page, slug: slugOf(to), title: to, file, props: aliased(titled(to, { ...page.props, ...(page.props.title ? { title: to } : {}) })) },
              "rename",
              page.file,
            );
            yield* db.run(q.movePage({ from_page: page.slug, to_page: slugOf(to) }));
          } else if (target) {
            const into = yield* fresh(target.slug);
            const merged = old && old.slug !== into.slug ? yield* fresh(old.slug) : undefined;
            yield* write({ ...into, props: aliased(into.props), blocks: [...into.blocks, ...(merged?.blocks ?? [])] }, "rename");
            if (merged) {
              yield* fs
                .remove(abs(merged.file))
                .pipe(Effect.ignore({ log: "Warn", message: `pkm: ${merged.file} could not be removed after its page was merged` }));
              yield* Ref.update(pages, (m) => {
                const next = new Map(m);
                next.delete(merged.slug);
                return next;
              });
              yield* unindexed(merged.slug);
              yield* db.run(q.movePage({ from_page: merged.slug, to_page: into.slug }));
            }
          }
          const relinked = [...(yield* vault()).values()].flatMap((p) => {
            const next = renameLinks(p, from, to);
            return next ? [next] : [];
          });
          yield* Effect.forEach(relinked, (p) => write(p, "rename"), { discard: true });
          return { pages: relinked.map((p) => p.slug), into: to } satisfies T.PkmRename;
        }),
      );
    }),
    markdown: Effect.fn("Pkm.markdown")(function* (ref) {
      const page = yield* locked(fresh(ref));
      return exportMarkdown(yield* vault(), page, (tldr) => t("server.pkm.summary", { tldr }));
    }),
    undo: Effect.fn("Pkm.undo")(function* () {
      return yield* locked(
        Effect.gen(function* () {
          const last = yield* db.one(changes.lastChange());
          if (!last) return { undone: false } satisfies T.PkmUndo;
          if (last.before_text === null || (last.before_file !== null && last.before_file !== last.after_file))
            yield* fs.remove(abs(last.after_file)).pipe(Effect.ignore({ log: "Warn", message: `pkm: ${last.after_file} could not be removed by the undo` }));
          if (last.before_text !== null && last.before_file !== null)
            yield* Effect.andThen(
              fs.makeDirectory(join(root, last.before_file, ".."), { recursive: true }),
              fs.writeFileString(abs(last.before_file), last.before_text),
            ).pipe(Effect.mapError(notOnDisk));
          yield* db.run(changes.dropChange({ seq: last.seq }));
          yield* rescan;
          return { undone: true, page: last.page, what: last.what } satisfies T.PkmUndo;
        }),
      );
    }),
    scan: Effect.fn("Pkm.scan")(function* () {
      return yield* locked(rescan);
    }),
  });
  return shape;
});

/** The blocks with the ids in referenced marked as written: the file says their id from now on. */
function pin(nodes: readonly Node[], referenced: ReadonlySet<string>): Node[] {
  return nodes.map((n) => ({
    ...n,
    explicit: n.explicit || referenced.has(n.id) || Boolean(n.props.comment) || spansOf(n.body).length > 0,
    children: pin(n.children, referenced),
  }));
}

/** The blocks with one block's body and props replaced. */
function replaced(nodes: readonly Node[], id: string, body: string, props: Record<string, string>): Node[] {
  return nodes.map((n) => (n.id === id ? { ...n, body, props } : { ...n, children: replaced(n.children, id, body, props) }));
}
