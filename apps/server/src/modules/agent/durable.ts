import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  createModels,
  getCurrentSystemMessage,
  getCurrentTools,
  type Message,
  type Model as PiModel,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
  type AgentChange,
  AgentDoc,
  configure,
  type Conversation,
  type ConversationId,
  createRegistry,
  type EntryRecord,
  defineDoc,
  defineExtension,
  defineTool,
  type Extension,
  Harness,
  InboxDoc,
  LiveDoc,
  MemoryStorage,
  type ModelRef,
  type Registry,
  section,
  type Tx,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { ToolFailed } from "@vibevalley/agent/core/errors";
import type { Tool } from "@vibevalley/agent/core/tool";
import type { Secret } from "@vibevalley/protocol/schema";

import { dbDir, type ServerConfig } from "#/infra/config.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";

import { noDeepSeekKey } from "./profile.ts";
import { durableWords } from "./prompts.ts";

/** The farm's one durable harness: every conversation of an agent that runs in this server, kept in durable.db. */
export interface Durable {
  readonly harness: Harness;
  readonly registry: Registry;
  /** The conversation kept for key (a session's id), made with agent the first time it is asked for; agent is applied
   * again each time, so a changed extension or model is taken up. init writes the host's own documents in the same
   * commit. */
  readonly conversation: (key: string, agent: AgentChange, init?: (tx: Tx, id: ConversationId) => Promise<void>) => Promise<Conversation>;
  /** The conversation kept for key, if one was ever made. */
  readonly existing: (key: string) => Promise<Conversation | undefined>;
  /** Whether key's conversation has a run, or input waiting for one, that the harness goes on with once it runs. */
  readonly busy: (key: string) => Promise<boolean>;
  /** The DeepSeek model a conversation asks for id: id itself, or the default model for an id empty or not in the
   * catalog. */
  readonly model: (id: string) => DeepSeekModel;
  /** Why nothing can be asked now (no DeepSeek key), in the user's words; undefined when a model can be asked. */
  readonly cannotAsk: () => string | undefined;
  /** The farm is stopping: a session of VibeValley's own runtime let go from now on leaves its run under way, for the
   * next open to go on with. */
  readonly leave: () => void;
  readonly leaving: () => boolean;
  readonly close: () => Promise<void>;
}

export interface DeepSeekModel {
  readonly ref: ModelRef;
  readonly contextWindow: number;
}

/** The provider every conversation of a harness asks, registered once as "deepseek" when it opens, and what it lacks to
 * be asked. */
export interface ModelAccess {
  readonly provider: Provider;
  readonly cannotAsk: () => string | undefined;
}

export interface DurableDeps {
  /** The SQLite file the conversations are kept in; none keeps them in memory. */
  readonly file: string | undefined;
  /** In the registry before anything runs: the extensions whose conversations the harness may go on with before their
   * host opens them again (a helper's). */
  readonly extensions?: readonly Extension[];
  readonly clock: Time;
  readonly log: Logger;
  readonly models: ModelAccess;
}

/** Where a farm keeps its conversations: durable.db in its home, or in memory with a database in memory. */
export const durableFile = (config: ServerConfig) => (dbDir(config) === "memory" ? undefined : join(config.home, "durable.db"));

const context = BACKGROUND_CONTEXT;

/** Which conversation is whose: kept in the same store as the conversations, so the two cannot disagree. */
const Kept = defineDoc<{ conversations: Record<string, ConversationId> }>({
  kind: "vibevalley.conversations",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: {} }),
  checkpointWhen: () => true,
});

export const deepseekId = "deepseek";
/** The model a profile that names none asks. */
export const defaultModel = "deepseek-flash";
/** pi-ai's DeepSeek models, the ones a conversation may ask. */
export const deepseekModels: readonly PiModel<Api>[] = deepseekProvider().getModels();
/** Where a request blocks to fold the conversation, whatever the model's window: the assistant's own loop folded at
 * 120k tokens, and each request pays for its whole context. Background folding starts pi-durable's 32k before it. */
const foldAt = 120_000;

/** DeepSeek as pi-ai asks it, with the key the farm has at each request: one saved meanwhile is used, and none is a
 * failed answer that says where to put one. fetch is the farm's. */
export function deepseekAccess(deps: { readonly key: () => Secret | undefined; readonly fetch: typeof fetch; readonly clock: Time }): ModelAccess {
  const upstream: Provider = deepseekProvider();
  const key = () => deps.key()?.reveal() || undefined;
  // The key is the one auth gave this request (pi-ai's Models puts it in the options).
  const ask = (model: PiModel<Api>, transcript: TranscriptContext, options: SimpleStreamOptions | undefined): AssistantMessageEventStream => {
    if (options?.apiKey === undefined) return failedAnswer(model, noDeepSeekKey(), deps.clock.now());
    return upstream.streamSimple(model, transcript, { ...options, fetch: deps.fetch });
  };
  const provider: Provider = {
    id: deepseekId,
    name: upstream.name,
    ...(upstream.baseUrl === undefined ? {} : { baseUrl: upstream.baseUrl }),
    // Read at each request. No key still resolves: the run is asked and fails saying where to put one, never ends
    // no_model or "not configured".
    auth: {
      apiKey: {
        name: "DeepSeek API key",
        resolve: async () => {
          const found = key();
          return { auth: found === undefined ? {} : { apiKey: found }, source: "VibeValley" };
        },
      },
    },
    getModels: () => upstream.getModels(),
    stream: (model, transcript, options) => {
      if (options?.apiKey === undefined) return failedAnswer(model, noDeepSeekKey(), deps.clock.now());
      return upstream.stream(model, transcript, Object.assign({}, options, { fetch: deps.fetch }));
    },
    streamSimple: ask,
  };
  return { provider, cannotAsk: () => (key() === undefined ? noDeepSeekKey() : undefined) };
}

/** An answer that failed before it was asked: why is what the run ends with. */
function failedAnswer(model: PiModel<Api>, why: string, at: number): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: why,
    timestamp: at,
  };
  out.push({ type: "error", reason: "error", error });
  out.end();
  return out;
}

export async function openDurable(deps: DurableDeps): Promise<Durable> {
  const log = deps.log.child("durable");
  const storage = deps.file === undefined ? new MemoryStorage() : await openNodeSqliteStorage(deps.file);
  const models = createModels();
  // Once, before any run: every conversation, whoever's, finds its model however the harness comes to run it.
  models.setProvider(deps.models.provider);
  const registry = createRegistry();
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      now: () => deps.clock.now(),
      identity: { attribution: null },
      settings: {
        // Nothing is selected unless a conversation asks for it: each host's extension is its own.
        extensions: [],
        // A failed answer is not asked again: the assistant's own loop never was, and a retry can say a thing twice.
        retry: { enabled: false },
        // The window is the model's (a request may answer as long as it allows); the fold comes at foldAt.
        compaction: {
          modelOverrides: Object.fromEntries(deepseekModels.map((m) => [`${deepseekId}/${m.id}`, { reserveTokens: Math.max(0, m.contextWindow - foldAt) }])),
        },
      },
      onReport: (report) => log.warn(`pi-durable: ${report.kind}`, report.error),
      // Files and commands of a conversation with a working directory (a helper's) are there; one without has none.
      env: ({ cwd }) => (cwd === undefined ? undefined : new NodeExecutionEnv({ cwd })),
    },
    context,
  );
  for (const extension of deps.extensions ?? []) registry.install(extension);

  const existing = async (key: string) => {
    const id = (await harness.snapshot(Kept, context))?.conversations[key];
    return id === undefined ? undefined : harness.conversation(id, context);
  };

  const conversation = async (key: string, agent: AgentChange, init?: (tx: Tx, id: ConversationId) => Promise<void>) => {
    const id = await harness.commit(async (tx) => {
      const kept = await tx.doc(Kept);
      const had = kept.conversations[key];
      const id = had ?? (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
      kept.conversations[key] = id;
      await configure(tx, id, agent);
      await init?.(tx, id);
      return id;
    }, context);
    const found = await harness.conversation(id, context);
    if (!found) throw new Error(`the conversation of ${key} is not in durable.db`);
    return found;
  };

  const pending = async (id: ConversationId) => {
    const live = await harness.snapshot(LiveDoc, id, context);
    const inbox = await harness.snapshot(InboxDoc, id, context);
    return live?.run !== undefined || (inbox?.items.some((item) => item.mode !== "write") ?? false);
  };
  const busy = async (key: string) => {
    const found = await existing(key);
    return found !== undefined && (await pending(found.id));
  };

  // Before anything runs: an extension a conversation left mid-run selects that no host has installed yet is stood in for
  // from its transcript, so its tools and prompt never vanish from the run that goes on.
  for (const id of Object.values((await harness.snapshot(Kept, context))?.conversations ?? {})) if (await pending(id)) await standIn(harness, registry, id);

  const model = (id: string): DeepSeekModel => {
    const found = deepseekModels.find((m) => m.id === id) ?? deepseekModels.find((m) => m.id === defaultModel);
    if (found === undefined) throw new Error(`pi-ai's DeepSeek catalog has no ${defaultModel}`);
    return { ref: { provider: deepseekId, modelId: found.id }, contextWindow: found.contextWindow };
  };

  let closing: Promise<void> | undefined;
  let left = false;
  // The runs under way stay as they are: the next open goes on with them.
  const close = () => {
    left = true;
    return (closing ??= harness.close(context));
  };

  return {
    harness,
    registry,
    conversation,
    existing,
    busy,
    model,
    cannotAsk: deps.models.cannotAsk,
    leave: () => void (left = true),
    leaving: () => left,
    close,
  };
}

/** The extensions conv selects that are not installed, each as it last showed itself to the model: the tools and
 * prompt sections in the transcript that no installed extension of conv's gives. A tool answers that it cannot run until
 * its host opens the conversation again; a section stays as it was shown. Its host's install replaces it (the same name). */
async function standIn(harness: Harness, registry: Registry, conv: ConversationId) {
  const names = (await harness.snapshot(AgentDoc, conv, context))?.extensions;
  if (!Array.isArray(names)) return;
  const installed = names.flatMap((n) => registry.snapshot().extension(n) ?? []);
  const missing = names.filter((n) => registry.snapshot().extension(n) === undefined);
  const found = missing.length === 0 ? undefined : await harness.conversation(conv, context);
  if (!found) return;
  const { messages } = await found.context(context);
  const given = new Set(installed.flatMap((e) => (e.tools ?? []).map((t) => t.name)));
  const shown = new Set(installed.flatMap((e) => (e.sections ?? []).map((s) => s.key)));
  const tools = getCurrentTools(messages).filter((t) => !given.has(t.name));
  // pi-durable's own section: the conversation's instructions, rendered whatever is installed.
  const keys = Object.keys(getCurrentSystemMessage(messages)?.sections ?? {}).filter((k) => !shown.has(k) && k !== "instructions");
  // Which missing extension gave what is not in the transcript: the first stands in for all of it.
  for (const [i, name] of missing.entries())
    registry.install(
      defineExtension({
        name,
        tools: (i === 0 ? tools : []).map((t) =>
          defineTool({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            execute: async () => ({ output: [{ type: "text", text: durableWords.notOpen(t.name) }], isError: true }),
          }),
        ),
        sections: (i === 0 ? keys : []).map((key) => section(key, (input) => input.shown[key], { tag: false })),
      }),
    );
}

/** A message the model sees, as an entry holds it: a user's, an answer, or a tool's result. */
export type ModelMessage = Exclude<Message, { readonly role: "system" }>;

/** An entry's one model message; undefined for an entry the model does not see. */
export function entryMessage(e: EntryRecord): ModelMessage | undefined {
  const m = e.model?.[0];
  return m === undefined || m.role === "system" ? undefined : m;
}

/** A message's words: its text parts, one after another. */
export function messageText(m: ModelMessage): string {
  if (typeof m.content === "string") return m.content;
  let out = "";
  for (const c of m.content) if (c.type === "text") out += c.text;
  return out;
}

/** One of our tools, as a conversation calls it: a ToolFailed it throws is the failed result the model reads. It may
 * change things, so a call a restart cuts off is not run again: the model reads that it was interrupted. */
export const durableTool = (tool: Tool): ToolRegistration =>
  defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (args, api, called) => {
      try {
        const r = await tool.execute(args, { id: api.callId }, called.abortSignal);
        return {
          output: r.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "image", data: c.data, mimeType: c.mimeType })),
          ...(r.isError === true ? { isError: true } : {}),
          ...(r.terminate === true ? { control: { terminate: true } } : {}),
        };
      } catch (e) {
        if (e instanceof ToolFailed) return { output: [{ type: "text", text: e.message }], isError: true };
        throw e;
      }
    },
  });
