import { t } from "@vibevalley/i18n";
// The endpoints as commands: one per entry in the endpoint table (packages/protocol/src/api.ts), `<group> <op>`, path
// parameters as arguments, query parameters as flags, the body as --json, checked against the endpoint's Schema before it
// is sent. Nothing here knows an endpoint by name but the composite commands, which call them by op; a new endpoint is a
// new command with its help.

import { Config, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { Sse } from "effect/encoding";
import { type HttpClientError, HttpClient, HttpClientRequest } from "effect/http";
import { eventsPath, type IssueStatusValues, statePath } from "@vibevalley/protocol";
import { ApiError, type Endpoint, endpoints, type Handlers, kebab, pathOf, readsOnly } from "@vibevalley/protocol/api";
import * as S from "@vibevalley/protocol/schema";
import { announced, homeOf } from "../base/lease.ts";
import { err, exit, Failure, out, printBody, stdinText } from "./output.ts";

const fallbackServer = "http://127.0.0.1:8787";
/** The server using this machine's home (its server.json), else the configured default port. */
const defaultServer = announced(homeOf()) ?? fallbackServer;

/** --server, else VIBEVALLEY_SERVER, else the one on this machine. */
export const ServerFlag = GlobalFlag.Setting("server")({
  flag: Flag.String("server").pipe(
    Flag.withFallbackConfig(Config.String("VIBEVALLEY_SERVER")),
    Flag.withDefault(defaultServer),
    // The rule, not this machine's address: help reads the same everywhere, and so does its golden data.
    Flag.withDescription(t("server.cli.flag.server", { fallback: fallbackServer })),
  ),
});

/** --dry-run: a command that changes what cannot be taken back answers what it would do (its endpoint's dryRun) and changes
 * nothing; one that only reads runs as it is; any other is refused rather than done. */
export const DryRunFlag = GlobalFlag.Setting("dry-run")({
  flag: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription(t("server.cli.flag.dryRun"))),
});

/** The innermost reason a request did not leave or come back: fetch's "fetch failed" hides ECONNREFUSED in its cause. */
function whyOf(e: HttpClientError.HttpClientError): string {
  let at: unknown = e.reason.cause;
  while (at instanceof Error && at.cause instanceof Error) at = at.cause;
  return at instanceof Error ? at.message : e.message;
}

const unreachable = (base: string) => (e: HttpClientError.HttpClientError) =>
  new Failure({
    code: exit.unreachable,
    tag: "Unreachable",
    text: t("server.cli.failure.unreachable", { base, why: whyOf(e) }),
    next: [{ say: t("server.cli.next.startServer") }],
  });

const codeOf: Readonly<Record<ApiError["_tag"], number>> = {
  Refused: exit.refused,
  Missing: exit.missing,
  VoiceUnavailable: exit.refused,
  VoiceCallFailed: exit.other,
  ConnectorRefused: exit.refused,
  LanRefused: exit.refused,
};

const apiErrorOf = Schema.decodeUnknownOption(Schema.fromJsonString(ApiError));

/** An answer that is not 2xx, as a failure: the server's ApiError when it sent one. */
const failureOf = (status: number, text: string): Failure =>
  Option.match(apiErrorOf(text), {
    // Not the server's ApiError (a 400 from decoding, a 404 for no such route): the words as they came.
    onNone: () => new Failure({ code: status === 404 ? exit.missing : status === 400 ? exit.usage : exit.other, tag: "Server", text: text.trim(), status }),
    onSome: (e) =>
      new Failure({
        code: codeOf[e._tag],
        tag: e._tag,
        text: e._tag === "Missing" ? e.what : e.reason,
        status,
        ...((e._tag === "Refused" || e._tag === "Missing") && e.next ? { next: e.next } : {}),
      }),
  });

const send = (base: string, request: HttpClientRequest.HttpClientRequest) =>
  Effect.flatMap(HttpClient.HttpClient, (client) => client.execute(request)).pipe(Effect.mapError(unreachable(base)));

/** One call: its answer's text, or the failure the server answered with. */
export const request = Effect.fn("Cli.request")(function* (base: string, path: string, body?: string) {
  const plain = HttpClientRequest.post(base + path);
  const res = yield* send(base, body === undefined ? plain : HttpClientRequest.bodyText(plain, body, "application/json"));
  const text = yield* res.text.pipe(Effect.mapError(unreachable(base)));
  if (res.status < 200 || res.status >= 300) return yield* failureOf(res.status, text);
  return text;
});

const call = (base: string, op: keyof Handlers, input?: Readonly<Record<string, unknown>>) =>
  request(base, pathOf(op), input === undefined ? undefined : JSON.stringify(input));

/** An answer read by its Schema; one that is not is the server's fault, not the command's. */
const answer =
  <T>(schema: Schema.Codec<T>) =>
  (text: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError((issue) => new Failure({ code: exit.other, tag: "Server", text: t("server.cli.failure.shape", { why: issue.message }) })),
    );

const usage = (path: readonly string[], text: string, tag = "InvalidValue") =>
  new Failure({ code: exit.usage, tag, text, next: [{ say: t("server.cli.next.help"), run: [...path, "--help"] }] });

/** --json's text: as given, `-` for stdin, `@file` for a file's. */
const bodyText = (given: string, path: readonly string[]) =>
  given === "-"
    ? stdinText.pipe(Effect.mapError((e) => usage(path, t("server.cli.failure.stdin", { why: e.message }))))
    : given.startsWith("@")
      ? Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(given.slice(1))).pipe(
          Effect.mapError((e) => usage(path, t("server.cli.failure.file", { file: given.slice(1), why: e.message }))),
        )
      : Effect.succeed(given);

const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The input, --json's fields and the arguments together, checked against the endpoint's Schema here, so a wrong field is
 * named before anything is sent. */
const checkedInput = Effect.fnUntraced(function* (e: Endpoint, given: string, args: Readonly<Record<string, unknown>>, path: readonly string[]) {
  const text = given === "" ? "{}" : yield* bodyText(given, path);
  const fields = yield* json(text).pipe(Effect.mapError((issue) => usage(path, t("server.cli.failure.notJson", { why: issue.message }), "InvalidJson")));
  const value = { ...(fields as Record<string, unknown>), ...args };
  const missing = e.about.find((name) => value[name] === undefined);
  if (missing !== undefined) return yield* usage(path, t("server.cli.failure.missingArgument", { name: missing }), "MissingArgument");
  yield* Schema.decodeEffect(e.input!)(value).pipe(Effect.mapError((issue) => usage(path, t("server.cli.failure.body", { op: e.op, why: issue.message }))));
  return JSON.stringify(value);
});

/** One endpoint as a command, `<module> [<noun>] <verb>`: what it is about as arguments, the rest of its input as --json. The
 * config is built from the table, so it is typed loosely here and read back by name. */
function endpointCommand(e: Endpoint) {
  const path = e.op.split(".").map(kebab);
  const config: Record<string, Argument.Argument<unknown> | Flag.Flag<unknown>> = {};
  // Optional, so what it is about can come in --json too; a field missing from both is named by the input's Schema.
  for (const name of e.about) config[name] = Argument.String(name).pipe(Argument.optional);
  // Any input takes --json, what it is about included: a script writes the whole input in one place.
  if (e.input) config.json = Flag.String("json").pipe(Flag.optional, Flag.withDescription(t("server.cli.flag.json")));
  return Command.make(path.at(-1)!, config as never, (given: Record<string, unknown>) =>
    Effect.gen(function* () {
      const base = yield* ServerFlag;
      const args = Object.fromEntries(
        e.about.flatMap((name) => Option.match(given[name] as Option.Option<string>, { onNone: () => [], onSome: (v) => [[name, v] as const] })),
      );
      const body = e.input
        ? yield* checkedInput(
            e,
            Option.getOrElse((given.json as Option.Option<string> | undefined) ?? Option.none(), () => ""),
            args,
            path,
          )
        : undefined;
      if (yield* DryRunFlag) {
        if (e.dryRun) return yield* printBody(yield* request(base, pathOf(e.dryRun), body));
        if (!readsOnly(e.op))
          return yield* new Failure({
            code: exit.usage,
            tag: "NoDryRun",
            text: t("server.cli.failure.dryRun", { op: e.op }),
            next: [{ say: t("server.cli.next.whatItDoes"), run: [...path, "--help"] }],
          });
      }
      yield* printBody(yield* request(base, pathOf(e.op), body));
    }),
  ).pipe(Command.withDescription(`POST ${pathOf(e.op)}`));
}

/** /api/v1/state or /api/v1/events: each frame's data as it comes. */
const frames = (base: string, path: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const res = yield* send(base, HttpClientRequest.get(base + path).pipe(HttpClientRequest.accept("text/event-stream")));
      if (res.status !== 200) return yield* failureOf(res.status, yield* res.text.pipe(Effect.mapError(unreachable(base))));
      return res.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.map((e) => e.data),
        Stream.mapError((e) =>
          e._tag === "HttpClientError"
            ? unreachable(base)(e)
            : new Failure({
                code: exit.other,
                tag: "Server",
                text: e._tag === "Retry" ? t("server.cli.failure.retry") : t("server.cli.failure.stream", { why: e.message }),
              }),
        ),
      );
    }),
  );

export const stateCommand = Command.make(
  "state",
  { watch: Flag.Boolean("watch").pipe(Flag.withDefault(false), Flag.withDescription(t("server.cli.flag.watch"))) },
  ({ watch }) =>
    Effect.flatMap(ServerFlag, (base) =>
      // The server writes each frame on one line, so a stream is one line per frame whatever stdout is; one frame alone
      // is a document.
      watch ? Stream.runForEach(frames(base, statePath), out) : Stream.runForEach(Stream.take(frames(base, statePath), 1), printBody),
    ),
).pipe(Command.withDescription(t("server.cli.command.state", { path: statePath })));

export const eventsCommand = Command.make("events", {}, () => Effect.flatMap(ServerFlag, (base) => Stream.runForEach(frames(base, eventsPath), out))).pipe(
  Command.withDescription(t("server.cli.command.events", { path: eventsPath })),
);

/** Only what `issue work` reads of a frame; the rest is left as it came. */
const IssuesOfFrame = Schema.fromJsonString(
  Schema.Struct({ state: Schema.Struct({ issues: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, status: S.IssueStatus }))) }) }),
);
const settled = new Set<string>(["in_review", "done", "canceled"] satisfies (typeof IssueStatusValues)[number][]);

/** `issue work <id>`: a backlog issue to todo, then follows it in the core state while it waits for room or is worked, and
 * prints its changes. One already sent is only followed. It ends in review, done or canceled; each status it passes goes
 * to stderr. */
export const issueWorkCommand = Command.make("work", { id: Argument.String("id") }, ({ id }) =>
  Effect.gen(function* () {
    const base = yield* ServerFlag;
    const issue = yield* call(base, "issue.get", { id }).pipe(Effect.flatMap(answer(S.Issue)));
    if (issue.status === "backlog") yield* call(base, "issue.status.update", { id: issue.id, status: "todo" });
    yield* frames(base, statePath).pipe(
      Stream.mapEffect((data) =>
        Schema.decodeEffect(IssuesOfFrame)(data).pipe(Effect.mapError((e) => new Failure({ code: exit.other, tag: "Server", text: e.message }))),
      ),
      Stream.filter((frame) => frame.state.issues !== undefined),
      Stream.mapEffect((frame) => {
        const now = frame.state.issues!.find((i) => i.id === issue.id);
        return now
          ? Effect.succeed(now.status)
          : Effect.fail(new Failure({ code: exit.missing, tag: "Missing", text: t("server.cli.failure.gone", { n: issue.number }) }));
      }),
      Stream.changes,
      Stream.tap((status) => err(JSON.stringify({ issue: issue.number, status }))),
      Stream.takeUntil((status) => settled.has(status)),
      Stream.runDrain,
    );
    yield* printBody(yield* call(base, "issue.diff.get", { id: issue.id }));
  }),
).pipe(Command.withDescription(t("server.cli.command.issueWork")));

/** Every endpoint as `<module> [<noun>] <verb>`, with the hand-written commands of a module (issue work, runtime chat) beside them. */
export function groupCommands(extra: Readonly<Record<string, readonly Command.Command.Any[]>>) {
  const modules = new Map<string, { own: Command.Command.Any[]; nouns: Map<string, Command.Command.Any[]> }>();
  const of = (m: string) => modules.get(m) ?? (modules.set(m, { own: [], nouns: new Map() }), modules.get(m)!);
  for (const e of endpoints) {
    const [m, ...rest] = e.op.split(".").map(kebab);
    if (rest.length === 1) of(m!).own.push(endpointCommand(e));
    else of(m!).nouns.set(rest[0]!, [...(of(m!).nouns.get(rest[0]!) ?? []), endpointCommand(e)]);
  }
  for (const [m, commands] of Object.entries(extra)) of(m).own.push(...commands);
  const group = (name: string, commands: readonly Command.Command.Any[]) =>
    Command.make(name).pipe(Command.withSubcommands(commands as never), Command.withDescription(t("server.cli.command.group", { group: name })));
  return [...modules].map(([m, { own, nouns }]) => group(m, [...own, ...[...nouns].map(([n, cs]) => group(n, cs))])) as Command.Command.Any[];
}
