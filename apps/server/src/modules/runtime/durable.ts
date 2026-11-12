import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Api,
  type ApiStreamOptions,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEvent as PiEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  createModels,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model as PiModel,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage as PiUsage,
} from "@earendil-works/pi-ai";
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
import { z } from "zod";

import { ToolFailed } from "@vibevalley/agent/core/errors";
import type { Tool } from "@vibevalley/agent/core/loop";
import type { ModelClient } from "@vibevalley/ai/client";
import { failedMessage, LlmError } from "@vibevalley/ai/llm";
import {
  type AssistantMessage,
  AssistantMessageSchema,
  type Context,
  type Message,
  ToolResultMessageSchema,
  type Usage,
  UserMessageSchema,
  zeroUsage,
} from "@vibevalley/ai/messages";
import type { AssistantMessageEvent } from "@vibevalley/ai/response";
import { abortable, isAbort, TaskGroup } from "@vibevalley/async";

import { messageOf } from "#/base/errors.ts";
import { dbDir, type ServerConfig } from "#/infra/config.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";

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
  /** The model a conversation of key asks: llm, asked again at each request, so a key or model saved meanwhile is used. */
  readonly model: (key: string, llm: () => ModelClient) => ModelRef;
  readonly close: () => Promise<void>;
}

export interface DurableDeps {
  /** The SQLite file the conversations are kept in; none keeps them in memory. */
  readonly file: string | undefined;
  readonly clock: Time;
  readonly log: Logger;
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

/** The one model id each bridged provider has: the conversation's model, whichever DeepSeek model its llm names. */
const modelId = "assistant";
/** Where a request blocks to fold the conversation: its own loop folded at 120k tokens, and each request pays for its
 * whole context. 16k above it is pi-durable's default reserve. */
const foldWindow = 136_000;

export async function openDurable(deps: DurableDeps): Promise<Durable> {
  const log = deps.log.child("durable");
  const tasks = new TaskGroup({ name: "durable", onError: (task, e) => log.error(`${task} failed`, e) });
  const storage = deps.file === undefined ? new MemoryStorage() : await openNodeSqliteStorage(deps.file);
  const models = createModels();
  const registry = createRegistry();
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      now: () => deps.clock.now(),
      identity: { attribution: null },
      // Nothing is selected unless a conversation asks for it: each host's extension is its own.
      // A failed answer is not asked again: the assistant's own loop never was, and a retry can say a thing twice.
      settings: { extensions: [], retry: { enabled: false } },
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

  const model = (key: string, llm: () => ModelClient): ModelRef => {
    const provider = `vibevalley.${key}`;
    models.setProvider(bridge(provider, llm, deps.clock, tasks));
    return { provider, modelId };
  };

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // The runs under way stay as they are: the next open goes on with them.
      await harness.close(context);
      await tasks.close();
    })());

  return { harness, registry, conversation, existing, busy, model, close };
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

/** A pi-ai provider whose one model is llm: today's DeepSeek wire (packages/ai) under pi-durable. */
function bridge(provider: string, llm: () => ModelClient, clock: Time, tasks: TaskGroup): Provider {
  const answer = async (out: AssistantMessageEventStream, model: PiModel<Api>, transcript: TranscriptContext, options: SimpleStreamOptions) => {
    const asked = clock.now();
    const failed = (why: string, stopReason: "error" | "aborted"): PiAssistantMessage => ({
      role: "assistant",
      content: [],
      api: model.api,
      provider,
      model: model.id,
      usage: piUsage(zeroUsage()),
      stopReason,
      errorMessage: why,
      timestamp: asked,
    });
    let client: ModelClient;
    try {
      client = llm();
    } catch (e) {
      out.push({ type: "error", reason: "error", error: failed(messageOf(e), "error") });
      out.end();
      return;
    }
    const reasoning = options.reasoning;
    try {
      const events = client.service.stream(
        client.model,
        requestOf(transcript),
        { apiKey: client.apiKey?.() ?? "", ...(reasoning ? { reasoning } : {}), ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) },
        options.signal,
      );
      // A stream that takes no notice of the stop is let go of, not waited for: the run ends aborted at once.
      const reading = events[Symbol.asyncIterator]();
      for (let next = await abortable(reading.next(), options.signal); next.done !== true; next = await abortable(reading.next(), options.signal)) {
        out.push(piEvent(next.value));
        if (next.value.type === "done" || next.value.type === "error") {
          out.end();
          return;
        }
      }
      // A stream that ends without its last event says nothing more: the answer it gave is over, stopped or failed.
      if (options.signal?.aborted === true) out.push({ type: "error", reason: "aborted", error: failed(messageOf(options.signal.reason), "aborted") });
      else out.push({ type: "error", reason: "error", error: failed("the model's answer ended without its end", "error") });
    } catch (e) {
      if (e instanceof LlmError) out.push({ type: "error", reason: "error", error: piMessage(failedMessage(client.model, asked, e)) });
      else if (isAbort(e, options.signal)) out.push({ type: "error", reason: "aborted", error: failed(messageOf(e), "aborted") });
      else out.push({ type: "error", reason: "error", error: failed(messageOf(e), "error") });
    }
    out.end();
  };

  const stream = (model: PiModel<Api>, transcript: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    tasks.run(`asking ${provider}`, () => answer(out, model, transcript, options ?? {}));
    return out;
  };

  const models = (): PiModel<Api>[] => {
    let client: ModelClient;
    try {
      client = llm();
    } catch {
      // No key yet: no model, and a run that asks for one ends no_model.
      return [];
    }
    const m = client.model;
    return [
      {
        id: modelId,
        name: m.name,
        api: "vibevalley",
        provider,
        baseUrl: m.baseUrl,
        reasoning: m.reasoning,
        input: [...m.input],
        cost: { ...m.cost },
        contextWindow: Math.min(m.contextWindow, foldWindow),
        maxTokens: m.maxTokens,
      },
    ];
  };

  return {
    id: provider,
    name: provider,
    auth: { apiKey: { name: "VibeValley", resolve: async () => ({ auth: {} }) } },
    getModels: models,
    // A request without the simple options: only how it stops and how long it may answer carry over.
    stream: <A extends Api>(model: PiModel<A>, transcript: TranscriptContext, options?: ApiStreamOptions<A>) =>
      stream(model, transcript, {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      }),
    streamSimple: stream,
  };
}

/** What pi-durable asks, as packages/ai's request: the replayed prompt and tools lead, the rest in order. */
function requestOf(transcript: TranscriptContext): Context {
  const messages: Message[] = [];
  for (const m of transcript.messages) {
    switch (m.role) {
      case "system":
        break;
      case "user":
        messages.push(UserMessageSchema.parse(m));
        break;
      case "assistant":
        messages.push(AssistantMessageSchema.parse(m));
        break;
      case "toolResult":
        messages.push(ToolResultMessageSchema.parse(m));
        break;
    }
  }
  const tools = getCurrentTools(transcript.messages).map((t) => ({ name: t.name, description: t.description, parameters: JsonObject.parse(t.parameters) }));
  return { system: getCurrentSystemPrompt(transcript.messages), tools, messages };
}

const JsonObject = z.record(z.string(), z.json());

const piUsage = (u: Usage): PiUsage => ({
  input: u.input,
  output: u.output,
  cacheRead: u.cacheRead,
  cacheWrite: u.cacheWrite,
  ...(u.reasoning === undefined ? {} : { reasoning: u.reasoning }),
  totalTokens: u.totalTokens,
  cost: { ...u.cost },
});

function piMessage(m: AssistantMessage): PiAssistantMessage {
  return {
    role: "assistant",
    content: m.content.map((c) => {
      switch (c.type) {
        case "text":
          return { type: "text", text: c.text };
        case "thinking":
          return { type: "thinking", thinking: c.thinking, ...(c.thinkingSignature === undefined ? {} : { thinkingSignature: c.thinkingSignature }) };
        case "toolCall":
          return {
            type: "toolCall",
            id: c.id,
            name: c.name,
            arguments: JsonObject.parse(c.arguments),
            ...(c.argumentsError === undefined ? {} : { argumentsError: c.argumentsError }),
          };
      }
    }),
    api: m.api,
    provider: m.provider,
    model: m.model,
    usage: piUsage(m.usage),
    stopReason: m.stopReason,
    timestamp: m.timestamp,
    ...(m.responseId === undefined ? {} : { responseId: m.responseId }),
    ...(m.responseModel === undefined ? {} : { responseModel: m.responseModel }),
    ...(m.rawStopReason === undefined ? {} : { rawStopReason: m.rawStopReason }),
    ...(m.errorMessage === undefined ? {} : { errorMessage: m.errorMessage }),
    ...(m.durationMs === undefined ? {} : { durationMs: m.durationMs }),
  };
}

function piEvent(e: AssistantMessageEvent): PiEvent {
  switch (e.type) {
    case "start":
      return { type: "start", partial: piMessage(e.partial) };
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return { type: e.type, contentIndex: e.contentIndex, partial: piMessage(e.partial) };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return { type: e.type, contentIndex: e.contentIndex, delta: e.delta, partial: piMessage(e.partial) };
    case "text_end":
    case "thinking_end":
      return { type: e.type, contentIndex: e.contentIndex, content: e.content, partial: piMessage(e.partial) };
    case "toolcall_end": {
      const partial = piMessage(e.partial);
      const call = partial.content[e.contentIndex];
      if (call?.type !== "toolCall") throw new Error(`toolcall_end at ${e.contentIndex} is not a tool call`);
      return { type: "toolcall_end", contentIndex: e.contentIndex, toolCall: call, partial };
    }
    case "done":
      return { type: "done", reason: e.reason, message: piMessage(e.message) };
    case "error":
      return { type: "error", reason: e.reason, error: piMessage(e.error) };
  }
}
