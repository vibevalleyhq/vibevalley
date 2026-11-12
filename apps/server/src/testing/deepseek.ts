import {
  type Api,
  type ApiStreamOptions,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

import { abortable, isAbort, TaskGroup } from "@vibevalley/async";

import { messageOf } from "#/base/errors.ts";
import type { Time } from "#/infra/time.ts";
import { deepseekId, deepseekModels, type ModelAccess, type ModelMessage } from "#/modules/agent/durable.ts";
import { noDeepSeekKey } from "#/modules/agent/profile.ts";

import type { Request, ScriptedModel } from "./model.ts";

/** DeepSeek as a test farm's harness asks it: pi-ai's DeepSeek models, answered by the scripted model the test seats
 * (testing/model.ts's scriptedLLM), whichever conversation asks. With none seated it is a farm without a key. */
export interface ScriptedDeepSeek extends AsyncDisposable {
  readonly models: ModelAccess;
  /** From now on, every request of every conversation is answered by llm. */
  readonly use: (llm: ScriptedModel) => void;
  readonly close: () => Promise<void>;
}

export function scriptedDeepSeek(clock: Time): ScriptedDeepSeek {
  const tasks = new TaskGroup({ name: "scripted DeepSeek" });
  let seated: ScriptedModel | undefined;

  const answer = async (out: AssistantMessageEventStream, model: Model<Api>, transcript: TranscriptContext, options: SimpleStreamOptions) => {
    const asked = clock.now();
    const failed = (why: string, stopReason: "error" | "aborted"): AssistantMessage => ({
      role: "assistant",
      content: [],
      api: model.api,
      provider: deepseekId,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason,
      errorMessage: why,
      timestamp: asked,
    });
    const client = seated;
    if (client === undefined) {
      out.push({ type: "error", reason: "error", error: failed(noDeepSeekKey(), "error") });
      out.end();
      return;
    }
    try {
      const events = client.stream(requestOf(model, transcript, options), options.signal);
      // A stream that takes no notice of the stop is let go of, not waited for: the run ends aborted at once.
      const reading = events[Symbol.asyncIterator]();
      for (let next = await abortable(reading.next(), options.signal); next.done !== true; next = await abortable(reading.next(), options.signal)) {
        out.push(next.value);
        if (next.value.type === "done" || next.value.type === "error") {
          out.end();
          return;
        }
      }
      // A stream that ends without its last event says nothing more: the answer it gave is over, stopped or failed.
      if (options.signal?.aborted === true) out.push({ type: "error", reason: "aborted", error: failed(messageOf(options.signal.reason), "aborted") });
      else out.push({ type: "error", reason: "error", error: failed("the model's answer ended without its end", "error") });
    } catch (e) {
      if (isAbort(e, options.signal)) out.push({ type: "error", reason: "aborted", error: failed(messageOf(e), "aborted") });
      else out.push({ type: "error", reason: "error", error: failed(messageOf(e), "error") });
    }
    out.end();
  };

  const stream = (model: Model<Api>, transcript: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    tasks.run("a scripted answer", () => answer(out, model, transcript, options ?? {}));
    return out;
  };

  const provider: Provider = {
    id: deepseekId,
    name: "DeepSeek (scripted)",
    auth: { apiKey: { name: "scripted", resolve: async () => ({ auth: {} }) } },
    getModels: () => deepseekModels,
    // A request without the simple options: only how it stops and how long it may answer carry over.
    stream: <A extends Api>(model: Model<A>, transcript: TranscriptContext, options?: ApiStreamOptions<A>) =>
      stream(model, transcript, {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      }),
    streamSimple: stream,
  };

  const close = () => tasks.close();
  return {
    models: { provider, cannotAsk: () => (seated === undefined ? noDeepSeekKey() : undefined) },
    use: (llm) => {
      seated = llm;
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}

/** What pi-durable asks, as the script reads it: the replayed prompt and tools lead, the rest in order. A copy, so what
 * a test looks at later is what was asked. */
function requestOf(model: Model<Api>, transcript: TranscriptContext, options: SimpleStreamOptions): Request {
  const messages = structuredClone(transcript.messages.filter((m): m is ModelMessage => m.role !== "system"));
  return {
    system: getCurrentSystemPrompt(transcript.messages),
    tools: structuredClone(getCurrentTools(transcript.messages)),
    messages,
    model,
    options: { ...(options.reasoning ? { reasoning: options.reasoning } : {}), ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) },
  };
}
