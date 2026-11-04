// The notes from a terminal (`vibevalley pkm …`): notes are text, so what these read comes out as Markdown (--format text,
// the default), the endpoint's answer with --format json.

import { join } from "node:path";

import { Clock, Config, Effect, FileSystem } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { FormatFlag } from "./api.ts";
import { ask, given, show } from "./farm.ts";
import { exit, Failure, out, printBody, stdinText } from "./output.ts";

const words = Argument.String("words").pipe(Argument.variadic(), Argument.withDescription(t("cli.arg.words")));

/** Today on this machine, YYYY-MM-DD (sv-SE writes dates so). */
const today = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toLocaleDateString("sv-SE"));

/** A page as Markdown for people (pkm.page.export), or as the endpoint gives it. */
const printPage = (page: string) =>
  Effect.gen(function* () {
    if ((yield* FormatFlag) === "json") return yield* printBody(JSON.stringify(yield* ask((api) => api.pkm.page.get({ page }))));
    const m = yield* ask((api) => api.pkm.page.export({ page }));
    yield* out(m.markdown.replace(/\n+$/u, ""));
  });

/** `pkm capture 一句话`: into today's journal, or --page's end; with no words, what comes on stdin, read as an outline. */
const captureCommand = Command.make("capture", { words, page: Flag.String("page").pipe(Flag.optional, Flag.withDescription(t("cli.flag.capturePage"))) }, (o) =>
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

/** One search hit a line, page › where: words (what `vibevalley search` prints for the notes). */
export const pkmHitLine = (h: T.PkmSearchHit) => `${h.pageTitle} › ${h.path === "" ? "" : `${h.path}: `}${h.plain}`;

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

const pageArgument = Argument.String("page").pipe(Argument.withDescription(t("cli.arg.page")));

/** $VISUAL, else $EDITOR, else vi: a command line, the file added as its last word. */
const editorCommand = Config.all({
  visual: Config.String("VISUAL").pipe(Config.withDefault("")),
  editor: Config.String("EDITOR").pipe(Config.withDefault("")),
}).pipe(Config.map(({ visual, editor }) => visual || editor || "vi"));

const pageLine = (p: T.PkmPageSummary) => [p.title, p.tier, p.open > 0 ? `open ${p.open}` : ""].filter((x) => x !== "").join("  ");

const listCommand = Command.make("list", { limit: Flag.Int("limit").pipe(Flag.withDefault(20), Flag.withDescription(t("cli.flag.limit"))) }, (o) =>
  Effect.flatMap(
    ask((api) => api.pkm.page.list()),
    (vault) =>
      show(vault.pages.slice(0, o.limit), (ps) =>
        [...ps.map(pageLine), ...(vault.pages.length > o.limit ? [t("cli.more", { flag: `--limit ${o.limit * 2}` })] : [])].join("\n"),
      ),
  ),
).pipe(
  Command.withDescription(t("cli.command.pkm.list")),
  Command.withExamples([{ command: "vibevalley pkm list", description: t("cli.example.pkmList.about") }]),
);

/** `pkm show 读书`: a page as Markdown; with no page, a day's journal (today, or --day), made when it has none. */
const showCommand = Command.make(
  "show",
  {
    page: Argument.String("page").pipe(Argument.optional, Argument.withDescription(t("cli.arg.pageOrToday"))),
    day: Flag.String("day").pipe(Flag.optional, Flag.withDescription(t("cli.flag.day"))),
  },
  (o) =>
    Effect.gen(function* () {
      const page = given(o.page);
      if (page !== undefined) return yield* printPage(page);
      const day = given(o.day) ?? (yield* today);
      const journal = yield* ask((api) => api.pkm.journal.open({ day }));
      yield* printPage(journal.slug);
    }),
).pipe(
  Command.withDescription(t("cli.command.pkm.show")),
  Command.withExamples([
    { command: "vibevalley pkm show", description: t("cli.example.pkmToday.about") },
    { command: t("cli.example.pkmShow.run"), description: t("cli.example.pkmShow.about") },
  ]),
);

/** `pkm edit 读书`: the page's file in $VISUAL or $EDITOR (vi without either), written back when the editor closes;
 * left as it was if nothing changed. One changed meanwhile is not overwritten: the edit stays in its file, named. */
const editCommand = Command.make("edit", { page: pageArgument }, (o) =>
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
  Command.withDescription(t("cli.command.pkm.edit")),
  Command.withExamples([{ command: t("cli.example.pkmEdit.run"), description: t("cli.example.pkmEdit.about") }]),
);

export const pkmCommand = Command.make("pkm").pipe(
  Command.withSubcommands([captureCommand, showCommand, listCommand, editCommand, radarCommand]),
  Command.withDescription(t("cli.group.pkm.about")),
);
