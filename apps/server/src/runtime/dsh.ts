// The DeepSeek Harness runtime: `dsh --profile acp` (DeepSeek Harness's automation ACP
// server, dsh 0.2.1-rc.2, ACP v1) driven through oar's own ACP layer. npm oar has no dsh, and its ACP layer is not in
// its exports: it is loaded from oar's dist by path, which holds only while oar is pinned to the version it was read
// from (0.68.2, package.json).
//
// What the server offers, probed 2026-10-17: initialize with no auth methods, session/new, session/resume, session/list
// and session/close, one prompt at a time, session/cancel, and session/set_config_option with a `model` select grouped
// by provider and a `reasoning_effort` select in the thought_level category (off, low, high, max).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  defineRuntime,
  type InstallationProbe,
  type ListModelsResult,
  type ModelEntry,
  type RefusedSessionOptions,
  type SessionOptions,
  type StartSession,
} from "@botiverse/oar";
import { Predicate } from "effect";

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
const records = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(Predicate.isObject) : []);

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

/** A throwaway session in the listing's cwd, for its model option: initialize, session/new, session/close. */
async function readNewSession(command: string, cwd: string, timeoutMs: number): Promise<Rec> {
  const child = spawn(command, ["--profile", "acp"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  let next = 0;
  const waiting = new Map<number, { resolve: (v: Rec) => void; reject: (e: Error) => void }>();
  lines.on("line", (line) => {
    try {
      const m = JSON.parse(line) as { id?: number; result?: Rec; error?: { code?: number; message?: string } };
      const w = m.id !== undefined ? waiting.get(m.id) : undefined;
      if (!w) return;
      waiting.delete(m.id!);
      if (m.error) w.reject(Object.assign(new Error(m.error.message ?? "ACP error"), { code: m.error.code }));
      else w.resolve(m.result ?? {});
    } catch {
      // Not JSON-RPC: logs.
    }
  });
  const request = (method: string, params: Rec) =>
    new Promise<Rec>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      waiting.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const response = await request("session/new", { cwd, mcpServers: [] });
    // Best effort: the list is in hand, and the process is killed next.
    if (typeof response.sessionId === "string") await request("session/close", { sessionId: response.sessionId }).catch(() => undefined);
    return response;
  } finally {
    child.kill();
  }
}

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
      response = await readNewSession(installation.command as string, listingCwd(options ?? {}), options?.timeoutMs ?? 30_000);
    } catch (e) {
      if ((e as { code?: number }).code === -32601) return { kind: "unsupported", reason: "this dsh build has no session/new method" };
      throw e;
    }
    const models = projectModels(response);
    return models ? { kind: "ok", models } : { kind: "unsupported", reason: "this dsh build returns no model config option on session/new" };
  },
});
