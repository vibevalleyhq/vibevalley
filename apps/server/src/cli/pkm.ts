// The notes from a terminal (`vibevalley pkm …`), written by hand beside the endpoints' commands: notes are text, so what
// these read comes out as Markdown, the endpoint's JSON with --format json. They replace the generated command or group
// of their name (groupCommands); the rest of pkm stays as the endpoints are.

import { join } from "node:path";

import { Clock, Config, Effect, FileSystem, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { t } from "@vibevalley/i18n";
import * as S from "@vibevalley/protocol/schema";

import { answer, call, ServerFlag } from "./api.ts";
import { exit, Failure, out, printBody, stdinText } from "./output.ts";

const format = Flag.Literals("format", ["md", "json"]).pipe(Flag.withDefault("md" as const), Flag.withDescription(t("server.cli.flag.format")));

const words = Argument.String("words").pipe(Argument.variadic());

/** Today on this machine, YYYY-MM-DD (sv-SE writes dates so). */
const today = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toLocaleDateString("sv-SE"));

/** A page as Markdown for people (pkm.page.export), or as the endpoint gives it. */
const printPage = (base: string, page: string, as: "md" | "json") =>
  as === "json"
    ? Effect.flatMap(call(base, "pkm.page.get", { page }), printBody)
    : call(base, "pkm.page.export", { page }).pipe(
        Effect.flatMap(answer(S.PkmMarkdown)),
        Effect.flatMap((m) => out(m.markdown.replace(/\n+$/u, ""))),
      );

/** `pkm capture 一句话`: into today's journal, or --page's end; with no words, what comes on stdin, read as an outline. */
const captureCommand = Command.make(
  "capture",
  { words, page: Flag.String("page").pipe(Flag.optional, Flag.withDescription(t("server.cli.flag.capturePage"))), format },
  (o) =>
    Effect.gen(function* () {
      const base = yield* ServerFlag;
      const text = o.words.length > 0 ? o.words.join(" ") : yield* stdinText.pipe(Effect.orElseSucceed(() => ""));
      const page = Option.getOrUndefined(o.page);
      const done = yield* call(base, "pkm.capture", { text, ...(page === undefined ? {} : { page }) });
      if (o.format === "json") return yield* printBody(done);
      const written = yield* answer(S.PkmPage)(done);
      yield* out(t("server.cli.pkm.captured", { page: written.title }));
    }),
).pipe(Command.withDescription(t("server.cli.command.pkm.capture")));

/** `pkm today`: a day's journal, made when it has none (--day YYYY-MM-DD for another). */
const todayCommand = Command.make("today", { day: Flag.String("day").pipe(Flag.optional, Flag.withDescription(t("server.cli.flag.day"))), format }, (o) =>
  Effect.gen(function* () {
    const base = yield* ServerFlag;
    const day = Option.isSome(o.day) ? o.day.value : yield* today;
    const journal = yield* call(base, "pkm.journal.open", { day }).pipe(Effect.flatMap(answer(S.PkmPage)));
    yield* printPage(base, journal.slug, o.format);
  }),
).pipe(Command.withDescription(t("server.cli.command.pkm.today")));

/** `pkm search 读书 笔记`: one hit a line, page › where: words. */
const searchCommand = Command.make("search", { words, format }, (o) =>
  Effect.gen(function* () {
    const base = yield* ServerFlag;
    const found = yield* call(base, "pkm.search", { text: o.words.join(" ") });
    if (o.format === "json") return yield* printBody(found);
    const hits = yield* answer(Schema.Array(S.PkmSearchHit))(found);
    yield* out(hits.map((h) => `${h.pageTitle} › ${h.path === "" ? "" : `${h.path}: `}${h.plain}`).join("\n"));
  }),
).pipe(Command.withDescription(t("server.cli.command.pkm.search")));

/** `pkm radar`: what wants a look, as lines. */
const radarCommand = Command.make("radar", { format }, (o) =>
  Effect.gen(function* () {
    const base = yield* ServerFlag;
    const said = yield* call(base, "pkm.radar.get", {});
    if (o.format === "json") return yield* printBody(said);
    const radar = yield* answer(S.PkmRadar)(said);
    yield* out(
      [
        t("server.cli.pkm.inbox", { n: radar.inbox }),
        ...radar.stale.map((p) => t("server.cli.pkm.stale", { page: p.title, days: p.days })),
        ...radar.overdue.map((d) => t("server.cli.pkm.overdue", { deadline: d.deadline, words: d.plain })),
      ].join("\n"),
    );
  }),
).pipe(Command.withDescription(t("server.cli.command.pkm.radar")));

const pageArgument = Argument.String("page");

/** $VISUAL, else $EDITOR, else vi: a command line, the file added as its last word. */
const editorCommand = Config.all({
  visual: Config.String("VISUAL").pipe(Config.withDefault("")),
  editor: Config.String("EDITOR").pipe(Config.withDefault("")),
}).pipe(Config.map(({ visual, editor }) => visual || editor || "vi"));

const pageGetCommand = Command.make("get", { page: pageArgument, format }, (o) => Effect.flatMap(ServerFlag, (base) => printPage(base, o.page, o.format))).pipe(
  Command.withDescription(t("server.cli.command.pkm.pageGet")),
);

/** `pkm page edit 读书`: the page's file in $VISUAL or $EDITOR (vi without either), written back when the editor closes;
 * left as it was if nothing changed. One changed meanwhile is not overwritten: the edit stays in its file, named. */
const pageEditCommand = Command.make("edit", { page: pageArgument }, (o) =>
  Effect.gen(function* () {
    const base = yield* ServerFlag;
    const source = yield* call(base, "pkm.source.get", { page: o.page }).pipe(Effect.flatMap(answer(S.PkmSource)));
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
      .pipe(Effect.mapError((e) => new Failure({ code: exit.other, tag: "Editor", text: t("server.cli.pkm.editorFailed", { editor, why: e.message }) })));
    if (code !== 0) return yield* new Failure({ code: exit.other, tag: "Editor", text: t("server.cli.pkm.editorExited", { editor, code, file }) });
    const edited = yield* fs.readFileString(file).pipe(Effect.mapError(kept));
    if (edited === source.markdown) return yield* out(t("server.cli.pkm.unchanged", { page: source.title }));
    yield* call(base, "pkm.source.update", { page: source.page, markdown: edited, updated: source.updated }).pipe(
      Effect.mapError((f) => (f.tag === "Refused" ? new Failure({ ...f, text: t("server.cli.pkm.keptAt", { why: f.text, file }) }) : f)),
    );
    yield* out(t("server.cli.pkm.saved", { page: source.title }));
  }),
).pipe(Command.withDescription(t("server.cli.command.pkm.pageEdit")));

/** What pkm's group holds beside the endpoints, by where: the module's own, and the page noun's. */
export const pkmCommands = { pkm: [captureCommand, todayCommand, searchCommand, radarCommand], "pkm.page": [pageGetCommand, pageEditCommand] };
