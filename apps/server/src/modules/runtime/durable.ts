import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Api,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  createModels,
  type Model as PiModel,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
  type AgentChange,
  configure,
  type Conversation,
  type ConversationId,
  createRegistry,
  type EntryRecord,
  defineDoc,
  defineTool,
  Harness,
  InboxDoc,
  LiveDoc,
  MemoryStorage,
  type ModelRef,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { ToolFailed } from "@vibevalley/agent/core/errors";
import type { Tool } from "@vibevalley/agent/core/loop";
import { AssistantMessageSchema, type Message, ToolResultMessageSchema, UserMessageSchema } from "@vibevalley/ai/messages";
import type { Secret } from "@vibevalley/protocol/schema";

import { dbDir, type ServerConfig } from "#/infra/config.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import { noDeepSeekKey } from "#/modules/agent/agent.ts";

/** The farm's one durable harness: every conversation of an agent that runs in this server, kept in durable.db. */
export interface Durable {
  readonly harness: Harness;
  readonly registry: Registry;
  /** The conversation kept for key (a session's id), made with agent the first time it is asked for; agent is applied
   * again each time, so a changed extension or model is taken up. */
  readonly conversation: (key: string, agent: AgentChange) => Promise<Conversation>;
  /** The conversation kept for key, if one was ever made. */
  readonly existing: (key: string) => Promise<Conversation | undefined>;
  /** Whether key's conversation has a run, or input waiting for one, that the harness goes on with once it runs. */
  readonly busy: (key: string) => Promise<boolean>;
  /** The DeepSeek model a conversation asks for id: id itself, or the default model for an id empty or not in the
   * catalog. */
  readonly model: (id: string) => DeepSeekModel;
  /** Why nothing can be asked now (no DeepSeek key), in the user's words; undefined when a model can be asked. */
  readonly cannotAsk: () => string | undefined;
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
  const error: PiAssistantMessage = {
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

  const existing = async (key: string) => {
    const id = (await harness.snapshot(Kept, context))?.conversations[key];
    return id === undefined ? undefined : harness.conversation(id, context);
  };

  const conversation = async (key: string, agent: AgentChange) => {
    const id = await harness.commit(async (tx) => {
      const kept = await tx.doc(Kept);
      const had = kept.conversations[key];
      if (had !== undefined) {
        await configure(tx, had, agent);
        return had;
      }
      const made = await tx.createConversation({ ownership: { kind: "ownerless" } });
      kept.conversations[key] = made.id;
      await configure(tx, made.id, agent);
      return made.id;
    }, context);
    const found = await harness.conversation(id, context);
    if (!found) throw new Error(`the conversation of ${key} is not in durable.db`);
    return found;
  };

  const busy = async (key: string) => {
    const found = await existing(key);
    if (!found) return false;
    const live = await harness.snapshot(LiveDoc, found.id, context);
    const inbox = await harness.snapshot(InboxDoc, found.id, context);
    return live?.run !== undefined || (inbox?.items.some((item) => item.mode !== "write") ?? false);
  };

  const model = (id: string): DeepSeekModel => {
    const found = deepseekModels.find((m) => m.id === id) ?? deepseekModels.find((m) => m.id === defaultModel);
    if (found === undefined) throw new Error(`pi-ai's DeepSeek catalog has no ${defaultModel}`);
    return { ref: { provider: deepseekId, modelId: found.id }, contextWindow: found.contextWindow };
  };

  let closing: Promise<void> | undefined;
  // The runs under way stay as they are: the next open goes on with them.
  const close = () => (closing ??= harness.close(context));

  return { harness, registry, conversation, existing, busy, model, cannotAsk: deps.models.cannotAsk, close };
}

/** An entry's one model message, read as packages/ai's; undefined for an entry the model does not see. */
export function entryMessage(e: EntryRecord): Message | undefined {
  const m = e.model?.[0];
  if (m === undefined) return undefined;
  switch (m.role) {
    case "user":
      return UserMessageSchema.parse(m);
    case "assistant":
      return AssistantMessageSchema.parse(m);
    case "toolResult":
      return ToolResultMessageSchema.parse(m);
    case "system":
      return undefined;
  }
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
