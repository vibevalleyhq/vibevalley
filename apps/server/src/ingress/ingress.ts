import { Context, Effect, Layer, Schedule, Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { Artifact } from "#/artifact/artifact.ts";
import { Channel, type SayMore } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import type { ApiError } from "#/base/errors.ts";
import { ServerConfig } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import type { Picked } from "#/mailbox/envelope.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { keepSourceTrigger, keptTrigger, triggerOf, type TriggerInput } from "#/mailbox/payload.ts";
import type { ProjectError } from "#/project/workplace.ts";

import { githubInputs, type GitHubPullIngress } from "./github.ts";

interface OwnerInput {
  readonly source: "connector" | "voice";
  readonly channel?: string;
  readonly envelope: string;
  readonly text: string;
  readonly picked?: Picked;
  readonly responsePort?: string;
  readonly voiceMode?: "dictated" | "conversation" | "api";
}

export interface SourceEvent extends TriggerInput {
  readonly selfEcho?: boolean;
}

const Payload = Schema.Struct({ text: Schema.String, data: Schema.Unknown });
interface TriggerResource {
  readonly trigger: T.Trigger;
  readonly payload: typeof Payload.Type;
}

export class Ingress extends Context.Service<
  Ingress,
  {
    readonly owner: (input: OwnerInput) => Effect.Effect<{ message: T.ChatMessage; again: boolean }, ApiError>;
    readonly say: (text: string, pick: Picked, channel: string | undefined, sendKey: string, more?: SayMore) => Effect.Effect<void, ApiError>;
    readonly accept: (event: SourceEvent) => Effect.Effect<T.Trigger | undefined, Schema.SchemaError | ApiError>;
    readonly refreshGitHub: Effect.Effect<void>;
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
  const mailbox = yield* Mailbox;
  const encodeTrigger = Schema.encodeEffect(Schema.fromJsonString(S.Trigger));
  const decodeTrigger = Schema.decodeUnknownEffect(Schema.fromJsonString(S.Trigger));
  const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Payload));
  const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Payload));

  const read = Effect.fn("Ingress.read")(function* (id: string) {
    const row = yield* keptTrigger(db, id);
    return row ? { trigger: yield* decodeTrigger(row.trigger_json), payload: yield* decodePayload(row.payload_json) } : undefined;
  });

  const record = Effect.fn("Ingress.record")(function* (event: SourceEvent) {
    if (event.selfEcho === true) return undefined;
    const trigger = triggerOf(event);
    const { id } = trigger;
    yield* keepSourceTrigger(db, {
      id,
      source: event.source,
      source_key: event.key,
      occurred_at: event.at,
      trigger_json: yield* encodeTrigger(trigger),
      payload_json: yield* encodePayload({ text: event.text, data: event.data ?? null }),
    });
    return (yield* read(id))?.trigger;
  });
  const accept = Effect.fn("Ingress.accept")(function* (event: SourceEvent) {
    const trigger = yield* record(event);
    if (trigger) yield* mailbox.receive(trigger);
    return trigger;
  });
  const github = yield* githubInputs(accept);
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
      const picked: Picked = { ...(a ? { agent: a.id } : {}), ...(pick.project?.trim() ? { project: pick.project.trim() } : {}) };
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
    githubSnapshot: github.snapshot,
    read,
    record,
  });
});

export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    const ingress = yield* Ingress;
    const config = yield* ServerConfig;
    const every = config.github.prPollSeconds > 0 ? config.github.prPollSeconds * 1000 : 180_000;
    yield* Effect.forkScoped(ingress.refreshGitHub.pipe(Effect.repeat(Schedule.spaced(every)), Effect.delay(every)));
  }),
);
