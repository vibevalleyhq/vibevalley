// The endpoints as commands: one per entry in the endpoint table (packages/protocol/src/api.ts), `<group> <op>`, path
// parameters as arguments, query parameters as flags, the body as --json, checked against the endpoint's Schema before it
// is sent. Nothing here knows an endpoint by name but the composite commands, which call them by op; a new endpoint is a
// new command with its help.

import { Config, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { Sse } from "effect/encoding";
import { type HttpClientError, HttpClient, HttpClientRequest } from "effect/http";
import { eventsPath, IssueStatusValues, statePath } from "@vibevalley/protocol";
import { ApiError, type Endpoint, endpoints, type Handlers } from "@vibevalley/protocol/api";
import * as S from "@vibevalley/protocol/schema";
import { err, exit, Failure, out, printBody, stdinText } from "./output.ts";

const defaultServer = "http://127.0.0.1:8787";

/** --server, else VIBEVALLEY_SERVER, else the one on this machine. */
export const ServerFlag = GlobalFlag.Setting("server")({
  flag: Flag.String("server").pipe(
    Flag.withFallbackConfig(Config.String("VIBEVALLEY_SERVER")),
    Flag.withDefault(defaultServer),
    Flag.withDescription(`服务端的地址；不填用 VIBEVALLEY_SERVER，再没有是 ${defaultServer}`),
  ),
});

/** --dry-run: a command that changes what cannot be taken back answers what it would do (its endpoint's dryRun) and changes
 * nothing; one that only reads runs as it is; any other is refused rather than done. */
export const DryRunFlag = GlobalFlag.Setting("dry-run")({
  flag: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("只说会做什么，不动手（会删、会合、会关、会让帮工走的命令）")),
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
    text: `连不上 ${base}：${whyOf(e)}`,
    next: [{ say: "先起服务端（apps/server 下 npm start），或用 --server 指到在跑的那个" }],
  });

const codeOf: Readonly<Record<ApiError["_tag"], number>> = {
  Refused: exit.refused,
  Missing: exit.missing,
  VoiceUnavailable: exit.refused,
  VoiceAgentFailed: exit.other,
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
export const request = Effect.fnUntraced(function* (base: string, method: Endpoint["method"], path: string, body?: string) {
  const plain = HttpClientRequest.make(method)(base + path);
  const res = yield* send(base, body === undefined ? plain : HttpClientRequest.bodyText(plain, body, "application/json"));
  const text = yield* res.text.pipe(Effect.mapError(unreachable(base)));
  if (res.status < 200 || res.status >= 300) return yield* Effect.fail(failureOf(res.status, text));
  return text;
});

const endpointOf = (op: keyof Handlers) => endpoints.find((e) => e.op === op)!;

/** The endpoint's path with its parameters filled in, and its query. */
function urlOf(e: Endpoint, given: Readonly<Record<string, unknown>>) {
  const path = e.path.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(given[k])));
  const q = new URLSearchParams();
  for (const p of e.query) {
    const v = given[p.name] as Option.Option<unknown> | undefined;
    if (v && Option.isSome(v)) q.set(p.name, String(v.value));
  }
  return path + (q.size > 0 ? "?" + q.toString() : "");
}

const call = (base: string, op: keyof Handlers, given: Readonly<Record<string, unknown>>, body?: string) => {
  const e = endpointOf(op);
  return request(base, e.method, urlOf(e, given), body);
};

/** An answer read by its Schema; one that is not is the server's fault, not the command's. */
const answer =
  <T>(schema: Schema.Codec<T>) =>
  (text: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError((issue) => new Failure({ code: exit.other, tag: "Server", text: `答复不合 Schema：${issue.message}` })),
    );

/** How a command writes an op: editNode is edit-node. */
export const kebab = (op: string) => op.replace(/[A-Z]/g, (c, i: number) => (i > 0 ? "-" : "") + c.toLowerCase());

const usage = (path: readonly string[], text: string, tag = "InvalidValue") =>
  new Failure({ code: exit.usage, tag, text, next: [{ say: "看这条命令怎么写", run: [...path, "--help"] }] });

/** --json's text: as given, `-` for stdin, `@file` for a file's. */
const bodyText = (given: string, path: readonly string[]) =>
  given === "-"
    ? stdinText.pipe(Effect.mapError((e) => usage(path, `读不了标准输入：${e.message}`)))
    : given.startsWith("@")
      ? Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(given.slice(1))).pipe(
          Effect.mapError((e) => usage(path, `读不了 ${given.slice(1)}：${e.message}`)),
        )
      : Effect.succeed(given);

const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The body checked against the endpoint's Schema here, so a wrong field is named before anything is sent. */
const checkedBody = Effect.fnUntraced(function* (e: Endpoint, given: string, path: readonly string[]) {
  const text = given === "" ? "{}" : yield* bodyText(given, path);
  const value = yield* json(text).pipe(Effect.mapError((issue) => usage(path, `--json 不是 JSON：${issue.message}`, "InvalidJson")));
  yield* Schema.decodeUnknownEffect(e.body!)(value).pipe(Effect.mapError((issue) => usage(path, `--json 不合 ${e.op} 的请求体：${issue.message}`)));
  return text;
});

const param = (name: string, number: boolean) => (number ? Argument.Int(name) : Argument.String(name));
const queryFlag = (name: string, number: boolean): Flag.Flag<Option.Option<unknown>> =>
  number ? Flag.optional(Flag.Int(name)) : Flag.optional(Flag.String(name));

/** One endpoint as a command. The config is built from the table, so it is typed loosely here and read back by name. */
function endpointCommand(e: Endpoint) {
  const [group, op] = e.op.split(".") as [string, string];
  const name = kebab(op);
  const path = [group, name];
  const config: Record<string, Argument.Argument<unknown> | Flag.Flag<unknown>> = {};
  for (const p of e.pathParams) config[p.name] = param(p.name, p.number) as Argument.Argument<unknown>;
  for (const q of e.query) config[q.name] = queryFlag(q.name, q.number) as Flag.Flag<unknown>;
  if (e.body)
    config.json = Flag.String("json").pipe(Flag.optional, Flag.withDescription("请求体：JSON 文本，- 读标准输入，@文件 读文件")) as Flag.Flag<unknown>;
  return Command.make(name, config as never, (given: Record<string, unknown>) =>
    Effect.gen(function* () {
      const base = yield* ServerFlag;
      const body = e.body
        ? yield* checkedBody(
            e,
            Option.getOrElse(given.json as Option.Option<string>, () => ""),
            path,
          )
        : undefined;
      if (yield* DryRunFlag) {
        if (e.dryRun) return yield* printBody(yield* call(base, e.dryRun, given, body));
        if (e.method !== "GET")
          return yield* Effect.fail(
            new Failure({
              code: exit.usage,
              tag: "NoDryRun",
              text: `${e.op} 会改东西，但没有试跑：去掉 --dry-run 才会做`,
              next: [{ say: "看这条命令做什么", run: [...path, "--help"] }],
            }),
          );
      }
      yield* printBody(yield* request(base, e.method, urlOf(e, given), body));
    }),
  ).pipe(Command.withDescription(`${e.method} ${e.path}`));
}

/** /api/v1/state or /api/v1/events: each frame's data as it comes. */
const frames = (base: string, path: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const res = yield* send(base, HttpClientRequest.get(base + path).pipe(HttpClientRequest.accept("text/event-stream")));
      if (res.status !== 200) return yield* Effect.fail(failureOf(res.status, yield* res.text.pipe(Effect.mapError(unreachable(base)))));
      return res.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.map((e) => e.data),
        Stream.mapError((e) =>
          e._tag === "HttpClientError"
            ? unreachable(base)(e)
            : new Failure({ code: exit.other, tag: "Server", text: e._tag === "Retry" ? "服务端要流重连，命令行不接着连" : `流读不下去：${e.message}` }),
        ),
      );
    }),
  );

export const stateCommand = Command.make(
  "state",
  { watch: Flag.Boolean("watch").pipe(Flag.withDefault(false), Flag.withDescription("一直看：每一帧一行 JSON")) },
  ({ watch }) =>
    Effect.flatMap(ServerFlag, (base) =>
      // The server writes each frame on one line, so a stream is one line per frame whatever stdout is; one frame alone
      // is a document.
      watch ? Stream.runForEach(frames(base, statePath), out) : Stream.runForEach(Stream.take(frames(base, statePath), 1), printBody),
    ),
).pipe(Command.withDescription(`核心状态（GET ${statePath}）`));

export const eventsCommand = Command.make("events", {}, () => Effect.flatMap(ServerFlag, (base) => Stream.runForEach(frames(base, eventsPath), out))).pipe(
  Command.withDescription(`副作用，一行一条（GET ${eventsPath}）`),
);

/** Only what `issue run` reads of a frame; the rest is left as it came. */
const IssuesOfFrame = Schema.fromJsonString(
  Schema.Struct({ state: Schema.Struct({ issues: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, status: S.IssueStatus }))) }) }),
);
const settled = new Set<string>(["in_review", "done", "canceled"] satisfies (typeof IssueStatusValues)[number][]);

/** `issue run <id>`: a backlog issue to todo, then follows it in the core state while it waits for room or is worked, and
 * prints its changes. One already sent is only followed. It ends in review, done or canceled; each status it passes goes
 * to stderr. */
export const issueRunCommand = Command.make("run", { id: Argument.String("id") }, ({ id }) =>
  Effect.gen(function* () {
    const base = yield* ServerFlag;
    const issue = yield* call(base, "issue.get", { id }).pipe(Effect.flatMap(answer(S.Issue)));
    if (issue.status === "backlog") yield* call(base, "issue.status", { id: issue.id }, JSON.stringify({ status: "todo" }));
    yield* frames(base, statePath).pipe(
      Stream.mapEffect((data) =>
        Schema.decodeUnknownEffect(IssuesOfFrame)(data).pipe(Effect.mapError((e) => new Failure({ code: exit.other, tag: "Server", text: e.message }))),
      ),
      Stream.filter((frame) => frame.state.issues !== undefined),
      Stream.mapEffect((frame) => {
        const now = frame.state.issues!.find((i) => i.id === issue.id);
        return now
          ? Effect.succeed(now.status)
          : Effect.fail(new Failure({ code: exit.missing, tag: "Missing", text: `工单 #${issue.number} 不在了：被删掉了` }));
      }),
      Stream.changes,
      Stream.tap((status) => err(JSON.stringify({ issue: issue.number, status }))),
      Stream.takeUntil((status) => settled.has(status)),
      Stream.runDrain,
    );
    yield* printBody(yield* call(base, "issue.changes", { id: issue.id }));
  }),
).pipe(Command.withDescription("备选的挪到待办，等它交回来，打出改动；经过的每个状态写到 stderr"));

/** Every endpoint as `<group> <op>`, with the hand-written commands of a group (issue run, runtime chat) beside them. */
export function groupCommands(extra: Readonly<Record<string, readonly Command.Command.Any[]>>) {
  const groups = new Map<string, Command.Command.Any[]>();
  for (const e of endpoints) {
    const group = e.op.split(".")[0]!;
    groups.set(group, [...(groups.get(group) ?? []), endpointCommand(e) as Command.Command.Any]);
  }
  for (const [group, commands] of Object.entries(extra)) groups.set(group, [...(groups.get(group) ?? []), ...commands]);
  return [...groups].map(([group, commands]) =>
    Command.make(group).pipe(Command.withSubcommands(commands as never), Command.withDescription(`${group} 的接口`)),
  ) as Command.Command.Any[];
}
