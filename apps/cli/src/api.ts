import { Config, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { Sse } from "effect/encoding";
import { type HttpClientError, HttpClient, HttpClientRequest } from "effect/http";

import { announced, homeOf } from "@vibevalley/home";
import { maybe, t } from "@vibevalley/i18n";
import { eventsPath, statePath } from "@vibevalley/protocol";
import { ApiError, endpoints, pathOf, readsOnly } from "@vibevalley/protocol/api";

import { exit, Failure, out, printBody, stdinText } from "./output.ts";

const fallbackServer = "http://127.0.0.1:8787";
/** The server using this machine's home (its server.json), else the configured default port. */
const defaultServer = announced(homeOf()) ?? fallbackServer;

/** --server, else VIBEVALLEY_SERVER, else the one on this machine. */
export const ServerFlag = GlobalFlag.Setting("server")({
  flag: Flag.String("server").pipe(
    Flag.withFallbackConfig(Config.String("VIBEVALLEY_SERVER")),
    Flag.withDefault(defaultServer),
    // The rule, not this machine's address: help reads the same everywhere, and so does its golden data.
    Flag.withDescription(t("cli.flag.server", { fallback: fallbackServer })),
  ),
});

/** --dry-run: a command that changes what cannot be taken back answers what it would do (its endpoint's dryRun) and changes nothing. */
export const DryRunFlag = GlobalFlag.Setting("dry-run")({
  flag: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription(t("cli.flag.dryRun"))),
});

/** --format: text (the default) is short lines to read, json the protocol's shape for whatever parses it. */
export const FormatFlag = GlobalFlag.Setting("format")({
  flag: Flag.Literals("format", ["text", "json"]).pipe(Flag.withDefault("text" as const), Flag.withDescription(t("cli.flag.format"))),
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
    text: t("cli.failure.unreachable", { base, why: whyOf(e) }),
    next: [{ say: t("cli.next.startServer") }],
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
const request = Effect.fn("Cli.request")(function* (base: string, path: string, body?: string) {
  const plain = HttpClientRequest.post(base + path);
  const res = yield* send(base, body === undefined ? plain : HttpClientRequest.bodyText(plain, body, "application/json"));
  const text = yield* res.text.pipe(Effect.mapError(unreachable(base)));
  if (res.status < 200 || res.status >= 300) return yield* failureOf(res.status, text);
  return text;
});

const usage = (path: readonly string[], text: string, tag = "InvalidValue") =>
  new Failure({ code: exit.usage, tag, text, next: [{ say: t("cli.next.help"), run: [...path, "--help"] }] });

/** --json's text: as given, `-` for stdin, `@file` for a file's. */
const bodyText = (given: string, path: readonly string[]) =>
  given === "-"
    ? stdinText.pipe(Effect.mapError((e) => usage(path, t("cli.failure.stdin", { why: e.message }))))
    : given.startsWith("@")
      ? Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(given.slice(1))).pipe(
          Effect.mapError((e) => usage(path, t("cli.failure.file", { file: given.slice(1), why: e.message }))),
        )
      : Effect.succeed(given);

const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** /api/v1/state or /api/v1/events: each frame's data as it comes. */
export const frames = (base: string, path: string) =>
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
                text: e._tag === "Retry" ? t("cli.failure.retry") : t("cli.failure.stream", { why: e.message }),
              }),
        ),
      );
    }),
  );

const callPath = ["api", "call"];

/** `api call <op>`: the endpoint by its op, --json checked against its input's Schema before anything is sent. */
const callCommand = Command.make(
  "call",
  {
    op: Argument.String("op").pipe(Argument.withDescription(t("cli.arg.op"))),
    json: Flag.String("json").pipe(Flag.optional, Flag.withDescription(t("cli.flag.json"))),
  },
  (o) =>
    Effect.gen(function* () {
      const e = endpoints.find((x) => x.op === o.op);
      if (!e)
        return yield* new Failure({
          code: exit.missing,
          tag: "Missing",
          text: t("cli.failure.noOp", { op: o.op }),
          next: [{ say: t("cli.next.listOps"), run: ["api", "list"] }],
        });
      let body: string | undefined;
      if (e.input) {
        const text = Option.isSome(o.json) ? yield* bodyText(o.json.value, callPath) : "{}";
        const value = yield* json(text).pipe(Effect.mapError((issue) => usage(callPath, t("cli.failure.notJson", { why: issue.message }), "InvalidJson")));
        yield* Schema.decodeUnknownEffect(e.input)(value).pipe(
          Effect.mapError((issue) => usage(callPath, t("cli.failure.body", { op: e.op, why: issue.message }))),
        );
        body = JSON.stringify(value);
      }
      const base = yield* ServerFlag;
      if (yield* DryRunFlag) {
        if (e.dryRun) return yield* printBody(yield* request(base, pathOf(e.dryRun), body));
        if (!readsOnly(e.op)) return yield* new Failure({ code: exit.usage, tag: "NoDryRun", text: t("cli.failure.dryRun", { op: e.op }) });
      }
      yield* printBody(yield* request(base, pathOf(e.op), body));
    }),
).pipe(
  Command.withDescription(t("cli.command.api.call")),
  Command.withExamples([{ command: 'vibevalley api call issue.get --json \'{"id":"12"}\'', description: t("cli.example.apiCall.about") }]),
);

/** `api list`: each endpoint, what it does and, as JSON, its input's JSON Schema and who may call it. */
const listCommand = Command.make("list", { module: Flag.String("module").pipe(Flag.optional, Flag.withDescription(t("cli.flag.module"))) }, (o) =>
  Effect.gen(function* () {
    const chosen = endpoints.filter((e) => Option.isNone(o.module) || e.op.split(".")[0] === o.module.value);
    if ((yield* FormatFlag) === "text") {
      // By module, each under its line: what an agent scans to find the one it needs.
      const modules = [...new Set(chosen.map((e) => e.op.split(".")[0] ?? ""))];
      return yield* out(
        modules
          .map((m) =>
            [
              `${m}  ${maybe(`cli.group.${m}.about`) ?? ""}`,
              ...chosen.filter((e) => e.op.split(".")[0] === m).map((e) => `  ${e.op}  ${t(`cli.op.${e.op}`)}`),
            ].join("\n"),
          )
          .join("\n\n"),
      );
    }
    yield* printBody(
      JSON.stringify(
        chosen.map((e) => ({
          op: e.op,
          does: t(`cli.op.${e.op}`),
          can: e.can,
          ...(e.dryRun ? { dryRun: e.dryRun } : {}),
          input: e.input ? Schema.toJsonSchemaDocument(e.input).schema : null,
        })),
      ),
    );
  }),
).pipe(
  Command.withDescription(t("cli.command.api.list")),
  Command.withExamples([{ command: "vibevalley api list --module pkm --format json", description: t("cli.example.apiList.about") }]),
);

const stateCommand = Command.make(
  "state",
  { watch: Flag.Boolean("watch").pipe(Flag.withDefault(false), Flag.withDescription(t("cli.flag.watch"))) },
  ({ watch }) =>
    Effect.flatMap(ServerFlag, (base) =>
      // The server writes each frame on one line, so a stream is one line per frame whatever stdout is; one frame alone
      // is a document.
      watch ? Stream.runForEach(frames(base, statePath), out) : Stream.runForEach(Stream.take(frames(base, statePath), 1), printBody),
    ),
).pipe(
  Command.withDescription(t("cli.command.state", { path: statePath })),
  Command.withExamples([{ command: "vibevalley api state --watch", description: t("cli.example.apiState.about") }]),
);

const eventsCommand = Command.make("events", {}, () => Effect.flatMap(ServerFlag, (base) => Stream.runForEach(frames(base, eventsPath), out))).pipe(
  Command.withDescription(t("cli.command.events", { path: eventsPath })),
  Command.withExamples([{ command: "vibevalley api events", description: t("cli.example.apiEvents.about") }]),
);

export const apiCommand = Command.make("api").pipe(
  Command.withSubcommands([listCommand, callCommand, stateCommand, eventsCommand]),
  Command.withDescription(t("cli.command.api.about")),
);
