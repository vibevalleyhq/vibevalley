import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { PkmMarkerValues, PkmTierValues } from "@vibevalley/protocol";

import { show } from "#/base/format.ts";
import { exit, Failure, type Io, out, stdinTextOrEmpty } from "#/base/output.ts";
import { arg, command, group, opt } from "#/infra/command.ts";
import { ask, change } from "#/infra/farm.ts";
import { exitCodeOf } from "#/infra/spawn.ts";

const pageArgument = arg.text("page", "cli.arg.page");
const tierFlag = opt.choice("tier", PkmTierValues, "cli.flag.tier");

/** Today on this machine, YYYY-MM-DD. */
const today = (io: Io) => {
  const now = new Date(io.clock.now());
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** A page as its outline: the title, then each block at its depth, its marker and priority first. */
const outline = (p: T.PkmPage) =>
  [
    `# ${p.title}`,
    "",
    ...p.blocks.map(
      (b) =>
        `${"  ".repeat(b.depth)}- ${[b.marker, b.priority === undefined ? undefined : `[#${b.priority}]`, b.body.replace(/\n/gu, " ")].filter((x) => x !== undefined).join(" ")}`,
    ),
  ].join("\n");

/** `pkm capture <text>`: into today's journal, or --page's end; with no words, what comes on stdin, read as an outline. */
const captureCommand = command("capture", {
  about: t("cli.command.pkm.capture"),
  examples: [
    { command: t("cli.example.pkmCapture.run"), description: t("cli.example.pkmCapture.about") },
    { command: t("cli.example.pkmCapturePage.run"), description: t("cli.example.pkmCapturePage.about") },
  ],
  params: { words: arg.optionalWords("cli.arg.capture"), page: opt.text("page", "cli.flag.capturePage") },
  run: async (o, ctx) => {
    const text = o.words.length > 0 ? o.words.join(" ") : await stdinTextOrEmpty(ctx);
    const page = o.page;
    const written = await ask(ctx, (api) => api.pkm.capture({ text, ...(page === undefined ? {} : { page }) }));
    show(ctx, written, (w) => t("cli.pkm.captured", { page: w.title }));
  },
});

/** `pkm search <terms>`: one hit a line, page › where: words. */
const searchCommand = command("search", {
  about: t("cli.command.pkm.search"),
  examples: [{ command: t("cli.example.pkmSearch.run"), description: t("cli.example.pkmSearch.about") }],
  params: {
    words: arg.optionalWords("cli.arg.search"),
    tier: tierFlag,
    marker: opt.choice("marker", PkmMarkerValues, "cli.flag.marker"),
    limit: opt.int("limit", "cli.flag.limit"),
  },
  run: async (o, ctx) => {
    const text = o.words.join(" ");
    const { tier, marker, limit } = o;
    const hits = await ask(ctx, (api) =>
      api.pkm.search({
        ...(text === "" ? {} : { text }),
        ...(tier === undefined ? {} : { tier }),
        ...(marker === undefined ? {} : { marker }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
    show(ctx, hits, (hs) => hs.map((h) => `${h.pageTitle} › ${h.path === "" ? "" : `${h.path}: `}${h.plain}`).join("\n"));
  },
});

/** `pkm radar`: what wants a look, as lines. */
const radarCommand = command("radar", {
  about: t("cli.command.pkm.radar"),
  examples: [{ command: "vibevalley pkm radar", description: t("cli.example.pkmRadar.about") }],
  run: async (_, ctx) =>
    show(ctx, await ask(ctx, (api) => api.pkm.radar.get({})), (r) =>
      [
        t("cli.pkm.inbox", { n: r.inbox }),
        ...r.stale.map((p) => t("cli.pkm.stale", { page: p.title, days: p.days })),
        ...r.overdue.map((d) => t("cli.pkm.overdue", { deadline: d.deadline, words: d.plain })),
      ].join("\n"),
    ),
});

/** `pkm journal show`: a day's journal (today, or --day), made when it has none. */
const journalShow = command("show", {
  about: t("cli.command.pkm.journalShow"),
  examples: [{ command: "vibevalley pkm journal show", description: t("cli.example.pkmJournal.about") }],
  params: { day: opt.text("day", "cli.flag.day") },
  run: async (o, ctx) => {
    const day = o.day ?? today(ctx);
    show(ctx, await ask(ctx, (api) => api.pkm.journal.open({ day })), outline);
  },
});

const pageShow = command("show", {
  about: t("cli.command.pkm.pageShow"),
  examples: [{ command: t("cli.example.pkmPageShow.run"), description: t("cli.example.pkmPageShow.about") }],
  params: { page: pageArgument },
  run: async (o, ctx) => show(ctx, await ask(ctx, (api) => api.pkm.page.get({ page: o.page })), (v) => outline(v.page)),
});

const pageExport = command("export", {
  about: t("cli.command.pkm.pageExport"),
  examples: [{ command: t("cli.example.pkmPageExport.run"), description: t("cli.example.pkmPageExport.about") }],
  params: { page: pageArgument },
  run: async (o, ctx) => show(ctx, await ask(ctx, (api) => api.pkm.page.export({ page: o.page })), (x) => x.markdown.replace(/\n+$/u, "")),
});

const pageSave = command("save", {
  about: t("cli.command.pkm.pageSave"),
  examples: [{ command: t("cli.example.pkmPageSave.run"), description: t("cli.example.pkmPageSave.about") }],
  params: {
    title: arg.text("title", "cli.arg.pageTitle"),
    words: arg.optionalWords("cli.arg.capture"),
    tier: tierFlag,
  },
  run: async (o, ctx) => {
    const markdown = o.words.length > 0 ? o.words.join(" ") : await stdinTextOrEmpty(ctx);
    const tier = o.tier;
    await change(ctx, {
      name: "pkm page save",
      does: (api) =>
        api.pkm.page.save({
          title: o.title,
          ...(tier === undefined ? {} : { tier }),
          ...(markdown === "" ? {} : { markdown }),
        }),
      said: (p) => t("cli.pkm.saved", { page: p.title }),
    });
  },
});

/** $VISUAL, else $EDITOR, else vi: a command line, the file added as its last word. */
const editorCommand = (io: Io) => io.env.VISUAL || io.env.EDITOR || "vi";

const pageLine = (p: T.PkmPageSummary) => [p.title, p.tier, p.open > 0 ? `open ${p.open}` : ""].filter((x) => x !== "").join("  ");

const pageList = command("list", {
  about: t("cli.command.pkm.pageList"),
  examples: [{ command: "vibevalley pkm page list", description: t("cli.example.pkmPageList.about") }],
  params: { limit: opt.intOr("limit", 20, "cli.flag.limit") },
  run: async (o, ctx) => {
    const vault = await ask(ctx, (api) => api.pkm.page.list());
    show(ctx, vault.pages.slice(0, o.limit), (ps) =>
      [...ps.map(pageLine), ...(vault.pages.length > o.limit ? [t("cli.more", { flag: `--limit ${o.limit * 2}` })] : [])].join("\n"),
    );
  },
});

const fileFailure = (e: unknown) => new Failure({ code: exit.other, tag: "File", text: e instanceof Error ? e.message : String(e) });

/** `pkm page edit <page>`: the page's file in $VISUAL or $EDITOR (vi without either), written back when the editor closes. left as it was if nothing changed. */
const pageEdit = command("edit", {
  about: t("cli.command.pkm.pageEdit"),
  examples: [{ command: t("cli.example.pkmPageEdit.run"), description: t("cli.example.pkmPageEdit.about") }],
  params: { page: pageArgument },
  run: async (o, ctx) => {
    const source = await ask(ctx, (api) => api.pkm.source.get({ page: o.page }));
    // Not removed afterwards: an edit that could not be written stays there, and the system clears its temporary folder.
    const file = await mkdtemp(join(tmpdir(), "vibevalley-"))
      .then(async (dir) => {
        const at = join(dir, `${source.page}.md`);
        await writeFile(at, source.markdown);
        return at;
      })
      .catch((e: unknown) => {
        throw fileFailure(e);
      });
    const editor = editorCommand(ctx);
    // Through the shell, as $EDITOR is a command line ("code --wait"); the file is its last word, quoted.
    const code = await exitCodeOf(`${editor} '${file.replaceAll("'", "'\\''")}'`, [], { shell: true, stdio: "inherit" }).catch((e: unknown) => {
      throw new Failure({ code: exit.other, tag: "Editor", text: t("cli.pkm.editorFailed", { editor, why: e instanceof Error ? e.message : String(e) }) });
    });
    if (code !== 0) throw new Failure({ code: exit.other, tag: "Editor", text: t("cli.pkm.editorExited", { editor, code, file }) });
    const edited = await readFile(file, "utf8").catch((e: unknown) => {
      throw fileFailure(e);
    });
    if (edited === source.markdown) return out(ctx, t("cli.pkm.unchanged", { page: source.title }));
    try {
      await ask(ctx, (api) => api.pkm.source.update({ page: source.page, markdown: edited, updated: source.updated }));
    } catch (e) {
      if (e instanceof Failure && e.tag === "Refused") throw new Failure({ ...e.fields(), text: t("cli.pkm.keptAt", { why: e.text, file }) });
      throw e;
    }
    out(ctx, t("cli.pkm.saved", { page: source.title }));
  },
});

const journalGroup = group("journal", t("cli.group.pkm.journal.about"), [journalShow]);

const pageGroup = group("page", t("cli.group.pkm.page.about"), [pageList, pageShow, pageSave, pageExport, pageEdit]);

export const pkmCommand = group("pkm", t("cli.group.pkm.about"), [captureCommand, searchCommand, radarCommand, journalGroup, pageGroup]);
