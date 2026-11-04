// What every task-shaped command (cli/issue.ts, cli/channel.ts…) stands on: the farm asked through the typed client
// (VibeValleyApi, written from api.ts), a refusal turned into the command line's failure, the answer printed as short
// text or, with --format json, as the protocol's shape, and --dry-run kept to what can be tried.

import { Effect, Option, Predicate } from "effect";

import { t } from "@vibevalley/i18n";
import { type Preview, VibeValleyApi, type VibeValleyApiError } from "@vibevalley/protocol";
import type { ApiError } from "@vibevalley/protocol/api";

import { DryRunFlag, FormatFlag, ServerFlag } from "./api.ts";
import { exit, Failure, type Next, out, printBody } from "./output.ts";

const codeOf: Readonly<Record<ApiError["_tag"], number>> = {
  Refused: exit.refused,
  Missing: exit.missing,
  VoiceUnavailable: exit.refused,
  VoiceCallFailed: exit.other,
  ConnectorRefused: exit.refused,
  LanRefused: exit.refused,
};

const nextOf = (e: ApiError | undefined): readonly Next[] => (e && (e._tag === "Refused" || e._tag === "Missing") && e.next ? e.next : []);

/** The client's error as the command line says it: the server's refusal with its next steps, or no server at all. */
/** The innermost reason a request did not leave: fetch's "fetch failed" hides ECONNREFUSED in its cause. */
function innermost(e: unknown): string {
  let at = e;
  while (at instanceof Error && at.cause instanceof Error) at = at.cause;
  return at instanceof Error ? at.message : String(at);
}

/** The client's refusal: an answer the server gave, with its status and reason. */
const refusal = (e: unknown): e is VibeValleyApiError => Predicate.hasProperty(e, "status") && Predicate.hasProperty(e, "reason");

function failureFrom(base: string, e: unknown): Failure {
  if (refusal(e)) {
    const tag = e.error?._tag ?? e.tag;
    const code = e.error ? codeOf[e.error._tag] : e.status === 404 ? exit.missing : e.status === 400 ? exit.usage : exit.other;
    return new Failure({ code, tag: tag ?? "Server", text: e.reason, status: e.status, next: nextOf(e.error) });
  }
  return new Failure({
    code: exit.unreachable,
    tag: "Unreachable",
    text: t("cli.failure.unreachable", { base, why: innermost(e) }),
    next: [{ say: t("cli.next.openApp"), run: ["app", "open"] }, { say: t("cli.next.startServer") }],
  });
}

/** One question to the farm at --server, typed by the endpoint it calls. */
export const ask = <A>(use: (api: VibeValleyApi) => Promise<A>) =>
  Effect.flatMap(ServerFlag, (base) => Effect.tryPromise({ try: () => use(new VibeValleyApi(base)), catch: (e) => failureFrom(base, e) }));

/** The answer as --format says: text by its own lines, json as the protocol has it. */
export const show = <A>(value: A, text: (value: A) => string) =>
  Effect.flatMap(FormatFlag, (format) => (format === "json" ? printBody(JSON.stringify(value ?? null)) : out(text(value))));

/** A change, or with --dry-run what it would do: by the endpoint's own dry run where it has one; a change with none is
 * refused rather than made. Quiet, the change is made and not printed: the command answers with what follows it. */
export const change = <A>(o: {
  readonly name: string;
  readonly preview?: (api: VibeValleyApi) => Promise<Preview>;
  readonly does: (api: VibeValleyApi) => Promise<A>;
  readonly said: (done: A) => string;
  readonly as?: (done: A) => unknown;
  readonly quiet?: boolean;
}) =>
  Effect.gen(function* () {
    if (yield* DryRunFlag) {
      if (!o.preview) return yield* new Failure({ code: exit.usage, tag: "NoDryRun", text: t("cli.failure.noDryRun", { command: o.name }) });
      return yield* show(yield* ask(o.preview), (p) => p.does.join("\n"));
    }
    const done = yield* ask(o.does);
    if (o.quiet === true) return;
    yield* show(o.as ? o.as(done) : done, () => o.said(done));
  });

/** A thing named the way a person names it (a channel's name, a profile's), found among all of its kind by id or name;
 * none or more than one is refused, the candidates named. */
export function pick<A>(all: readonly A[], said: string, keys: (a: A) => readonly (string | undefined)[], label: (a: A) => string, what: string) {
  const want = said.replace(/^[#@]/u, "").toLowerCase();
  const exact = all.filter((a) => keys(a).some((k) => k !== undefined && k.toLowerCase() === want));
  const found = exact.length > 0 ? exact : all.filter((a) => keys(a).some((k) => k !== undefined && k.toLowerCase().includes(want)));
  if (found.length === 1 && found[0] !== undefined) return Effect.succeed(found[0]);
  const named = (found.length > 0 ? found : all).slice(0, 8).map(label);
  return Effect.fail(
    new Failure({
      code: found.length === 0 ? exit.missing : exit.usage,
      tag: found.length === 0 ? "Missing" : "Ambiguous",
      text: t(found.length === 0 ? "cli.failure.noSuch" : "cli.failure.ambiguous", { what, said, these: named.join(", ") }),
    }),
  );
}

/** A flag's value, or nothing for the request to leave out. */
export const given = <A>(o: Option.Option<A>): A | undefined => Option.getOrUndefined(o);
