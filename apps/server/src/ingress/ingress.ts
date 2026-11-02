import { createHash } from "node:crypto";

import { Context, Effect, Layer, Schedule, Schema, Stream } from "effect";

import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { Artifact } from "@/artifact/artifact.ts";
import { compactCard } from "@/base/card.ts";
import { Channel, type SayMore } from "@/channel/chat.ts";
import type { Picked } from "@/channel/wake.ts";
import { Core } from "@/core/core.ts";
import type { ApiError } from "@/errors.ts";
import { ServerConfig } from "@/infra/config.ts";
import { Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";
import { Issue } from "@/issue/issue.ts";
import { Mailbox } from "@/mailbox/mailbox.ts";
import type { ProjectError } from "@/project/shapes.ts";

import * as q from "../../db/generated/ingress_trigger.sql.ts";
import type { GitHubPullIngress } from "./github-source.ts";
import { githubInputs } from "./github.ts";

export interface OwnerInput {
  readonly source: "connector" | "voice";
  readonly channel?: string;
  readonly envelope: string;
  readonly text: string;
  readonly picked?: Picked;
  readonly responsePort?: string;
  readonly voiceMode?: "dictated" | "conversation" | "api";
}

export interface SourceEvent {
  readonly source: T.TriggerSource;
  readonly key: string;
  readonly actor: T.TriggerActor;
  readonly text: string;
  readonly data?: unknown;
  readonly threads: readonly string[];
  readonly addressed: T.TriggerAddressing;
  readonly replyChannel?: string;
  readonly replyTo?: string;
  readonly picked?: T.Trigger["picked"];
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly at: number;
  readonly selfEcho?: boolean;
}

const Payload = Schema.Struct({ text: Schema.String, data: Schema.Unknown });
export interface TriggerResource {
  readonly trigger: T.Trigger;
  readonly payload: typeof Payload.Type;
}

export class Ingress extends Context.Service<
  Ingress,
  {
    readonly owner: (input: OwnerInput) => Effect.Effect<{ message: T.ChatMessage; again: boolean }, ApiError>;
    readonly say: (text: string, pick: Picked, channel: string | undefined, sendKey: string, more?: SayMore) => Effect.Effect<void, ApiError>;
    readonly accept: (event: SourceEvent) => Effect.Effect<T.Trigger | undefined, Schema.SchemaError | ApiError>;
    readonly start: Effect.Effect<void>;
    readonly refreshGitHub: Effect.Effect<void>;
    readonly refreshCron: Effect.Effect<void>;
    readonly refreshIssues: Effect.Effect<void>;
    readonly githubSnapshot: (project: string, pr: number) => Effect.Effect<GitHubPullIngress, ProjectError>;
    readonly record: (event: SourceEvent) => Effect.Effect<T.Trigger | undefined, Schema.SchemaError>;
    readonly read: (id: string) => Effect.Effect<TriggerResource | undefined, Schema.SchemaError>;
  }
>()("vibevalley/Ingress") {
  static readonly layer = Layer.effect(
    Ingress,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const db = yield* Db;
  const store = yield* Agent;
  const artifacts = yield* Artifact;
  const chat = yield* Channel;
  const core = yield* Core;
  const issues = yield* Issue;
  const mailbox = yield* Mailbox;
  const encodeTrigger = Schema.encodeEffect(Schema.fromJsonString(S.Trigger));
  const decodeTrigger = Schema.decodeUnknownEffect(Schema.fromJsonString(S.Trigger));
  const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Payload));
  const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Payload));

  const read = Effect.fn("Ingress.read")(function* (id: string) {
    const row = yield* db.one(q.triggerById({ id }));
    return row ? { trigger: yield* decodeTrigger(row.trigger_json), payload: yield* decodePayload(row.payload_json) } : undefined;
  });

  const record = Effect.fn("Ingress.record")(function* (event: SourceEvent) {
    if (event.selfEcho === true) return undefined;
    const id = createHash("sha256")
      .update(JSON.stringify([event.source, event.key]))
      .digest("hex");
    const trigger: T.Trigger = {
      id,
      source: event.source,
      actor: event.actor,
      addressed: event.addressed,
      threads: [...new Set(event.threads)],
      card: compactCard(event.text, `vv://trigger/${id}`, 600),
      meta: event.meta ?? {},
      at: event.at,
      ...(event.replyChannel === undefined ? {} : { replyChannel: event.replyChannel }),
      ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
      ...(event.picked === undefined ? {} : { picked: event.picked }),
    };
    yield* db.run(
      q.recordTrigger({
        id,
        source: event.source,
        source_key: event.key,
        occurred_at: event.at,
        trigger_json: yield* encodeTrigger(trigger),
        payload_json: yield* encodePayload({ text: event.text, data: event.data ?? null }),
      }),
    );
    return (yield* read(id))?.trigger;
  });
  const accept = Effect.fn("Ingress.accept")(function* (event: SourceEvent) {
    const trigger = yield* record(event);
    if (trigger) yield* mailbox.receive(trigger);
    return trigger;
  });
  const github = yield* githubInputs(accept);
  /** Triggers written but never routed (a crash between the write and the hand-off): route them now. */
  const replay = Effect.gen(function* () {
    let after = 0;
    while (true) {
      const rows = yield* db.run(q.unroutedTriggers({ after }));
      if (rows.length === 0) return;
      yield* Effect.forEach(rows, (row) => Effect.flatMap(decodeTrigger(row.trigger_json), mailbox.receive).pipe(bestEffort(`ingress: replay ${row.id}`)), {
        discard: true,
      });
      after = rows.at(-1)!.seq;
    }
  });
  const refreshIssues = Effect.gen(function* () {
    yield* replay;
    yield* issues.tryQueued(yield* mailbox.queuedInputs, (session, launch, inputs) => mailbox.registerInitialInputs(session, launch, inputs));
  });
  yield* Effect.forkScoped(Stream.runForEach(yield* core.subscribe, (fact) => (fact.type === "issue" ? refreshIssues : Effect.void)));
  /** What the blocks the owner pointed at read now: the version quoted, and whether they changed or went. */
  const quote = (refs: SayMore["blockRefs"]): Effect.Effect<T.QuotedBlock[]> =>
    Effect.forEach(refs ?? [], (ref) =>
      Effect.gen(function* () {
        const snapshot = yield* artifacts.blocks(ref.artifactId);
        const block = snapshot.blocks.find((b) => b.id === ref.blockId);
        return {
          artifactId: ref.artifactId,
          blockId: ref.blockId,
          rev: ref.rev,
          title: snapshot.artifact.title,
          ...(block ? { type: block.type, text: block.text.map((s) => s.t).join(""), nowRev: block.rev } : { deleted: true }),
        } satisfies T.QuotedBlock;
      }).pipe(Effect.catch((e) => Effect.as(Effect.logWarning("quoting a block failed", e), undefined))),
    ).pipe(Effect.map((all) => all.flatMap((b) => (b === undefined ? [] : [b]))));

  return Ingress.of({
    owner: Effect.fn("Ingress.owner")(function* (input) {
      yield* core.open();
      return yield* chat.say(input.text, input.channel, input.envelope, {
        source: input.source,
        ...(input.picked ? { picked: input.picked } : {}),
        ...(input.responsePort ? { responsePort: input.responsePort } : {}),
        ...(input.voiceMode ? { voiceMode: input.voiceMode } : {}),
      });
    }),
    say: Effect.fn("Ingress.say")(function* (text, pick, channel, sendKey, more) {
      const a = pick.agent ? store.agent(pick.agent) : undefined;
      const picked: Picked = { ...(a ? { agent: a.id } : {}), ...((pick.project ?? "").trim() ? { project: pick.project!.trim() } : {}) };
      const blocks = yield* quote(more?.blockRefs);
      yield* core.open();
      yield* chat.say(text, channel, sendKey, {
        ...more,
        ...(blocks.length > 0 ? { blocks } : {}),
        ...(picked.agent || picked.project ? { picked } : {}),
      });
    }),
    accept,
    refreshGitHub: github.refresh,
    refreshCron: replay,
    refreshIssues,
    githubSnapshot: github.snapshot,
    read,
    record,
    start: refreshIssues,
  });
});

export const ready = Layer.effectDiscard(Effect.flatMap(Ingress, (ingress) => ingress.start));
export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    const ingress = yield* Ingress;
    const config = yield* ServerConfig;
    const every = config.github.prPollSeconds > 0 ? config.github.prPollSeconds * 1000 : 180_000;
    yield* Effect.forkScoped(ingress.refreshCron.pipe(Effect.repeat(Schedule.spaced(config.chat.retryWakeMs)), Effect.delay(config.chat.retryWakeMs)));
    yield* Effect.forkScoped(ingress.refreshIssues.pipe(Effect.repeat(Schedule.spaced(config.chat.retryWakeMs)), Effect.delay(config.chat.retryWakeMs)));
    yield* Effect.forkScoped(ingress.refreshGitHub.pipe(Effect.repeat(Schedule.spaced(every)), Effect.delay(every)));
  }),
);
