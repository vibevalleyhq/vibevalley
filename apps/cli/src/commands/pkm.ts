import { join } from "node:path";

import { Clock, Config, Effect, FileSystem } from "effect";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { PkmMarkerValues, PkmTierValues } from "@vibevalley/protocol";

import { ask, change, given, nameArg, optionalText, optionalWords, show } from "#/farm.ts";
import { exit, Failure, out, stdinText } from "#/output.ts";

const pageArgument = nameArg("page", "cli.arg.page");
const tierFlag = Flag.Literals("tier", PkmTierValues).pipe(Flag.optional, Flag.withDescription(t("cli.flag.tier")));

/** Today on this machine, YYYY-MM-DD (sv-SE writes dates so). */
const today = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toLocaleDateString("sv-SE"));

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
const captureCommand = Command.make(
  "capture",
  { words: optionalWords("cli.arg.capture"), page: optionalText("page", "cli.flag.capturePage") },
  (o) =>
    Effect.gen(function* () {
      const text = o.words.length > 0 ? o.words.join(" ") : yield* stdinText.pipe(Effect.orElseSucceed(() => ""));
      const page = given(o.page);
      const written = yield* ask((api) => api.pkm.capture({ text, ...(page === undefined ? {} : { page }) }));
      yield* show(written, (w) => t("cli.pkm.captured", { page: w.title }));
    }),
).pipe(
  Command.withDescription(t("cli.command.pkm.capture")),
  Command.withExamples([
    { command: t("cli.example.pkmCapture.run"), description: t("cli.example.pkmCapture.about") },
    { command: t("cli.example.pkmCapturePage.run"), description: t("cli.example.pkmCapturePage.about") },
  ]),
);

/** `pkm search <terms>`: one hit a line, page › where: words. */
const searchCommand = Command.make(
  "search",
  {
    words: optionalWords("cli.arg.search"),
    tier: tierFlag,
    marker: Flag.Literals("marker", PkmMarkerValues).pipe(Flag.optional, Flag.withDescription(t("cli.flag.marker"))),
    limit: Flag.Int("limit").pipe(Flag.optional, Flag.withDescription(t("cli.flag.limit"))),
  },
  (o) => {
    const text = o.words.join(" ");
    const tier = given(o.tier);
    const marker = given(o.marker);
    const limit = given(o.limit);
    return Effect.flatMap(
      ask((api) =>
        api.pkm.search({
          ...(text === "" ? {} : { text }),
          ...(tier === undefined ? {} : { tier }),
          ...(marker === undefined ? {} : { marker }),
          ...(limit === undefined ? {} : { limit }),
        }),
      ),
      (hits) => show(hits, (hs) => hs.map((h) => `${h.pageTitle} › ${h.path === "" ? "" : `${h.path}: `}${h.plain}`).join("\n")),
    );
  },
).pipe(
  Command.withDescription(t("cli.command.pkm.search")),
  Command.withExamples([{ command: t("cli.example.pkmSearch.run"), description: t("cli.example.pkmSearch.about") }]),
);

/** `pkm radar`: what wants a look, as lines. */
const radarCommand = Command.make("radar", {}, () =>
  Effect.flatMap(
    ask((api) => api.pkm.radar.get({})),
    (radar) =>
      show(radar, (r) =>
        [
          t("cli.pkm.inbox", { n: r.inbox }),
          ...r.stale.map((p) => t("cli.pkm.stale", { page: p.title, days: p.days })),
          ...r.overdue.map((d) => t("cli.pkm.overdue", { deadline: d.deadline, words: d.plain })),
        ].join("\n"),
      ),
  ),
).pipe(
  Command.withDescription(t("cli.command.pkm.radar")),
  Command.withExamples([{ command: "vibevalley pkm radar", description: t("cli.example.pkmRadar.about") }]),
);

/** `pkm journal show`: a day's journal (today, or --day), made when it has none. */
const journalShow = Command.make("show", { day: optionalText("day", "cli.flag.day") }, (o) =>
  Effect.gen(function* () {
    const day = given(o.day) ?? (yield* today);
    yield* show(yield* ask((api) => api.pkm.journal.open({ day })), outline);
  }),
).pipe(
  Command.withDescription(t("cli.command.pkm.journalShow")),
  Command.withExamples([{ command: "vibevalley pkm journal show", description: t("cli.example.pkmJournal.about") }]),
);

const pageShow = Command.make("show", { page: pageArgument }, (o) =>
  Effect.flatMap(
    ask((api) => api.pkm.page.get({ page: o.page })),
    (view) => show(view, (v) => outline(v.page)),
  ),
).pipe(
  Command.withDescription(t("cli.command.pkm.pageShow")),
  Command.withExamples([{ command: t("cli.example.pkmPageShow.run"), description: t("cli.example.pkmPageShow.about") }]),
);

const pageExport = Command.make("export", { page: pageArgument }, (o) =>
  Effect.flatMap(
    ask((api) => api.pkm.page.export({ page: o.page })),
    (m) => show(m, (x) => x.markdown.replace(/\n+$/u, "")),
  ),
).pipe(
  Command.withDescription(t("cli.command.pkm.pageExport")),
  Command.withExamples([{ command: t("cli.example.pkmPageExport.run"), description: t("cli.example.pkmPageExport.about") }]),
);

const pageSave = Command.make(
  "save",
  {
    title: nameArg("title", "cli.arg.pageTitle"),
    words: optionalWords("cli.arg.capture"),
    tier: tierFlag,
  },
  (o) =>
    Effect.gen(function* () {
      const markdown = o.words.length > 0 ? o.words.join(" ") : yield* stdinText.pipe(Effect.orElseSucceed(() => ""));
      const tier = given(o.tier);
      yield* change({
        name: "pkm page save",
        does: (api) =>
          api.pkm.page.save({
            title: o.title,
            ...(tier === undefined ? {} : { tier }),
            ...(markdown === "" ? {} : { markdown }),
          }),
        said: (p) => t("cli.pkm.saved", { page: p.title }),
      });
    }),
).pipe(
  Command.withDescription(t("cli.command.pkm.pageSave")),
  Command.withExamples([{ command: t("cli.example.pkmPageSave.run"), description: t("cli.example.pkmPageSave.about") }]),
);

/** $VISUAL, else $EDITOR, else vi: a command line, the file added as its last word. */
const editorCommand = Config.all({
  visual: Config.String("VISUAL").pipe(Config.withDefault("")),
  editor: Config.String("EDITOR").pipe(Config.withDefault("")),
}).pipe(Config.map(({ visual, editor }) => visual || editor || "vi"));

const pageLine = (p: T.PkmPageSummary) => [p.title, p.tier, p.open > 0 ? `open ${p.open}` : ""].filter((x) => x !== "").join("  ");

const pageList = Command.make("list", { limit: Flag.Int("limit").pipe(Flag.withDefault(20), Flag.withDescription(t("cli.flag.limit"))) }, (o) =>
  Effect.flatMap(
    ask((api) => api.pkm.page.list()),
    (vault) =>
      show(vault.pages.slice(0, o.limit), (ps) =>
        [...ps.map(pageLine), ...(vault.pages.length > o.limit ? [t("cli.more", { flag: `--limit ${o.limit * 2}` })] : [])].join("\n"),
      ),
  ),
).pipe(
  Command.withDescription(t("cli.command.pkm.pageList")),
  Command.withExamples([{ command: "vibevalley pkm page list", description: t("cli.example.pkmPageList.about") }]),
);

/** `pkm page edit <page>`: the page's file in $VISUAL or $EDITOR (vi without either), written back when the editor closes. left as it was if nothing changed. */
const pageEdit = Command.make("edit", { page: pageArgument }, (o) =>
  Effect.gen(function* () {
    const source = yield* ask((api) => api.pkm.source.get({ page: o.page }));
    const fs = yield* FileSystem.FileSystem;
    const kept = (e: { readonly message: string }) => new Failure({ code: exit.other, tag: "File", text: e.message });
    // Not removed afterwards: an edit that could not be written stays there, and the system clears its temporary folder.
    const file = join(yield* fs.makeTempDirectory({ prefix: "vibevalley-" }).pipe(Effect.mapError(kept)), `${source.page}.md`);
    yield* fs.writeFileString(file, source.markdown).pipe(Effect.mapError(kept));
    const editor = yield* editorCommand;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // Through the shell, as $EDITOR is a command line ("code --wait"); the file is its last word, quoted.
    const code = yield* spawner
      .exitCode(ChildProcess.make(`${editor} '${file.replaceAll("'", "'\\''")}'`, { shell: true, stdin: "inherit", stdout: "inherit", stderr: "inherit" }))
      .pipe(Effect.mapError((e) => new Failure({ code: exit.other, tag: "Editor", text: t("cli.pkm.editorFailed", { editor, why: e.message }) })));
    if (code !== 0) return yield* new Failure({ code: exit.other, tag: "Editor", text: t("cli.pkm.editorExited", { editor, code, file }) });
    const edited = yield* fs.readFileString(file).pipe(Effect.mapError(kept));
    if (edited === source.markdown) return yield* out(t("cli.pkm.unchanged", { page: source.title }));
    yield* ask((api) => api.pkm.source.update({ page: source.page, markdown: edited, updated: source.updated })).pipe(
      Effect.mapError((f) => (f.tag === "Refused" ? new Failure({ ...f, text: t("cli.pkm.keptAt", { why: f.text, file }) }) : f)),
    );
    yield* out(t("cli.pkm.saved", { page: source.title }));
  }),
).pipe(
  Command.withDescription(t("cli.command.pkm.pageEdit")),
  Command.withExamples([{ command: t("cli.example.pkmPageEdit.run"), description: t("cli.example.pkmPageEdit.about") }]),
);

const journalGroup = Command.make("journal").pipe(Command.withSubcommands([journalShow]), Command.withDescription(t("cli.group.pkm.journal.about")));

const pageGroup = Command.make("page").pipe(
  Command.withSubcommands([pageList, pageShow, pageSave, pageExport, pageEdit]),
  Command.withDescription(t("cli.group.pkm.page.about")),
);

export const pkmCommand = Command.make("pkm").pipe(
  Command.withSubcommands([captureCommand, searchCommand, radarCommand, journalGroup, pageGroup]),
  Command.withDescription(t("cli.group.pkm.about")),
);
