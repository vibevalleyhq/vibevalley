import { Effect, Predicate, Schema, SchemaGetter, SchemaIssue } from "effect";

import { ToolFailed } from "@vibevalley/agent/core/errors";
import { effectTool } from "@vibevalley/agent/core/tool";
import type { JsonSchema } from "@vibevalley/ai/tools";
import { ArtifactKindValues, CronWhenKindValues, DeliverableValues, PkmTierValues } from "@vibevalley/protocol";
import { ApiError as ApiErrorSchema, type Handlers } from "@vibevalley/protocol/api";
import * as S from "@vibevalley/protocol/schema";

import type { Actor } from "#/base/actor.ts";
import { messageOf, reasonOf } from "#/base/errors.ts";
import { maxChildren as maxTasks } from "#/issue/creation.ts";

import { answers, descriptions, params, priorityNames, sessionDescriptions, statusNames } from "./prompts.ts";

/** A tool is an endpoint as a model sees it: its name is the endpoint's (toolName), its fields are the endpoint's. */
export type Op = keyof Handlers;

/** channel.message.send is channel_message_send, issue.status.update is issue_status_update. */
export const toolName = (op: Op) =>
  op
    .split(".")
    .map((w) => w.replace(/[A-Z]/gu, (c) => "_" + c.toLowerCase()))
    .join("_");

/** Fields a tool takes that its endpoint does not, which only a model has a use for; tool.test.ts lets these through. */
export const agentOnly: Partial<Record<Op, readonly string[]>> = {
  // A helper's words wait while what it has not seen is shown to it, or a thread's reader is sure it means the channel's top.
  "channel.message.send": ["anyway", "confirm"],
  // An agent reads what is new to it; a page reads pages of a channel.
  "channel.message.list": ["unread"],
  // Written down and sent, or drafted by a helper, in one call, from the channel being answered or the one named.
  "issue.create": ["start", "draft", "channel"],
  // A helper hands in a file from its working directory; the server reads it.
  "artifact.create": ["file"],
  "artifact.version.create": ["file"],
};

const artifactText = {
  content: Schema.optionalKey(Schema.String.annotate({ description: params.artifact.content })),
  note: Schema.optionalKey(Schema.String.annotate({ description: params.artifact.note })),
};
const artifactKind = Schema.Literals(ArtifactKindValues).annotate({ description: params.artifact.kind });
const artifactId = Schema.String.annotate({ description: params.artifact.id }).pipe(
  Schema.decodeTo(S.ArtifactId, {
    decode: SchemaGetter.transform((s: string) => S.artifactId(s.trim())),
    encode: SchemaGetter.passthrough(),
  }),
);
const blockId = (description: string) =>
  Schema.String.annotate({ description }).pipe(
    Schema.decodeTo(S.BlockId, {
      decode: SchemaGetter.transform(S.blockId),
      encode: SchemaGetter.passthrough(),
    }),
  );
const aliasOf = <A extends string>(names: Readonly<Record<string, A>>) =>
  SchemaGetter.transformEffect<A, string>((word, options) => {
    const key = word.trim();
    const value = Object.hasOwn(names, key) ? names[key] : undefined;
    return value !== undefined
      ? Effect.succeed(value)
      : Effect.fail(new SchemaIssue.InvalidValue({ message: `Expected one of: ${Object.keys(names).join(", ")}` }, word, options));
  });
const statusField = (description: string) =>
  Schema.String.annotate({ description }).pipe(
    Schema.decodeTo(S.IssueStatus, {
      decode: aliasOf(statusNames),
      encode: SchemaGetter.passthroughSupertype(),
    }),
  );
const priorityField = (description: string) =>
  Schema.String.annotate({ description }).pipe(
    Schema.decodeTo(S.Priority, {
      decode: aliasOf(priorityNames),
      encode: SchemaGetter.passthroughSupertype(),
    }),
  );
const artifactRead = Schema.Struct({
  id: artifactId,
  version: Schema.optionalKey(Schema.Int.annotate({ description: params.artifact.version })),
});

const pkmParameters = {
  "pkm.search": Schema.Struct({
    limit: Schema.optionalKey(Schema.Int.annotate({ description: params.pkm.limit })),
    text: Schema.String.annotate({ description: params.pkm.text }),
    tier: Schema.optionalKey(Schema.Literals(PkmTierValues).annotate({ description: params.pkm.tier })),
  }).annotate({ requiredOrder: ["text"] }),
  "pkm.page.get": Schema.Struct({ page: Schema.String.annotate({ description: params.pkm.page }) }),
  "pkm.capture": Schema.Struct({ text: Schema.String.annotate({ description: params.pkm.capture }) }),
  "pkm.comment.suggest": Schema.Struct({
    block: Schema.String.annotate({ description: params.pkm.block }),
    rationale: Schema.optionalKey(Schema.String.annotate({ description: params.pkm.rationale })),
    suggested: Schema.String.annotate({ description: params.pkm.suggested }),
  }).annotate({ requiredOrder: ["block", "suggested"] }),
};

const channelRead = Schema.Struct({
  before: Schema.optionalKey(Schema.Finite),
  id: Schema.optionalKey(Schema.String.annotate({ description: params.channelMessageList.id })),
  limit: Schema.optionalKey(Schema.Finite),
  unread: Schema.optionalKey(Schema.Boolean),
});

const blockCreateParameters = Schema.Struct({
  id: artifactId,
  afterBlock: Schema.optionalKey(blockId(params.blockCreate.afterBlock)),
  checked: Schema.optionalKey(Schema.Boolean.annotate({ description: params.blockCreate.checked })),
  language: Schema.optionalKey(Schema.String.annotate({ description: params.blockCreate.language })),
  level: Schema.optionalKey(Schema.Int.annotate({ description: params.blockCreate.level })),
  parentId: Schema.optionalKey(blockId(params.blockCreate.parentId)),
  text: Schema.String.annotate({ description: params.blockCreate.text }),
  type: Schema.optionalKey(Schema.String.annotate({ description: params.blockCreate.type })),
}).annotate({ requiredOrder: ["id", "text"] });

const blockUpdateParameters = Schema.Struct({
  baseRev: Schema.Int.annotate({ description: params.blockUpdate.baseRev }),
  block: blockId(params.blockUpdate.block),
  checked: Schema.optionalKey(Schema.Boolean.annotate({ description: params.blockUpdate.checked })),
  id: artifactId,
  language: Schema.optionalKey(Schema.String.annotate({ description: params.blockUpdate.language })),
  level: Schema.optionalKey(Schema.Int.annotate({ description: params.blockUpdate.level })),
  text: Schema.optionalKey(Schema.String.annotate({ description: params.blockUpdate.text })),
  type: Schema.optionalKey(Schema.String.annotate({ description: params.blockUpdate.type })),
}).annotate({ requiredOrder: ["id", "block", "baseRev"] });

const blockDeleteParameters = Schema.Struct({
  block: blockId(params.blockDelete.block),
  id: artifactId,
}).annotate({ requiredOrder: ["id", "block"] });

/** The orchestrator's, by endpoint. */
export const parameters = {
  "media.image.create": S.MediaImageRequest,
  "media.understanding.start": S.MediaJobRequest,
  "media.speech.create": S.MediaSpeechRequest,
  "media.dialogue.create": S.MediaSpeakersRequest,
  "media.voiceDesign.create": S.MediaVoiceDesignRequest,
  "media.job.get": S.MediaJobRequest,
  "media.job.cancel": S.MediaJobRequest,
  "media.job.download": S.MediaJobRequest,
  "media.job.list": Schema.Struct({}),
  "artifact.content.get": artifactRead,
  "artifact.create": Schema.Struct({
    ...artifactText,
    channel: Schema.optionalKey(Schema.String.annotate({ description: params.artifact.channel })),
    issue: Schema.optionalKey(Schema.String.annotate({ description: params.artifact.issue })),
    kind: artifactKind,
    title: Schema.String.annotate({ description: params.artifact.title }),
  }).annotate({ requiredOrder: ["title", "kind"] }),
  "artifact.get": Schema.Struct({ id: artifactId }),
  "artifact.list": Schema.Struct({
    channel: Schema.optionalKey(Schema.String.annotate({ description: params.artifact.channel })),
    issue: Schema.optionalKey(Schema.String.annotate({ description: params.artifact.issue })),
  }),
  "artifact.version.create": Schema.Struct({ ...artifactText, id: artifactId }),
  "artifact.block.create": blockCreateParameters,
  "artifact.block.update": blockUpdateParameters,
  "artifact.block.delete": blockDeleteParameters,
  "channel.create": Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    name: Schema.String,
    repo: Schema.optionalKey(Schema.String),
  }),
  "channel.list": Schema.Struct({}),
  "channel.message.list": channelRead,
  "channel.update": Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    id: Schema.String.annotate({ description: params.channelRef }),
    repo: Schema.optionalKey(Schema.String),
  }),
  "issue.comment.create": Schema.Struct({
    id: Schema.String.annotate({ description: params.issueOrAgent }),
    text: Schema.String.annotate({ description: params.issueComment.text }),
  }).annotate({ requiredOrder: ["id", "text"] }),
  "issue.create": Schema.Struct({
    parent: Schema.optionalKey(Schema.String.annotate({ description: params.issueOrAgent })),
    blockedBy: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String.annotate({ description: params.issueOrAgent })))),
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.issueCreate.agent })),
    autoSubmitPr: Schema.optionalKey(Schema.Boolean.annotate({ description: params.issueCreate.autoSubmitPr })),
    channel: Schema.optionalKey(Schema.String.annotate({ description: params.issueCreate.channel })),
    deliver: Schema.optionalKey(
      Schema.Literals(DeliverableValues).annotate({
        description: params.issueCreate.deliver,
      }),
    ),
    description: Schema.optionalKey(Schema.String.annotate({ description: params.issueCreate.description })),
    draft: Schema.optionalKey(Schema.Boolean.annotate({ description: params.issueCreate.draft })),
    priority: Schema.optionalKey(priorityField(params.issueCreate.priority)),
    repo: Schema.optionalKey(Schema.String.annotate({ description: params.issueCreate.repo })),
    start: Schema.optionalKey(Schema.Boolean.annotate({ description: params.issueCreate.start })),
    title: Schema.String.annotate({ description: params.issueCreate.title }),
  }),
  "issue.diff.get": Schema.Struct({
    id: Schema.String.annotate({ description: params.issueOrAgent }),
  }),
  "issue.get": Schema.Struct({
    id: Schema.String.annotate({ description: params.issueOrAgent }),
  }),
  "issue.list": Schema.Struct({
    closed: Schema.optionalKey(Schema.Boolean.annotate({ description: params.issueList.closed })),
    limit: Schema.optionalKey(Schema.Finite.annotate({ description: params.issueList.limit })),
    repo: Schema.optionalKey(Schema.String.annotate({ description: params.issueList.repo })),
    status: Schema.optionalKey(statusField(params.issueList.status)),
    text: Schema.optionalKey(Schema.String.annotate({ description: params.issueList.text })),
    wantsOwner: Schema.optionalKey(Schema.Boolean.annotate({ description: params.issueList.wantsOwner })),
  }),
  "issue.review": Schema.Struct({
    findings: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)).annotate({ description: params.issueReview.findings })),
    id: Schema.String.annotate({ description: params.issueOrAgent }),
    pass: Schema.Boolean.annotate({ description: params.issueReview.pass }),
    text: Schema.optionalKey(Schema.String.annotate({ description: params.issueReview.text })),
  }).annotate({ requiredOrder: ["id", "pass"] }),
  "issue.status.update": Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.issueStatus.agent })),
    id: Schema.String.annotate({ description: params.issueNumber }),
    status: statusField(params.issueStatus.status),
    text: Schema.optionalKey(Schema.String.annotate({ description: params.issueStatus.text })),
  }).annotate({ requiredOrder: ["id", "status"] }),
  "issue.update": Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.agent })),
    criteria: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)).annotate({ description: params.issueUpdate.criteria })),
    deliver: Schema.optionalKey(Schema.Literals(DeliverableValues).annotate({ description: params.issueUpdate.deliver })),
    description: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.description })),
    id: Schema.String.annotate({ description: params.issueNumber }),
    priority: Schema.optionalKey(priorityField(params.issueUpdate.priority)),
    repo: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.repo })),
    title: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.title })),
  }),
  "memory.create": Schema.Struct({
    agent: Schema.String.annotate({ description: params.agentProfile }),
    repo: Schema.optionalKey(Schema.String.annotate({ description: params.memoryCreate.repo })),
    text: Schema.String.annotate({ description: params.memoryCreate.text }),
  }),
  "memory.search": Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.agentProfile })),
    repo: Schema.optionalKey(Schema.String.annotate({ description: params.repoFolder })),
    text: Schema.optionalKey(Schema.String.annotate({ description: params.searchText })),
  }),
  "repo.list": Schema.Struct({}),
  ...pkmParameters,
  "cron.create": Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.cron.agent })),
    channel: Schema.optionalKey(Schema.String.annotate({ description: params.cron.channel })),
    name: Schema.String.annotate({ description: params.cron.name }),
    repo: Schema.optionalKey(Schema.String.annotate({ description: params.cron.repo })),
    text: Schema.String.annotate({ description: params.cron.text }),
    tz: Schema.optionalKey(Schema.String.annotate({ description: params.cron.tz })),
    when: Schema.Struct({
      at: Schema.optionalKey(Schema.String.annotate({ description: params.cron.at })),
      days: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Finite))),
      expr: Schema.optionalKey(Schema.String.annotate({ description: params.cron.expr })),
      kind: Schema.Literals(CronWhenKindValues),
      minutes: Schema.optionalKey(Schema.Finite),
      time: Schema.optionalKey(Schema.String.annotate({ description: "HH:MM" })),
    }).annotate({ description: params.cron.when }),
  }).annotate({ requiredOrder: ["name", "text", "when"] }),
  "cron.delete": Schema.Struct({
    id: Schema.String,
  }),
  "cron.list": Schema.Struct({}),
  "session.list": Schema.Struct({}),
  "session.stop": Schema.Struct({
    id: Schema.String.annotate({ description: params.issueOrAgent }),
  }),
};

/** A session's, by endpoint; channel.message.list is the orchestrator's. */
export const sessionParameters = {
  "artifact.content.get": artifactRead,
  "artifact.create": Schema.Struct({
    ...artifactText,
    file: Schema.optionalKey(Schema.String.annotate({ description: params.artifact.file })),
    kind: artifactKind,
    title: Schema.String.annotate({ description: params.artifact.title }),
  }).annotate({ requiredOrder: ["title", "kind"] }),
  "artifact.get": Schema.Struct({ id: artifactId }),
  "artifact.list": Schema.Struct({
    channel: Schema.optionalKey(Schema.String.annotate({ description: params.artifact.channel })),
  }),
  "artifact.version.create": Schema.Struct({
    ...artifactText,
    file: Schema.optionalKey(Schema.String.annotate({ description: params.artifact.file })),
    id: artifactId,
  }),
  "channel.message.list": channelRead,
  "channel.message.send": Schema.Struct({
    anyway: Schema.optionalKey(Schema.Boolean.annotate({ description: params.channelMessageSend.anyway })),
    confirm: Schema.optionalKey(Schema.Boolean.annotate({ description: params.channelMessageSend.confirm })),
    id: Schema.optionalKey(Schema.String),
    replyTo: Schema.optionalKey(Schema.Int.annotate({ description: params.channelMessageSend.replyTo })),
    text: Schema.String,
  }),
  "channel.unread.list": Schema.Struct({}),
  "artifact.block.create": blockCreateParameters,
  "artifact.block.update": blockUpdateParameters,
  "artifact.block.delete": blockDeleteParameters,
  "issue.split": Schema.Struct({
    tasks: Schema.mutable(
      Schema.Array(
        Schema.Struct({
          acceptance: Schema.optionalKey(Schema.Boolean.annotate({ description: params.issueSplit.task.acceptance })),
          agent: Schema.optionalKey(Schema.String.annotate({ description: params.issueSplit.task.agent })),
          brief: Schema.String.annotate({ description: params.issueSplit.task.brief }),
          check: Schema.optionalKey(Schema.String.annotate({ description: params.issueSplit.task.check })),
          id: Schema.String.annotate({ description: params.issueSplit.task.id }),
          needs: Schema.optionalKey(Schema.NullOr(Schema.mutable(Schema.Array(Schema.String))).annotate({ description: params.issueSplit.task.needs })),
          scope: Schema.optionalKey(Schema.NullOr(Schema.mutable(Schema.Array(Schema.String))).annotate({ description: params.issueSplit.task.scope })),
          title: Schema.optionalKey(Schema.String),
        }).annotate({ requiredOrder: ["id", "brief"], parseOptions: { onExcessProperty: "error" } }),
      ),
    ).annotate({ description: params.issueSplit.tasksDescription }),
    title: Schema.optionalKey(Schema.String.annotate({ description: params.issueSplit.title })),
  }),
  "memory.create": Schema.Struct({
    repo: Schema.optionalKey(Schema.String.annotate({ description: params.sessionMemory.createRepo })),
    text: Schema.String.annotate({ description: params.sessionMemory.text }),
  }),
  "memory.search": Schema.Struct({
    repo: Schema.optionalKey(Schema.String.annotate({ description: params.sessionMemory.searchRepo })),
    text: Schema.optionalKey(Schema.String.annotate({ description: params.searchText })),
  }),
  "session.list": Schema.Struct({}),
  ...pkmParameters,
};

const safe = Number.MAX_SAFE_INTEGER;

/** Effect's JSON Schema, reshaped to the bytes the tools have always been written as. */
const written = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(written);
  if (typeof node !== "object" || node === null) return node;
  let o: Record<string, unknown> = Object.fromEntries(Object.entries(node));
  const choices = o.anyOf;
  if (Array.isArray(choices) && choices.length === 2) {
    const value: unknown = choices[0];
    const none: unknown = choices[1];
    if (Predicate.isObject(none) && "type" in none && none.type === "null" && Predicate.isObject(value)) {
      const { anyOf: _, ...rest } = o;
      o = { ...value, ...rest, type: ["null", "type" in value ? value.type : undefined] };
    }
  }
  if (o.type === "integer" && o.minimum === -safe && o.maximum === safe) {
    delete o.minimum;
    delete o.maximum;
  }
  if (Array.isArray(o.requiredOrder)) {
    o.required = o.requiredOrder;
    delete o.requiredOrder;
  }
  if (o.parseOptions !== undefined) {
    if (Predicate.isObject(o.parseOptions) && "onExcessProperty" in o.parseOptions && o.parseOptions.onExcessProperty === "error")
      o.additionalProperties = false;
    delete o.parseOptions;
  }
  if (Array.isArray(o.required) && o.required.length === 0) delete o.required;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(o).toSorted()) {
    const value = o[key];
    out[key] =
      key === "properties" && Predicate.isObject(value) ? Object.fromEntries(Object.entries(value).map(([name, p]) => [name, written(p)])) : written(value);
  }
  return out;
};

export const toolParameters = (parameters: Schema.Struct<Schema.Struct.Fields>): JsonSchema => {
  if (Object.keys(parameters.fields).length === 0) return { additionalProperties: true, properties: {}, type: "object" };
  const shaped = written(Schema.toJsonSchemaDocument(parameters, { includeAnnotationKey: (key) => key === "requiredOrder" || key === "parseOptions" }).schema);
  return Predicate.isObject(shaped) ? Object.fromEntries(Object.entries(shaped)) : {};
};

const shown = (all: Record<string, Schema.Struct<Schema.Struct.Fields>>): Record<string, JsonSchema> =>
  Object.fromEntries(Object.entries(all).map(([op, p]) => [op, toolParameters(p)]));

/** As the model is shown them, by endpoint. */
export const schemas = shown(parameters);
const sessionSchemas = shown(sessionParameters);

export type Orchestrator<K extends keyof typeof parameters> = (typeof parameters)[K]["Type"];

export type SessionInput<K extends keyof typeof sessionParameters> = (typeof sessionParameters)[K]["Type"];

export interface Caller {
  /** The profile: an orchestrator's own id for an orchestrator. */
  readonly agent: string;
  /** The session working as agent, and the repo it works in; both empty for the orchestrator. */
  readonly session: string;
  readonly repo: string;
  /** The channel the orchestrator is answering. A session's default is its own issue thread, which the channel service knows. */
  readonly here: string;
  /** The profile the owner picked for this input, if any: dispatch prefers it. */
  readonly picked: string;
  /** The ingress envelope currently being handled; empty when this run was not opened by one. */
  readonly envelope: string;
  /** Who calls, and on whose word: the services judge what it may do by it. */
  readonly actor: Actor;
}

export type Who = () => Caller;

export class ToolRefusal extends Schema.TaggedError<ToolRefusal, { readonly brand: unique symbol }>()("ToolRefusal", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const refuse = (message: string) => Effect.fail(new ToolRefusal({ message }));

const toFailed = (e: unknown): ToolFailed => new ToolFailed({ message: Schema.is(ApiErrorSchema)(e) ? reasonOf(e) : messageOf(e), cause: e });

export const said = (e: unknown) => toFailed(e).message;

export const callerOf = (who: Who) => Effect.try({ try: who, catch: (e) => new ToolRefusal({ message: said(e), cause: e }) });

/** An answer, or the refusal prefix and why. */
export const answered = <E>(e: Effect.Effect<string, E>) => Effect.catch(e, (err) => Effect.succeed(answers.failed(said(err))));

// Who reads and speaks in a channel: a session as itself, the orchestrator as the orchestrator.
export const participant = (c: Caller) => c.session || c.agent;

// A tool's arguments are read by its Schema before it runs. the model's JSON Schema is made from the same one.
const toolOf =
  <All extends { readonly [op: string]: Schema.Codec<unknown, unknown> }>(
    all: All,
    shown: Record<string, JsonSchema>,
    words: Record<keyof All & string, string>,
  ) =>
  <K extends keyof All & Op, E>(op: K, body: (p: All[K]["Type"]) => Effect.Effect<string, E>) => {
    const read: (args: unknown) => Effect.Effect<All[K]["Type"], Schema.SchemaError> = Schema.decodeUnknownEffect<All[K]>(all[op]);
    return effectTool({
      name: toolName(op),
      description: words[op],
      parameters: shown[op] ?? {},
      run: (args) => Effect.mapError(Effect.flatMap(read(args), body), toFailed),
    });
  };

export const tool = toolOf(parameters, schemas, descriptions);
export const sessionSchemaTool = toolOf(sessionParameters, sessionSchemas, {
  ...sessionDescriptions,
  "issue.split": sessionDescriptions["issue.split"](maxTasks),
});

export const customTool = <A, E>(
  name: string,
  description: string,
  parameters: JsonSchema,
  read: (args: unknown) => Effect.Effect<A, Schema.SchemaError>,
  body: (input: A) => Effect.Effect<string, E>,
) => {
  return effectTool({
    name,
    description,
    parameters,
    run: (args) => Effect.mapError(Effect.flatMap(read(args), body), toFailed),
  });
};
