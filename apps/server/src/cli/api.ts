// The endpoints as commands: one per entry in the endpoint table (packages/protocol/src/api.ts), `<group> <op>`, path
// parameters as arguments, query parameters as flags, the body as --json, checked against the endpoint's Schema before it
// is sent. Nothing here knows an endpoint by name; a new endpoint is a new command with its help.

import { readFile } from "node:fs/promises";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { eventsPath, type Issue, statePath } from "@vibevalley/protocol";
import { type Endpoint, endpoints } from "@vibevalley/protocol/api";
import { document, exit, Failure, type Io, printBody } from "./output.ts";

const defaultServer = "http://127.0.0.1:8787";

/** --server, else VIBEVALLEY_SERVER, else the one on this machine. */
export const ServerFlag = GlobalFlag.Setting("server")({
  flag: Flag.String("server").pipe(Flag.optional, Flag.withDescription(`服务端的地址；不填用 VIBEVALLEY_SERVER，再没有是 ${defaultServer}`)),
});

/** --dry-run: a command that changes what cannot be taken back answers what it would do (its endpoint's dryRun) and changes
 * nothing; one that only reads runs as it is; any other is refused rather than done. */
export const DryRunFlag = GlobalFlag.Setting("dry-run")({
  flag: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("只说会做什么，不动手（会删、会合、会关、会让帮工走的命令）")),
});

const serverOf = (io: Io) => Effect.map(ServerFlag, (given) => Option.getOrUndefined(given) || io.env.VIBEVALLEY_SERVER || defaultServer);

const unreachable = (base: string, why: string) =>
  new Failure({
    code: exit.unreachable,
    tag: "Unreachable",
    text: `连不上 ${base}：${why}`,
    next: [{ say: "先起服务端（apps/server 下 npm start），或用 --server 指到在跑的那个" }],
  });

/** An answer that is not 2xx, as a failure: the server's ApiError when it sent one. */
function failureOf(status: number, text: string): Failure {
  let tag = "Server";
  let words = text.trim();
  let next: Failure["next"];
  try {
    const j = JSON.parse(text) as { _tag?: string; reason?: string; what?: string; next?: Failure["next"] };
    tag = j._tag ?? tag;
    words = j.reason ?? j.what ?? words;
    next = j.next;
  } catch {
    // Not the server's ApiError (a 400 from decoding, a 404 for no such route): the words as they came.
  }
  const code =
    tag === "Refused"
      ? exit.refused
      : tag === "Missing" || status === 404
        ? exit.missing
        : status === 503
          ? exit.unreachable
          : status === 400
            ? exit.usage
            : exit.other;
  return new Failure({ code, tag, text: words, status, ...(next ? { next } : {}) });
}

export const request = (base: string, method: string, path: string, body?: string) =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(base + path, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, ...(body !== undefined ? { body } : {}) }),
      catch: (e) => unreachable(base, e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)),
    });
    const text = yield* Effect.promise(() => res.text());
    if (!res.ok) return yield* Effect.fail(failureOf(res.status, text));
    return text;
  });

/** How a command writes an op: editNode is edit-node. */
export const kebab = (op: string) => op.replace(/[A-Z]/g, (c, i: number) => (i > 0 ? "-" : "") + c.toLowerCase());

const usage = (path: readonly string[], text: string, tag = "InvalidValue") =>
  new Failure({ code: exit.usage, tag, text, next: [{ say: "看这条命令怎么写", run: [...path, "--help"] }] });

/** --json's text: as given, `-` for stdin, `@file` for a file's. */
const bodyText = (io: Io, given: string, path: readonly string[]) =>
  given === "-"
    ? Effect.promise(() => io.stdin())
    : given.startsWith("@")
      ? Effect.tryPromise({ try: () => readFile(given.slice(1), "utf8"), catch: (e) => usage(path, `读不了 ${given.slice(1)}：${String(e)}`) })
      : Effect.succeed(given);

/** The body checked against the endpoint's Schema here, so a wrong field is named before anything is sent. */
const checkedBody = (e: Endpoint, io: Io, given: string, path: readonly string[]) =>
  Effect.gen(function* () {
    const text = given === "" ? "{}" : yield* bodyText(io, given, path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return yield* Effect.fail(usage(path, `--json 不是 JSON：${err instanceof Error ? err.message : String(err)}`, "InvalidJson"));
    }
    yield* Schema.decodeUnknownEffect(e.body!)(parsed).pipe(Effect.mapError((issue) => usage(path, `--json 不合 ${e.op} 的请求体：${issue.message}`)));
    return text;
  });

const param = (name: string, number: boolean) => (number ? Argument.Int(name) : Argument.String(name));
const queryFlag = (name: string, number: boolean): Flag.Flag<Option.Option<unknown>> =>
  number ? Flag.optional(Flag.Int(name)) : Flag.optional(Flag.String(name));

/** One endpoint as a command. The config is built from the table, so it is typed loosely here and read back by name. */
function endpointCommand(e: Endpoint, io: Io) {
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
      const base = yield* serverOf(io);
      const url = e.path.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(given[k])));
      const q = new URLSearchParams();
      for (const p of e.query) {
        const v = given[p.name] as Option.Option<unknown>;
        if (Option.isSome(v)) q.set(p.name, String(v.value));
      }
      const json = e.body ? Option.getOrElse(given.json as Option.Option<string>, () => "") : undefined;
      const body = e.body ? yield* checkedBody(e, io, json!, path) : undefined;
      const query = q.size > 0 ? "?" + q.toString() : "";
      if (yield* DryRunFlag) {
        const preview = e.dryRun ? endpoints.find((x) => x.op === e.dryRun) : undefined;
        if (preview)
          return printBody(
            io,
            yield* request(base, preview.method, preview.path.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(given[k]))) + query, body),
          );
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
      printBody(io, yield* request(base, e.method, url + query, body));
    }),
  ).pipe(Command.withDescription(`${e.method} ${e.path}`));
}

/** /api/v1/state or /api/v1/events: the first frame, or each one as it comes, one JSON line apiece. */
const stream = (io: Io, path: string, watch: boolean) =>
  Effect.gen(function* () {
    const base = yield* serverOf(io);
    const res = yield* Effect.tryPromise({
      try: () => fetch(base + path, { headers: { accept: "text/event-stream" } }),
      catch: (e) => unreachable(base, e instanceof Error ? e.message : String(e)),
    });
    if (!res.ok || !res.body) return yield* Effect.fail(failureOf(res.status, yield* Effect.promise(() => res.text())));
    yield* Effect.promise(async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          // A stream is one line per frame whatever stdout is, so it can be read line by line; one frame alone is a document.
          if (watch) io.out(JSON.stringify(JSON.parse(data)));
          else printBody(io, data);
          if (!watch) return;
        }
      }
    });
  });

export const stateCommand = (io: Io) =>
  Command.make("state", { watch: Flag.Boolean("watch").pipe(Flag.withDefault(false), Flag.withDescription("一直看：每一帧一行 JSON")) }, ({ watch }) =>
    stream(io, statePath, watch),
  ).pipe(Command.withDescription(`核心状态（GET ${statePath}）`));

export const eventsCommand = (io: Io) =>
  Command.make("events", {}, () => stream(io, eventsPath, true)).pipe(Command.withDescription(`副作用，一行一条（GET ${eventsPath}）`));

/** `issue run <id>`: a backlog issue to todo, then waits while it waits for room or is worked and prints its changes.
 * One already sent is only waited for. It ends in review, done or canceled; each status it passes goes to stderr. */
export const issueRunCommand = (io: Io, pollMs = 2_000) =>
  Command.make("run", { id: Argument.String("id") }, ({ id }) =>
    Effect.gen(function* () {
      const base = yield* serverOf(io);
      const at = encodeURIComponent(id);
      const get = Effect.map(request(base, "GET", `/api/v1/issues/${at}`), (t) => JSON.parse(t) as Issue);
      if ((yield* get).status === "backlog") yield* request(base, "PUT", `/api/v1/issues/${at}/status`, JSON.stringify({ status: "todo" }));
      let last = "";
      for (;;) {
        const issue = yield* get;
        if (issue.status !== last) {
          io.err(document({ issue: issue.number, status: issue.status }, false));
          last = issue.status;
        }
        if (issue.status === "in_review" || issue.status === "done" || issue.status === "canceled")
          return printBody(io, yield* request(base, "GET", `/api/v1/issues/${at}/changes`));
        yield* Effect.sleep(pollMs);
      }
    }),
  ).pipe(Command.withDescription("备选的挪到待办，等它交回来，打出改动；经过的每个状态写到 stderr"));

/** Every endpoint as `<group> <op>`, with the hand-written commands of a group (issue run, runtime chat) beside them. */
export function groupCommands(io: Io, extra: Readonly<Record<string, readonly Command.Command.Any[]>>) {
  const groups = new Map<string, Command.Command.Any[]>();
  for (const e of endpoints) {
    const group = e.op.split(".")[0]!;
    groups.set(group, [...(groups.get(group) ?? []), endpointCommand(e, io) as Command.Command.Any]);
  }
  for (const [group, commands] of Object.entries(extra)) groups.set(group, [...(groups.get(group) ?? []), ...commands]);
  return [...groups].map(([group, commands]) =>
    Command.make(group).pipe(Command.withSubcommands(commands as never), Command.withDescription(`${group} 的接口`)),
  ) as Command.Command.Any[];
}
