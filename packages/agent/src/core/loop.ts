import { Cause, Clock, Deferred, Effect, FiberSet, Option, Predicate, Ref, type Scope, Stream } from "effect";

import { failedMessage, type LlmError, type Llm } from "@vibevalley/ai/llm";
import type { AssistantMessage, Context, ImageContent, Message, TextContent, ToolCall, ToolResultMessage } from "@vibevalley/ai/messages";
import { zeroUsage } from "@vibevalley/ai/messages";
import type { Model, ThinkingLevel } from "@vibevalley/ai/models";
import type { AssistantMessageEvent } from "@vibevalley/ai/response";
import { type JsonSchema, toolArguments } from "@vibevalley/ai/tools";

import { AgentBusy, CannotContinue, messageOf, type ToolFailed } from "./errors.ts";

type Told = { readonly _tag: "event"; readonly event: AssistantMessageEvent } | { readonly _tag: "failed"; readonly failure: LlmError };
interface Answered {
  readonly partial?: AssistantMessage;
  readonly end?: { readonly _tag: "ended"; readonly message: AssistantMessage } | { readonly _tag: "failed"; readonly failure: LlmError };
}

export interface ToolResult {
  readonly content: readonly (TextContent | ImageContent)[];
  readonly isError?: boolean;
  /** Ends the run after the turn when every tool call in the batch sets `terminate: true`. */
  readonly terminate?: boolean;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly execute: (args: unknown, call: { readonly id: string }) => Effect.Effect<ToolResult, ToolFailed>;
}

export type AgentMessage<A> = Message | A;

export type AgentEvent<A> =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end"; readonly messages: readonly AgentMessage<A>[] }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end"; readonly message: AssistantMessage; readonly toolResults: readonly ToolResultMessage[] }
  | { readonly type: "message_start" | "message_end"; readonly message: AgentMessage<A> }
  | { readonly type: "message_update"; readonly message: AssistantMessage; readonly assistantMessageEvent: AssistantMessageEvent }
  | { readonly type: "tool_execution_start"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: ToolResult;
      readonly isError: boolean;
      readonly durationMs?: number;
    };

export interface Turn<A> {
  readonly message: AssistantMessage;
  readonly toolResults: readonly ToolResultMessage[];
  readonly messages: readonly AgentMessage<A>[];
  readonly stopped: boolean;
}

export interface AgentOptions<A> {
  readonly llm: Llm["Service"];
  readonly model: Model;
  readonly thinkingLevel?: ThinkingLevel;
  readonly tools: readonly Tool[];
  readonly messages: readonly AgentMessage<A>[];
  /** Asked before each request, so a key changed meanwhile is used at once. */
  readonly apiKey: () => string;
  readonly toLlm: (messages: readonly AgentMessage<A>[]) => Context;
  readonly prepareRequest?: (messages: readonly AgentMessage<A>[], stopped: boolean) => Effect.Effect<readonly AgentMessage<A>[] | undefined>;
  /** `"end"` stops the run; `"continue"` forces another turn even with no tool calls. */
  readonly finishTurn?: (turn: Turn<A>) => Effect.Effect<"end" | "continue" | undefined>;
  readonly onEvent: (event: AgentEvent<A>) => Effect.Effect<void>;
  readonly stoppedText: string;
}

export interface Agent<A> {
  /** Starts a run with these messages; the agent must be idle. */
  readonly prompt: (messages: readonly AgentMessage<A>[]) => Effect.Effect<void, AgentBusy>;
  readonly continue: Effect.Effect<void, AgentBusy | CannotContinue>;
  readonly steer: (message: AgentMessage<A>) => Effect.Effect<void>;
  /** Taken when the run would stop, one at a time. */
  readonly followUp: (message: AgentMessage<A>) => Effect.Effect<void>;
  readonly clearQueues: Effect.Effect<void>;
  readonly hasQueued: Effect.Effect<boolean>;
  readonly abort: Effect.Effect<void>;
  readonly idle: Effect.Effect<void>;
  readonly running: Effect.Effect<boolean>;
  readonly messages: Ref.Ref<readonly AgentMessage<A>[]>;
}

const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const truncated = (name: string) =>
  `Tool call "${name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`;
const operationAborted = "Operation aborted";

interface Run {
  readonly stop: Deferred.Deferred<void>;
  readonly done: Deferred.Deferred<void>;
}

export const make = <A>(options: AgentOptions<A>): Effect.Effect<Agent<A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fibers = yield* FiberSet.make();
    const messages = yield* Ref.make<readonly AgentMessage<A>[]>(options.messages);
    const steering = yield* Ref.make<readonly AgentMessage<A>[]>([]);
    const followUps = yield* Ref.make<readonly AgentMessage<A>[]>([]);
    const active = yield* Ref.make(Option.none<Run>());
    const reasoning = options.thinkingLevel && options.thinkingLevel !== "off" ? options.thinkingLevel : undefined;

    const takeOne = (q: Ref.Ref<readonly AgentMessage<A>[]>) => Ref.modify(q, (all) => [all.slice(0, 1), all.slice(1)] as const);
    const takeAll = (q: Ref.Ref<readonly AgentMessage<A>[]>) => Ref.getAndSet(q, []);

    const emit = (event: AgentEvent<A>) =>
      Effect.gen(function* () {
        if (event.type === "message_end") yield* Ref.update(messages, (all) => [...all, event.message]);
        yield* options.onEvent(event);
      });

    const answer = (asked: readonly AgentMessage<A>[], stop: Deferred.Deferred<void>) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const thinkingLevel = reasoning ?? "off";
        const finished = (m: AssistantMessage) =>
          Effect.map(Clock.currentTimeMillis, (now): AssistantMessage => ({ ...m, thinkingLevel, durationMs: now - started }));
        // Convert stream failure into a terminal item so `runFoldEffect` retains partial output accumulated before the error.
        const told = options.llm.stream(options.model, options.toLlm(asked), { apiKey: options.apiKey(), ...(reasoning ? { reasoning } : {}) }).pipe(
          Stream.interruptWhen(Deferred.await(stop)),
          Stream.map((event): Told => ({ _tag: "event", event })),
          Stream.catchTag("LlmError", (failure) => Stream.succeed<Told>({ _tag: "failed", failure })),
        );
        const got = yield* Stream.runFoldEffect(
          told,
          (): Answered => ({}),
          (so, item): Effect.Effect<Answered> =>
            Effect.gen(function* () {
              if (item._tag === "failed") return so.end === undefined ? { ...so, end: { _tag: "failed", failure: item.failure } } : so;
              const e = item.event;
              switch (e.type) {
                case "start":
                  yield* options.onEvent({ type: "message_start", message: e.partial });
                  return { ...so, partial: e.partial };
                case "done":
                  return { ...so, end: { _tag: "ended", message: yield* finished(e.message) } };
                case "error":
                  return { ...so, end: { _tag: "ended", message: yield* finished(e.error) } };
                default:
                  yield* options.onEvent({ type: "message_update", assistantMessageEvent: e, message: e.partial });
                  return { ...so, partial: e.partial };
              }
            }),
        );
        const partial = got.partial;
        const base = partial ?? {
          role: "assistant" as const,
          content: [],
          api: options.model.api,
          provider: options.model.provider,
          model: options.model.id,
          usage: zeroUsage(),
          stopReason: "error" as const,
          timestamp: started,
        };
        const ended =
          got.end?._tag === "ended"
            ? got.end.message
            : yield* finished(
                got.end?._tag === "failed"
                  ? failedMessage(options.model, started, got.end.failure)
                  : { ...base, stopReason: "aborted", errorMessage: "Request was aborted" },
              );
        if (partial === undefined) yield* options.onEvent({ type: "message_start", message: ended });
        yield* emit({ type: "message_end", message: ended });
        return ended;
      });

    const toolResultMessage = Effect.fnUntraced(function* (call: ToolCall, result: ToolResult, isError: boolean, durationMs?: number) {
      const message: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError,
        ...(durationMs === undefined ? {} : { durationMs }),
        timestamp: yield* Clock.currentTimeMillis,
      };
      return message;
    });

    const ended = (call: ToolCall, result: ToolResult, isError: boolean, durationMs?: number) =>
      options.onEvent({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result,
        isError,
        ...(durationMs === undefined ? {} : { durationMs }),
      });

    interface Outcome {
      readonly call: ToolCall;
      readonly result: ToolResult;
      readonly isError: boolean;
      readonly durationMs?: number;
    }

    /** Validates arguments sequentially, executes valid calls concurrently, and emits results in call order. */
    const runTools = (calls: readonly ToolCall[], stop: Deferred.Deferred<void>) =>
      Effect.gen(function* () {
        const entries: (Outcome | Effect.Effect<Outcome>)[] = [];
        for (const call of calls) {
          yield* options.onEvent({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
          const tool = options.tools.find((t) => t.name === call.name);
          const read = tool
            ? call.argumentsError
              ? { refused: `Invalid arguments for tool "${call.name}": ${call.argumentsError}` }
              : toolArguments(call.name, call.arguments, tool.parameters)
            : { refused: `Tool ${call.name} not found` };
          if ("refused" in read) {
            const outcome: Outcome = { call, result: errorResult(read.refused), isError: true };
            yield* ended(call, outcome.result, true);
            entries.push(outcome);
            if (yield* Deferred.isDone(stop)) break;
            continue;
          }
          if (yield* Deferred.isDone(stop)) {
            const outcome: Outcome = { call, result: errorResult(operationAborted), isError: true };
            yield* ended(call, outcome.result, true);
            entries.push(outcome);
            break;
          }
          if (!tool) continue;
          const args = read.ok;
          entries.push(
            Effect.gen(function* () {
              if (yield* Deferred.isDone(stop)) {
                const outcome: Outcome = { call, result: errorResult(operationAborted), isError: true };
                yield* ended(call, outcome.result, true);
                return outcome;
              }
              const started = yield* Clock.currentTimeMillis;
              const ran = yield* Effect.raceFirst(
                tool.execute(args, { id: call.id }).pipe(
                  Effect.map((r) => ({ result: r, isError: r.isError === true })),
                  Effect.catch((e) => Effect.succeed({ result: errorResult(e.message), isError: true })),
                ),
                Effect.as(Deferred.await(stop), { result: errorResult(options.stoppedText), isError: true }),
              );
              const outcome: Outcome = { call, ...ran, durationMs: (yield* Clock.currentTimeMillis) - started };
              yield* ended(call, outcome.result, outcome.isError, outcome.durationMs);
              return outcome;
            }),
          );
          if (yield* Deferred.isDone(stop)) break;
        }
        const outcomes = yield* Effect.forEach(entries, (e) => (Effect.isEffect(e) ? e : Effect.succeed(e)), { concurrency: "unbounded" });
        const results: ToolResultMessage[] = [];
        yield* Effect.forEach(
          outcomes,
          (o) =>
            Effect.gen(function* () {
              const m = yield* toolResultMessage(o.call, o.result, o.isError, o.durationMs);
              yield* options.onEvent({ type: "message_start", message: m });
              yield* emit({ type: "message_end", message: m });
              results.push(m);
            }),
          { discard: true },
        );
        return { results, terminate: outcomes.length > 0 && outcomes.every((o) => o.result.terminate === true) };
      });

    const refuseTruncated = (calls: readonly ToolCall[]) =>
      Effect.gen(function* () {
        const results: ToolResultMessage[] = [];
        yield* Effect.forEach(
          calls,
          (call) =>
            Effect.gen(function* () {
              yield* options.onEvent({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
              const result = errorResult(truncated(call.name));
              yield* ended(call, result, true);
              const m = yield* toolResultMessage(call, result, true);
              yield* options.onEvent({ type: "message_start", message: m });
              yield* emit({ type: "message_end", message: m });
              results.push(m);
            }),
          { discard: true },
        );
        return { results, terminate: false };
      });

    const loop = (context: AgentMessage<A>[], fresh: AgentMessage<A>[], stop: Deferred.Deferred<void>, steered: boolean) =>
      Effect.gen(function* () {
        let asked: readonly AgentMessage<A>[] = context;
        // Skip draining `steering` on the first turn when `continue` already consumed it to open the run.
        let pending = steered ? [] : yield* takeAll(steering);
        let first = true;
        let continuing = false;
        outer: while (true) {
          let more = true;
          // oxlint-disable-next-line oxc/no-accumulating-spread -- immutable message snapshot passed to prepareRequest/toLlm each turn
          while (more || pending.length > 0) {
            if (!first) {
              if (pending.length === 0) pending = yield* takeAll(steering);
              yield* options.onEvent({ type: "turn_start" });
            }
            first = false;
            yield* Effect.forEach(
              pending,
              (m) =>
                Effect.gen(function* () {
                  yield* options.onEvent({ type: "message_start", message: m });
                  yield* emit({ type: "message_end", message: m });
                  fresh.push(m);
                }),
              { discard: true },
            );
            asked = [...asked, ...pending];
            pending = [];
            if (options.prepareRequest) {
              const stopped = yield* Deferred.isDone(stop);
              const prepared = yield* Effect.raceFirst(options.prepareRequest(asked, stopped), Effect.as(Deferred.await(stop), undefined));
              if (prepared) asked = prepared;
            }
            const message = yield* answer(asked, stop);
            asked = [...asked, message];
            fresh.push(message);
            if (message.stopReason === "error" || message.stopReason === "aborted") {
              yield* options.finishTurn?.({ message, toolResults: [], messages: asked, stopped: yield* Deferred.isDone(stop) }) ?? Effect.void;
              yield* options.onEvent({ type: "turn_end", message, toolResults: [] });
              return;
            }
            const calls = message.content.filter((c): c is ToolCall => c.type === "toolCall");
            let results: readonly ToolResultMessage[] = [];
            more = false;
            if (calls.length > 0) {
              const batch = message.stopReason === "length" ? yield* refuseTruncated(calls) : yield* runTools(calls, stop);
              results = batch.results;
              more = !batch.terminate;
              asked = [...asked, ...results];
              fresh.push(...results);
            }
            const decision = options.finishTurn
              ? yield* options.finishTurn({ message, toolResults: results, messages: asked, stopped: yield* Deferred.isDone(stop) })
              : undefined;
            yield* options.onEvent({ type: "turn_end", message, toolResults: results });
            if (decision === "end") return;
            continuing = decision === "continue";
            pending = yield* takeAll(steering);
            if (more || pending.length > 0) continuing = false;
          }
          const later = yield* takeOne(followUps);
          if (later.length > 0) {
            continuing = false;
            pending = later;
            first = false;
            continue outer;
          }
          if (continuing) {
            continuing = false;
            first = false;
            continue outer;
          }
          break;
        }
      });

    const start = (prompts: readonly AgentMessage<A>[], steered = false) =>
      Effect.gen(function* () {
        const run: Run = { stop: yield* Deferred.make<void>(), done: yield* Deferred.make<void>() };
        const taken = yield* Ref.modify(active, (a) => (Option.isSome(a) ? ([false, a] as const) : ([true, Option.some(run)] as const)));
        if (!taken) return yield* AgentBusy.make({ message: "the agent is already running" });
        const body = Effect.gen(function* () {
          const context = [...(yield* Ref.get(messages))];
          const fresh: AgentMessage<A>[] = [...prompts];
          yield* options.onEvent({ type: "agent_start" });
          yield* options.onEvent({ type: "turn_start" });
          yield* Effect.forEach(
            prompts,
            (m) =>
              Effect.gen(function* () {
                yield* options.onEvent({ type: "message_start", message: m });
                yield* emit({ type: "message_end", message: m });
              }),
            { discard: true },
          );
          yield* loop([...context, ...prompts], fresh, run.stop, steered);
          yield* options.onEvent({ type: "agent_end", messages: fresh });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const stopped = yield* Deferred.isDone(run.stop);
              const failure: AssistantMessage = {
                role: "assistant",
                content: [{ type: "text", text: "" }],
                api: options.model.api,
                provider: options.model.provider,
                model: options.model.id,
                usage: zeroUsage(),
                stopReason: stopped ? "aborted" : "error",
                errorMessage: messageOf(Cause.squash(cause)),
                timestamp: yield* Clock.currentTimeMillis,
              };
              yield* options.onEvent({ type: "message_start", message: failure });
              yield* emit({ type: "message_end", message: failure });
              yield* options.onEvent({ type: "turn_end", message: failure, toolResults: [] });
              yield* options.onEvent({ type: "agent_end", messages: [failure] });
            }),
          ),
          Effect.ensuring(Effect.andThen(Ref.set(active, Option.none()), Deferred.succeed(run.done, undefined))),
        );
        yield* FiberSet.run(fibers, body);
      });

    const idle = Effect.flatMap(Ref.get(active), Option.match({ onNone: () => Effect.void, onSome: (r) => Deferred.await(r.done) }));

    return {
      prompt: (m) => start(m),
      continue: Effect.gen(function* () {
        const all = yield* Ref.get(messages);
        const last: unknown = all.at(-1);
        if (last === undefined) return yield* CannotContinue.make({ message: "No messages to continue from" });
        if (Predicate.hasProperty(last, "role") && last.role === "assistant") {
          const steered = yield* takeAll(steering);
          if (steered.length > 0) return yield* start(steered, true);
          const later = yield* takeOne(followUps);
          if (later.length > 0) return yield* start(later);
          return yield* CannotContinue.make({ message: "Cannot continue from message role: assistant" });
        }
        return yield* start([]);
      }),
      steer: (m) => Ref.update(steering, (q) => [...q, m]),
      followUp: (m) => Ref.update(followUps, (q) => [...q, m]),
      clearQueues: Effect.andThen(Ref.set(steering, []), Ref.set(followUps, [])),
      hasQueued: Effect.map(Effect.all([Ref.get(steering), Ref.get(followUps)]), ([s, f]) => s.length > 0 || f.length > 0),
      abort: Effect.flatMap(Ref.get(active), Option.match({ onNone: () => Effect.void, onSome: (r) => Deferred.succeed(r.stop, undefined) })),
      idle,
      running: Effect.map(Ref.get(active), Option.isSome),
      messages,
    } satisfies Agent<A>;
  });
