import { Config, Effect, Option, Predicate, Schema, Stream } from "effect";
import { Flag, GlobalFlag } from "effect/cli";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest } from "effect/http";

import { announced, homeOf } from "@vibevalley/home";
import { t } from "@vibevalley/i18n";
import { type Preview, VibeValleyApi, type VibeValleyApiError } from "@vibevalley/protocol";
import { ApiError } from "@vibevalley/protocol/api";

import { exit, Failure, type Next, out, printBody } from "./output.ts";

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

const codeOf: Readonly<Record<ApiError["_tag"], number>> = {
  Refused: exit.refused,
  Missing: exit.missing,
  VoiceUnavailable: exit.refused,
  VoiceCallFailed: exit.other,
  ConnectorRefused: exit.refused,
  LanRefused: exit.refused,
};

const nextOf = (e: ApiError | undefined): readonly Next[] => (e && (e._tag === "Refused" || e._tag === "Missing") && e.next ? e.next : []);

/** The innermost reason a request did not leave: fetch's "fetch failed" hides ECONNREFUSED in its cause. */
function innermost(e: unknown): string {
  let at: unknown = Predicate.hasProperty(e, "reason") && Predicate.hasProperty(e.reason, "cause") ? e.reason.cause : e;
  while (at instanceof Error && at.cause instanceof Error) at = at.cause;
  return at instanceof Error ? at.message : Predicate.hasProperty(e, "message") && typeof e.message === "string" ? e.message : String(e);
}

const unreachable = (base: string, e: unknown) =>
  new Failure({
    code: exit.unreachable,
    tag: "Unreachable",
    text: t("cli.failure.unreachable", { base, why: innermost(e) }),
    next: [{ say: t("cli.next.openApp"), run: ["app", "open"] }, { say: t("cli.next.startServer") }],
  });

const apiErrorOf = Schema.decodeUnknownOption(Schema.fromJsonString(ApiError));

const failureOf = (status: number, text: string): Failure =>
  Option.match(apiErrorOf(text), {
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

/** /api/v1/state SSE frames as they come. */
export const frames = (base: string, path: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const request = HttpClientRequest.get(base + path).pipe(HttpClientRequest.accept("text/event-stream"));
      const res = yield* Effect.flatMap(HttpClient.HttpClient, (client) => client.execute(request)).pipe(Effect.mapError((e) => unreachable(base, e)));
      if (res.status !== 200) return yield* failureOf(res.status, yield* res.text.pipe(Effect.mapError((e) => unreachable(base, e))));
      return res.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.map((e) => e.data),
        Stream.mapError((e) =>
          e._tag === "HttpClientError"
            ? unreachable(base, e)
            : new Failure({
                code: exit.other,
                tag: "Server",
                text: e._tag === "Retry" ? t("cli.failure.retry") : t("cli.failure.stream", { why: e.message }),
              }),
        ),
      );
    }),
  );

/** The client's refusal: an answer the server gave, with its status and reason. */
const refusal = (e: unknown): e is VibeValleyApiError => Predicate.hasProperty(e, "status") && Predicate.hasProperty(e, "reason");

function failureFrom(base: string, e: unknown): Failure {
  if (!refusal(e)) return unreachable(base, e);
  const tag = e.error?._tag ?? e.tag;
  const code = e.error ? codeOf[e.error._tag] : e.status === 404 ? exit.missing : e.status === 400 ? exit.usage : exit.other;
  return new Failure({ code, tag: tag ?? "Server", text: e.reason, status: e.status, next: nextOf(e.error) });
}

/** One question to the farm at --server, typed by the endpoint it calls. */
export const ask = <A>(use: (api: VibeValleyApi) => Promise<A>) =>
  Effect.flatMap(ServerFlag, (base) => Effect.tryPromise({ try: () => use(new VibeValleyApi(base)), catch: (e) => failureFrom(base, e) }));

/** The answer as --format says: text by its own lines, json as the protocol has it. */
export const show = <A>(value: A, text: (value: A) => string) =>
  Effect.flatMap(FormatFlag, (format) => (format === "json" ? printBody(JSON.stringify(value ?? null)) : out(text(value))));

/** A change, or with --dry-run what it would do: by the endpoint's own dry run where it has one; a change with none is
 * refused rather than made. */
export const change = <A>(o: {
  readonly name: string;
  readonly preview?: (api: VibeValleyApi) => Promise<Preview>;
  readonly does: (api: VibeValleyApi) => Promise<A>;
  readonly said: (done: A) => string;
  readonly as?: (done: A) => unknown;
}) =>
  Effect.gen(function* () {
    if (yield* DryRunFlag) {
      if (!o.preview) return yield* new Failure({ code: exit.usage, tag: "NoDryRun", text: t("cli.failure.noDryRun", { command: o.name }) });
      return yield* show(yield* ask(o.preview), (p) => p.does.join("\n"));
    }
    const done = yield* ask(o.does);
    yield* show(o.as ? o.as(done) : done, () => o.said(done));
  });

/** A flag's value, or nothing for the request to leave out. */
export const given = <A>(o: Option.Option<A>): A | undefined => Option.getOrUndefined(o);
