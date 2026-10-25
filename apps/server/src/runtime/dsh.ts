// The DeepSeek Harness runtime: `dsh --profile acp` (DeepSeek Harness's automation ACP
// server, dsh 0.2.1-rc.2, ACP v1) driven through oar's own ACP layer. npm oar has no dsh, and its ACP layer is not in
// its exports: it is loaded from oar's dist by path, which holds only while oar is pinned to the version it was read
// from (0.68.2, package.json).
//
// What the server offers, probed 2026-10-17: initialize with no auth methods, session/new, session/resume, session/list
// and session/close, one prompt at a time, session/cancel, and session/set_config_option with a `model` select grouped
// by provider and a `reasoning_effort` select in the thought_level category (off, low, high, max).

import { NodeServices } from "@effect/platform-node";
import { Cause, Deferred, Effect, Exit, Queue, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  defineRuntime,
  type InstallationProbe,
  type ListModelsResult,
  type ModelEntry,
  type RefusedSessionOptions,
  type SessionOptions,
  type StartSession,
} from "@botiverse/oar";

const dist = new URL(".", import.meta.resolve("@botiverse/oar"));
const internal = <T>(path: string) => import(new URL(path, dist).href) as Promise<T>;

const { acpSession } = await internal<{ acpSession: (profile: Record<string, unknown>) => StartSession }>("shared/acp/session.js");
const { executableInstallation } = await internal<{
  executableInstallation: (
    env: string,
    command: string,
    fallbacks?: readonly string[],
    readiness?: readonly string[],
    options?: { versionTimeoutMs?: number },
  ) => InstallationProbe;
}>("shared/installation.js");
const { refuseSessionOptions } = await internal<{ refuseSessionOptions: (refused: RefusedSessionOptions, options: SessionOptions) => void }>(
  "shared/session-options.js",
);
const { effortLevelOf } = await internal<{ effortLevelOf: (value: unknown) => string | undefined }>("shared/effort-levels.js");
const { listingCwd } = await internal<{ listingCwd: (options: { cwd?: string }) => string }>("shared/listing-cwd.js");

/** What dsh-acp has no channel for: its automation surface omits session prompts, tool denylists, names, tiers, extra
 * directories and output schemas. */
export const refusedSessionOptions: RefusedSessionOptions = {
  systemPrompt: "dsh-acp has no per-session system prompt input",
  appendSystemPrompt: "dsh-acp has no per-session system prompt append input",
  disallowedTools: "dsh-acp has no session tool denylist",
  name: "dsh-acp has no session name setting",
  serviceTier: "dsh-acp has no service tier setting",
  additionalDirectories: "dsh-acp does not support additional directories",
  outputSchema: "dsh-acp has no final-output schema channel",
};

/** The provider dsh's catalog names DeepSeek's own API by. */
const deepseek = "deepseek-official";

const isDeepseek = (provider: string) => provider === deepseek || provider === "deepseek-account";

/** The `model` option's value for a model: dsh values it by the JSON pair ["provider","model"]. "deepseek-flash" is
 * DeepSeek's; "provider/model" is that provider's; an empty model or a pair is left as it is. The retired name
 * "deepseek-v4-flash" is the same model as "deepseek-flash" (DeepSeek serves and bills it as flash). */
export function optionValue(given: string): string {
  const model = given.trim();
  if (model === "" || model.startsWith("[")) return model;
  const slash = model.indexOf("/");
  const provider = slash < 0 ? deepseek : model.slice(0, slash);
  let id = slash < 0 ? model : model.slice(slash + 1);
  if (isDeepseek(provider) && id === "deepseek-v4-flash") id = "deepseek-flash";
  return JSON.stringify([provider, id]);
}

/** How a model is written outside dsh, provider/model, from its option value; a value that is no pair is itself. */
export function modelId(value: string): string {
  try {
    const pair = JSON.parse(value) as unknown;
    if (Array.isArray(pair) && pair.length === 2 && pair.every((x) => typeof x === "string")) return pair[0] + "/" + pair[1];
  } catch {
    // Not a pair.
  }
  return value;
}

/** A model id with the retired name folded into today's. */
export function canonicalModelId(id: string): string {
  const slash = id.indexOf("/");
  if (slash < 0 || slash === id.length - 1) return id;
  const provider = id.slice(0, slash);
  return isDeepseek(provider) && id.slice(slash + 1) === "deepseek-v4-flash" ? provider + "/deepseek-flash" : id;
}

const modelName = (value: string) => {
  const id = modelId(value);
  const slash = id.indexOf("/");
  return slash < 0 ? "" : id.slice(slash + 1);
};

/** The choice's name, with the release dsh's own selector badges it with: DeepSeek's deepseek-flash is
 * DeepSeek-V4.1-Flash-1017, the API's only Flash model name. */
function displayName(id: string, choice: Record<string, unknown>): string {
  const name = typeof choice.name === "string" ? choice.name : "";
  const slash = id.indexOf("/");
  return slash >= 0 && isDeepseek(id.slice(0, slash)) && id.slice(slash + 1) === "deepseek-flash" && name === "DeepSeek-V4.1-Flash" ? name + "-1017" : name;
}

type Rec = Record<string, unknown>;
const records = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x)) : []);

/** A session/new response's models; undefined when it has no `model` config option. dsh has no model-list method: the
 * catalog rides on every new session as the `model` option, its choices grouped by provider or flat. The effort menu
 * is the thought_level option, the same for every model; `off` is a toggle, not a level, and is dropped. */
export function projectModels(response: unknown): ModelEntry[] | undefined {
  const options = records((response as Rec | undefined)?.configOptions);
  const model = options.find((o) => o.id === "model");
  if (!model) return undefined;
  const thinking = options.find((o) => o.category === "thought_level");
  const levels = records(thinking?.options)
    .map((o) => effortLevelOf(o.value))
    .filter((l): l is string => l !== undefined && l !== "off");
  const current = effortLevelOf(thinking?.currentValue);
  const defaultEffort = current && current !== "off" ? current : "";
  const currentId = canonicalModelId(modelId(typeof model.currentValue === "string" ? model.currentValue : ""));
  const entries: ModelEntry[] = [];
  const index = new Map<string, number>();
  const add = (choice: Rec) => {
    const value = typeof choice.value === "string" ? choice.value : "";
    if (!value) return;
    const id = canonicalModelId(modelId(value));
    const entry: ModelEntry = {
      id,
      displayName: displayName(id, choice),
      ...(levels.length > 0 ? { effortLevels: levels } : {}),
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(id === currentId ? { default: true as const } : {}),
    };
    const at = index.get(id);
    if (at !== undefined) {
      // The retired name and today's are the same model: show today's.
      if (modelName(value) === "deepseek-flash") entries[at] = entry;
      return;
    }
    index.set(id, entries.length);
    entries.push(entry);
  };
  for (const choice of records(model.options)) {
    const group = records(choice.options);
    if (Array.isArray(choice.options)) for (const inner of group) add(inner);
    else add(choice);
  }
  return entries;
}

/** A JSON-RPC error from the process, with its code (-32601: no such method). */
class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
  }
}

/**
 * A throwaway session in the listing's cwd, for its model option: initialize, session/new, session/close. The process lives
 * in this effect's scope: closing it kills the process (and its group).
 */
const readNewSession = (command: string, cwd: string, timeoutMs: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const outgoing = yield* Queue.unbounded<Uint8Array>();
      const handle = yield* spawner.spawn(ChildProcess.make(command, ["--profile", "acp"], { cwd, stdin: Stream.fromQueue(outgoing), stderr: "ignore" }));
      const waiting = new Map<number, Deferred.Deferred<Rec, Error>>();
      // Lines that are not JSON-RPC answers are its logs.
      yield* handle.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.suspend(() => {
            let m: { id?: number; result?: Rec; error?: { code?: number; message?: string } };
            try {
              m = JSON.parse(line) as typeof m;
            } catch {
              return Effect.void;
            }
            const w = m.id !== undefined ? waiting.get(m.id) : undefined;
            if (!w) return Effect.void;
            waiting.delete(m.id!);
            return m.error ? Deferred.fail(w, new RpcError(m.error.message ?? "ACP error", m.error.code)) : Deferred.succeed(w, m.result ?? {});
          }),
        ),
        Effect.forkScoped,
      );
      let next = 0;
      const encoder = new TextEncoder();
      const request = (method: string, params: Rec) =>
        Effect.gen(function* () {
          const id = ++next;
          const answer = yield* Deferred.make<Rec, Error>();
          waiting.set(id, answer);
          yield* Queue.offer(outgoing, encoder.encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
          return yield* Deferred.await(answer).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new Error(`${method} timed out`)) }));
        });
      yield* request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      const response = yield* request("session/new", { cwd, mcpServers: [] });
      // Best effort: the list is in hand, and the process is killed next.
      if (typeof response.sessionId === "string") yield* Effect.ignore(request("session/close", { sessionId: response.sessionId }));
      return response;
    }),
  );

/** readNewSession for oar's Promise interface: its failure as it was raised (an RpcError keeps its code). */
const readNewSessionPromise = async (command: string, cwd: string, timeoutMs: number): Promise<Rec> => {
  const exit = await Effect.runPromiseExit(readNewSession(command, cwd, timeoutMs).pipe(Effect.provide(NodeServices.layer)));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

const startSession = acpSession({
  args: ["--profile", "acp"],
  // Its subagents are its own: none of them reaches this transport.
  capabilities: { queue: { durable: false }, attribution: "opaque" },
  requestTimeoutMs: 30_000,
  // The model is the `model` config option, valued by its opaque provider/model pair.
  modelViaConfigOption: true,
  validateOptions: (options: SessionOptions) => refuseSessionOptions(refusedSessionOptions, options),
  // session/resume of an unknown id is refused without a code of its own; session/list tells.
  isResumeNotFound: (_native: unknown, listed: boolean | null) => listed === false,
});

export const dshRuntime = defineRuntime({
  id: "dsh",
  brand: { name: "DeepSeek Harness" } as never,
  // OAR_DSH_BIN pins one; its version is `dsh --version`, which loads the CLI, slowly.
  installation: executableInstallation("OAR_DSH_BIN", "dsh", undefined, undefined, { versionTimeoutMs: 30_000 }),
  refusedSessionOptions,
  // The model may be written provider/model, or as the bare model of DeepSeek's own provider.
  session: (installation, options) => startSession(installation, { ...options, ...(options.model !== undefined ? { model: optionValue(options.model) } : {}) }),
  listModels: async (installation, options): Promise<ListModelsResult> => {
    if (installation.via !== "executable" || !("command" in installation))
      return { kind: "unsupported", reason: "dsh model listing requires the dsh executable" };
    let response: Rec;
    try {
      response = await readNewSessionPromise(installation.command as string, listingCwd(options ?? {}), options?.timeoutMs ?? 30_000);
    } catch (e) {
      if ((e as { code?: number }).code === -32601) return { kind: "unsupported", reason: "this dsh build has no session/new method" };
      throw e;
    }
    const models = projectModels(response);
    return models ? { kind: "ok", models } : { kind: "unsupported", reason: "this dsh build returns no model config option on session/new" };
  },
});
