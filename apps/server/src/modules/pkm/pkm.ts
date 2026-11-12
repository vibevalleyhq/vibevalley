import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Semaphore } from "@vibevalley/async";
import { list, t } from "@vibevalley/i18n";
import { flatBlocks, slugOf } from "@vibevalley/pkm";
import { userId } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";

import { ApiError, BizCode, Inconsistent, lookIn, messageOf, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonText } from "#/base/json.ts";
import { pkmDir, type ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import { termsList } from "#/modules/memory/recall.ts";
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

const refused = refuseIn(BizCode.PkmRefused);

/** Only the newest this many changes can be undone. */
const changeKeep = 200;

/** Refusals are ApiErrors (thrown). */
export interface Pkm {
  /** The vault's folder. */
  readonly root: string;
  readonly list: () => Promise<T.PkmVault>;
  readonly page: (ref: string) => Promise<T.PkmPageView>;
  readonly save: (req: T.PkmPageRequest) => Promise<T.PkmPage>;
  readonly move: (req: T.PkmMoveRequest) => Promise<T.PkmPage>;
  readonly apply: (req: T.PkmMutation) => Promise<T.PkmPage>;
  readonly search: (req: T.PkmSearchRequest) => Promise<T.PkmSearchHit[]>;
  /** text read as an outline (outlineOf). page: at that page's end as it is. */
  readonly capture: (text: string, by?: string, page?: string) => Promise<T.PkmPage>;
  readonly source: (ref: string) => Promise<T.PkmSource>;
  readonly sourceUpdate: (req: T.PkmSourceUpdate) => Promise<T.PkmPage>;
  /** A day, YYYY-MM-DD. */
  readonly journal: (day: string) => Promise<T.PkmPage>;
  readonly radar: (staleDays: number | undefined) => Promise<T.PkmRadar>;
  readonly comments: (page: string | undefined) => Promise<T.PkmComment[]>;
  /** by: who proposes it, the user or an agent's id. */
  readonly suggest: (req: T.PkmProposalRequest, by: string) => Promise<T.PkmProposal>;
  readonly resolve: (req: T.PkmResolveRequest) => Promise<T.PkmPage>;
  readonly clip: (req: T.PkmClipRequest) => Promise<T.PkmClip>;
  readonly cluster: (req: T.PkmClusterRequest) => Promise<T.PkmCluster>;
  readonly rename: (req: T.PkmRenameRequest) => Promise<T.PkmRename>;
  readonly markdown: (ref: string) => Promise<string>;
  readonly undo: () => Promise<T.PkmUndo>;
  readonly scan: () => Promise<T.PkmScan>;
}

export interface PkmDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
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
const notOnDisk = (e: unknown) => refused(messageOf(e));

/** work on the vault's files; a failure of theirs is told as a refusal. */
const onDisk = async <A>(work: () => Promise<A>): Promise<A> => {
  try {
    return await work();
  } catch (e) {
    throw notOnDisk(e);
  }
};

export async function makePkm(deps: PkmDeps): Promise<Pkm> {
  const { config, db, clock } = deps;
  const log = deps.log.child("pkm");
  const root = pkmDir(config);
  // Every read that may read a file again and every write, one at a time: a page is read, changed and written whole.
  const lock = new Semaphore(1);
  let pages = new Map<string, Page>();
  let loaded = false;

  const now = () => clock.now();
  const abs = (file: string) => join(root, file);
  /** When the file was last written; undefined when it is not there (or cannot be asked). */
  const mtimeOf = async (file: string): Promise<number | undefined> => {
    try {
      return (await stat(abs(file))).mtime.getTime();
    } catch {
      // Not there to ask: the callers read it as gone.
      return undefined;
    }
  };
  const vault = (): Vault => pages;
  /** work whose failure leaves the vault as it was: said in the log as what, and dropped. */
  const ignored = async (what: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (e) {
      log.warn(what, e);
    }
  };

  /** The remarks the user wrote in a page's file, kept so their status outlives a reading. */
  const keepRemarks = async (page: Page) => {
    const at = now();
    const remarks: q.KeepRemarkParams[] = [];
    for (const node of walk(page.blocks)) {
      for (const [i, span] of spansOf(node.body).entries())
        remarks.push({
          id: `span:${node.id}:${i + 1}`,
          page: page.slug,
          block: node.id,
          span: span.text,
          author: userId,
          body: span.remark,
          created_at: at,
        });
      if (node.props.comment)
        remarks.push({ id: `prop:${node.id}`, page: page.slug, block: node.id, span: null, author: userId, body: node.props.comment, created_at: at });
    }
    for (const r of remarks) await q.keepRemark(db.sql, r);
  };

  const remarked = async () => new Set((await q.remarkedBlocks(db.sql)).map((r) => r.block));

  /** A page's blocks in the full-text index (pkm_term), as they read now. */
  const indexed = async (page: Page) => {
    await terms.clearPageTerms(db.sql, { page: page.slug });
    const rows = flatBlocks(page.blocks).map((b) => ({ block: b.id, page: page.slug, terms: termsList(`${page.title}\n${b.path}\n${b.body}`).join(" ") }));
    await terms.addTerms(db.sql, { rows: jsonText(rows) });
  };
  const unindexed = (slug: string) => terms.clearPageTerms(db.sql, { page: slug });

  /** A file read as the page it is now; was: the page as held, whose ids carry over to the blocks that did not change. */
  const readPage = async (file: string, mtime: number, was: Page | undefined) => {
    const text = await onDisk(() => readFile(abs(file), "utf8"));
    const read = parse(text, file, mtime);
    if (was && read.sha === was.sha) return { ...was, file, mtime };
    const page = was ? carryIds(was, read) : read;
    await keepRemarks(page);
    await indexed(page);
    return page;
  };

  const markdownFiles = async () => {
    const found: string[] = [];
    for (const folder of Object.values(tierFolder))
      await ignored(`pkm: the ${folder} folder could not be read; its pages are left out`, async () => {
        await mkdir(abs(folder), { recursive: true });
        const names = await readdir(abs(folder), { recursive: true });
        for (const name of names) {
          const file = `${folder}/${name.replace(/\\/gu, "/")}`;
          if (file.endsWith(".md") && !file.split("/").some((part) => part.startsWith("."))) found.push(file);
        }
      });
    return found.toSorted();
  };

  /** Every file read again that changed since it was read; pages whose file is gone are dropped. */
  const rescan = async (): Promise<T.PkmScan> => {
    const files = await markdownFiles();
    const held = pages;
    const byFile = new Map([...held.values()].map((p) => [p.file, p]));
    const next = new Map<string, Page>();
    let updated = 0;
    for (const file of files) {
      const mtime = (await mtimeOf(file)) ?? 0;
      const was = byFile.get(file);
      // One that cannot be read now stays as it was held, or is left out until it can.
      let page: Page | undefined;
      if (was && was.mtime === mtime) page = was;
      else
        try {
          page = await readPage(file, mtime, was);
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          log.warn(`pkm: ${file} could not be read: ${e.message}`);
          page = was;
        }
      if (!page) continue;
      if (page !== was) updated += 1;
      next.set(page.slug, page);
    }
    const gone = [...held.values()].filter((p) => !files.includes(p.file) || next.get(p.slug)?.file !== p.file);
    for (const p of gone) if (!next.has(p.slug)) await unindexed(p.slug);
    const removed = [...held.values()].filter((p) => !files.includes(p.file)).length;
    pages = next;
    loaded = true;
    return { scanned: files.length, updated, removed };
  };

  // The index is made again from the files the first time: what it held may be of files changed since.
  const ready = async () => {
    if (loaded) return;
    await terms.clearAllTerms(db.sql);
    await rescan();
  };

  /** The page a name means, read again first when its file changed on disk. */
  const fresh = async (ref: string): Promise<Page> => {
    await ready();
    const held = pageOf(vault(), ref);
    if (!held) throw noPage(ref, vault());
    const mtime = await mtimeOf(held.file);
    if (mtime === undefined) {
      const next = new Map(pages);
      next.delete(held.slug);
      pages = next;
      await unindexed(held.slug);
      throw noPage(ref, vault());
    }
    if (mtime === held.mtime) return held;
    const page = await readPage(held.file, mtime, held);
    pages = new Map(pages).set(page.slug, page);
    return page;
  };

  const textAt = async (file: string): Promise<string | undefined> => {
    try {
      return await readFile(abs(file), "utf8");
    } catch {
      // No file there (yet): there is no text before.
      return undefined;
    }
  };

  /** Writes page as its file, says the change for undo and holds the page as written: the blocks whose id the file now says are written ones. */
  const write = async (page: Page, what: string, from: string = page.file): Promise<Page> => {
    const others = new Map(vault());
    others.set(page.slug, page);
    const referenced = new Set([...refsInto(others), ...(await remarked())]);
    const pinned = pin(page.blocks, referenced);
    const text = print({ props: page.props, blocks: pinned }, referenced);
    const before = await textAt(from);
    const tmp = abs(`${page.file}.tmp-${newId()}`);
    await onDisk(async () => {
      await mkdir(join(root, page.file, ".."), { recursive: true });
      await writeFile(tmp, text);
      await rename(tmp, abs(page.file));
    });
    if (from !== page.file) await ignored(`pkm: ${from} could not be removed after the move`, () => rm(abs(from)));
    const mtime = (await mtimeOf(page.file)) ?? 0;
    const written: Page = { ...parse(text, page.file, mtime), blocks: pinned };
    // Writing a block's id is not a change to undo.
    if (what !== "pin") {
      await changes.addChange(db.sql, {
        at: now(),
        what,
        page: written.slug,
        before_file: before === undefined ? null : from,
        after_file: written.file,
        before_text: before ?? null,
        after_text: text,
      });
      await changes.trimChanges(db.sql, { keep: changeKeep });
    }
    await keepRemarks(written);
    const replaced = [...vault().values()].filter((p) => (p.file === from || p.file === written.file) && p.slug !== written.slug);
    for (const p of replaced) await unindexed(p.slug);
    await indexed(written);
    const next = new Map(pages);
    for (const [slug, p] of next) if (p.file === from || p.file === written.file) next.delete(slug);
    pages = next.set(written.slug, written);
    // Refs into blocks whose ids their own files do not say yet.
    const targets = new Set(edgesOf(written).flatMap((e) => (e.target ? [e.target] : [])));
    const unpinned = [...vault().values()].filter((p) => p.slug !== written.slug && [...walk(p.blocks)].some((n) => targets.has(n.id) && !n.explicit));
    for (const p of unpinned) await write(p, "pin");
    return written;
  };

  const viewOf = async (page: Page): Promise<T.PkmPageView> => {
    const v = vault();
    const ids = new Set([...walk(page.blocks)].map((n) => n.id));
    const rows = await q.openComments(db.sql, { page: page.slug });
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
    };
  };

  /** The page with that title made (in tier, with props and the outline markdown), or the one there with props set and
   * moved to tier. */
  const upsert = async (req: T.PkmPageRequest, what: string) => {
    const title = req.title.trim();
    if (title === "") throw refused(t("server.pkm.noTitle"));
    await ready();
    const there = pageOf(vault(), title);
    if (there) {
      const page = await fresh(there.slug);
      const tier = req.tier ?? page.tier;
      const file = tier === page.tier ? page.file : fileOf(tier, page.title);
      const props = { ...page.props, ...req.props, ...(page.props.para !== undefined ? { para: tier } : {}) };
      return write({ ...page, tier, file, props }, what, page.file);
    }
    const tier = req.tier ?? "inbox";
    const file = fileOf(tier, title);
    const outline = parse(req.markdown ?? "", file, 0);
    const page: Page = { ...outline, slug: slugOf(title), title, tier, props: titled(title, { ...outline.props, ...req.props }) };
    return write(page, what);
  };

  const mutate = async (ref: string, ops: readonly T.PkmBlockOp[], what: string) => {
    const page = await fresh(ref);
    return write({ ...page, blocks: applyOps(page.blocks, ops, () => newId()) }, what);
  };

  const locked = <A>(work: () => Promise<A>): Promise<A> => lock.with(work);

  return {
    root,
    list: async () => {
      await locked(rescan);
      const all = [...vault().values()].map(summaryOf).toSorted((a, b) => (b.updated !== a.updated ? b.updated - a.updated : a.slug.localeCompare(b.slug)));
      return { root, pages: all };
    },
    page: (ref) => locked(async () => viewOf(await fresh(ref))),
    save: async (req) => wireOf(await locked(() => upsert(req, "save"))),
    move: (req) =>
      locked(async () => {
        const page = await fresh(req.page);
        return wireOf(await upsert({ title: page.title, tier: req.tier }, "move"));
      }),
    apply: async (req) => wireOf(await locked(() => mutate(req.page, req.ops, "apply"))),
    search: async (req) => {
      await locked(ready);
      const text = req.text?.trim() ?? "";
      if (text === "") return search(vault(), req);
      const rows = await terms.matchTerms(db.sql, { words: queryWords(text) });
      return search(vault(), req, new Map(rows.map((r) => [r.block, r.score])));
    },
    capture: async (text, by, page) => {
      const blocks = outlineOf(text, newId);
      if (blocks.length === 0) throw refused(t("server.pkm.noText"));
      if (page !== undefined)
        return locked(async () => {
          const there = await fresh(page);
          return wireOf(await write({ ...there, blocks: [...there.blocks, ...blocks] }, "capture"));
        });
      // Into the journal as things to come back to: LATER and #inbox on each, the agent's name on the first.
      const marked = blocks.map((b, i) => {
        const said = i === 0 && by ? t("server.pkm.notedBy", { text: b.body, name: by }) : b.body;
        return { ...b, marker: b.marker ?? ("LATER" as const), body: /(?:^|\s)#inbox\b/u.test(said) ? said : `${said} #inbox` };
      });
      const title = journalTitle(now());
      return locked(async () => {
        await ready();
        const there = pageOf(vault(), title);
        if (there) {
          const journal = await fresh(there.slug);
          return wireOf(await write({ ...journal, blocks: [...journal.blocks, ...marked] }, "capture"));
        }
        const file = fileOf("journal", title);
        const empty = parse("", file, 0);
        return wireOf(await write({ ...empty, slug: slugOf(title), title, tier: "journal", props: titled(title, empty.props), blocks: marked }, "capture"));
      });
    },
    source: (ref) =>
      locked(async () => {
        const page = await fresh(ref);
        const markdown = (await textAt(page.file)) ?? print(page);
        return { page: page.slug, title: page.title, markdown, updated: page.mtime };
      }),
    sourceUpdate: (req) =>
      locked(async () => {
        const page = await fresh(req.page);
        // Written since it was read (the app, another editor): not overwritten.
        if (page.mtime !== req.updated) throw refused(t("server.pkm.changedSince", { page: page.title }));
        const read = parse(req.markdown, page.file, 0);
        return wireOf(await write({ ...page, props: titled(page.title, read.props), blocks: read.blocks }, "edit"));
      }),
    journal: (day) => {
      const title = journalTitleOf(day);
      return locked(async () => {
        await ready();
        const there = pageOf(vault(), title);
        if (there) return wireOf(await fresh(there.slug));
        return wireOf(await upsert({ title, tier: "journal", markdown: "- \n" }, "journal"));
      });
    },
    radar: async (staleDays) => {
      await locked(rescan);
      return radar(vault(), now(), staleDays ?? 14);
    },
    comments: async (ref) => {
      if (ref === undefined || ref === "") return (await q.openComments(db.sql, { page: null })).map(commentOf);
      const page = await locked(() => fresh(ref));
      return (await q.openComments(db.sql, { page: page.slug })).map(commentOf);
    },
    suggest: (req, by) =>
      locked(async () => {
        await ready();
        const at = blockOf(vault(), req.block);
        if (!at) throw missing(t("server.pkm.noBlock", { id: req.block }), [lookIn.pkm]);
        const page = await fresh(at.page.slug);
        const node = find(page.blocks, req.block) ?? at.node;
        const kept = keepLinks(node.body, req.suggested);
        const rationale = req.rationale ?? t("server.pkm.kept");
        const answering = req.comment ? await q.comment(db.sql, { id: req.comment }) : await q.newestOn(db.sql, { block: req.block });
        if (req.comment && !answering) throw missing(t("server.pkm.noComment", { id: req.comment }), [lookIn.pkm]);
        const id = answering && (answering.status === "open" || answering.status === "suggested") ? answering.id : newId();
        if (id === answering?.id) await q.suggest(db.sql, { id, suggested: kept.text, rationale });
        else
          await q.addSuggestion(db.sql, {
            id,
            page: page.slug,
            block: req.block,
            author: by,
            body: rationale,
            suggested: kept.text,
            rationale,
            created_at: now(),
          });
        // The block's id goes into its file, so the suggestion still finds it once the file is read again.
        if (!node.explicit) await write(page, "pin");
        const row = await q.comment(db.sql, { id });
        if (!row) throw new Inconsistent("a suggestion just written must read back");
        return { comment: commentOf(row), kept: kept.kept, restored: kept.restored };
      }),
    resolve: (req) =>
      locked(async () => {
        const row = await q.comment(db.sql, { id: req.id });
        if (!row) throw missing(t("server.pkm.noComment", { id: req.id }), [lookIn.pkm]);
        await ready();
        const at = blockOf(vault(), row.block);
        const page = await fresh(at?.page.slug ?? row.page);
        const when = now();
        if (!req.accept) {
          await q.resolve(db.sql, { id: row.id, status: "rejected", resolved_at: when });
          return wireOf(page);
        }
        const node = find(page.blocks, row.block);
        if (!node) throw missing(t("server.pkm.noBlock", { id: row.block }), [lookIn.pkm]);
        const props = { ...node.props };
        delete props.comment;
        const written = await write({ ...page, blocks: replaced(page.blocks, row.block, withoutSpans(row.suggested ?? node.body), props) }, "resolve");
        await q.resolveOn(db.sql, { block: row.block, resolved_at: when });
        return wireOf(written);
      }),
    clip: (req) => {
      const url = req.url.trim().replace(/\/+$/u, "");
      return locked(async (): Promise<T.PkmClip> => {
        await ready();
        const highlights = req.highlights ?? [];
        const there = clipOf(vault(), url);
        if (there) {
          const quotes = highlights.map((h): T.PkmBlockOp => ({
            op: "append",
            body: `> ${h.text}`,
            props: { "source-anchor": `${there.slug}#${h.anchor}` },
          }));
          if (quotes.length > 0) await mutate(there.slug, quotes, "clip");
          return { duplicate: true, page: there.slug, snapshot: there.props.snapshot ?? "" };
        }
        const title = req.title.trim();
        if (title === "") throw refused(t("server.pkm.noTitle"));
        const slug = slugOf(title);
        const snapshot = `${ownFolder}/snapshots/${fileNameOf(title).replace(/\.md$/u, "")}.raw.md`;
        await onDisk(async () => {
          await mkdir(abs(`${ownFolder}/snapshots`), { recursive: true });
          await writeFile(abs(snapshot), req.content);
        });
        const gist = req.tldr ?? req.content.slice(0, 120).replace(/\n+/gu, " ");
        const lines =
          highlights.length > 0
            ? highlights.map((h) => `  - > ${h.text}\n    source-anchor:: ${slug}#${h.anchor}`)
            : [`  - ${gist}\n    source-anchor:: ${slug}#L1`];
        const clippedAt = now();
        const page = await upsert(
          {
            title,
            tier: req.tier ?? "inbox",
            props: {
              "material-type": "article",
              "source-url": url,
              ...(req.author ? { author: req.author } : {}),
              "read-status": "unread",
              "clipped-at": journalTitle(clippedAt).replace(/_/gu, "-"),
              snapshot,
              tags: (req.tags ?? ["clipped"]).map((tag) => (tag.startsWith("[[") ? tag : `[[${tag}]]`)).join(", "),
              tldr: gist,
            },
            markdown: `- ${t("server.pkm.clipHeading")}\n${lines.join("\n")}\n`,
          },
          "clip",
        );
        return { duplicate: false, page: page.slug, snapshot };
      });
    },
    cluster: (req) =>
      locked(async () => {
        await ready();
        const found = clustered(vault(), req.topic);
        const lines = found.map(({ page, node }) => `  - ${t("server.pkm.clusterLine", { title: page.title, id: node.id })}`);
        const page = await upsert(
          {
            title: req.title,
            tier: "resource",
            props: { tags: `[[${req.topic}]]`, tldr: t("server.pkm.clusterTldr", { topic: req.topic, count: found.length }) },
            markdown: `- ${t("server.pkm.clusterHeading", { topic: req.topic })}\n${lines.join("\n")}\n`,
          },
          "cluster",
        );
        return { page: page.slug, blocks: found.map((f) => f.node.id) };
      }),
    rename: async (req) => {
      const from = req.from.trim();
      const to = req.to.trim();
      if (from === "" || to === "") throw refused(t("server.pkm.noTitle"));
      if (slugOf(from) === slugOf(to)) throw refused(t("server.pkm.sameName"));
      return locked(async () => {
        await ready();
        const v = vault();
        const old = pageOf(v, from);
        const target = pageOf(v, to);
        if (!old && !target) throw refused(t("server.pkm.noRename", { from, to }));
        const aliased = (props: Record<string, string>) => {
          const names = (props.alias ?? "")
            .split(",")
            .map((a) => a.trim())
            .filter((a) => a !== "");
          return { ...props, alias: [...new Set([...names, from])].join(", ") };
        };
        if (old && !target) {
          const page = await fresh(old.slug);
          const file = fileOf(page.tier, to);
          await write(
            { ...page, slug: slugOf(to), title: to, file, props: aliased(titled(to, { ...page.props, ...(page.props.title ? { title: to } : {}) })) },
            "rename",
            page.file,
          );
          await q.movePage(db.sql, { from_page: page.slug, to_page: slugOf(to) });
        } else if (target) {
          const into = await fresh(target.slug);
          const merged = old && old.slug !== into.slug ? await fresh(old.slug) : undefined;
          await write({ ...into, props: aliased(into.props), blocks: [...into.blocks, ...(merged?.blocks ?? [])] }, "rename");
          if (merged) {
            await ignored(`pkm: ${merged.file} could not be removed after its page was merged`, () => rm(abs(merged.file)));
            const next = new Map(pages);
            next.delete(merged.slug);
            pages = next;
            await unindexed(merged.slug);
            await q.movePage(db.sql, { from_page: merged.slug, to_page: into.slug });
          }
        }
        const relinked = [...vault().values()].flatMap((p) => {
          const next = renameLinks(p, from, to);
          return next ? [next] : [];
        });
        for (const p of relinked) await write(p, "rename");
        return { pages: relinked.map((p) => p.slug), into: to };
      });
    },
    markdown: async (ref) => {
      const page = await locked(() => fresh(ref));
      return exportMarkdown(vault(), page, (tldr) => t("server.pkm.summary", { tldr }));
    },
    undo: () =>
      locked(async (): Promise<T.PkmUndo> => {
        const last = await changes.lastChange(db.sql);
        if (!last) return { undone: false };
        if (last.before_text === null || (last.before_file !== null && last.before_file !== last.after_file))
          await ignored(`pkm: ${last.after_file} could not be removed by the undo`, () => rm(abs(last.after_file)));
        const beforeFile = last.before_file;
        const beforeText = last.before_text;
        if (beforeText !== null && beforeFile !== null)
          await onDisk(async () => {
            await mkdir(join(root, beforeFile, ".."), { recursive: true });
            await writeFile(abs(beforeFile), beforeText);
          });
        await changes.dropChange(db.sql, { seq: last.seq });
        await rescan();
        return { undone: true, page: last.page, what: last.what };
      }),
    scan: () => locked(rescan),
  };
}

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
