import { z } from "zod";

import { ToolFailed } from "@vibevalley/agent/core/errors";
import { runTool } from "@vibevalley/agent/core/tool";
import type { JsonSchema } from "@vibevalley/ai/tools";
import { isAbort } from "@vibevalley/async";
import {
  ArtifactDisplayValues,
  ArtifactKindValues,
  CronWhenKindValues,
  DeliverableValues,
  LibraryFileKindValues,
  LibraryOriginKindValues,
  PkmTierValues,
} from "@vibevalley/protocol";
import { isApiError, type Handlers } from "@vibevalley/protocol/api";
import * as S from "@vibevalley/protocol/schema";

import type { Actor } from "#/base/actor.ts";
import { messageOf, reasonOf } from "#/base/errors.ts";
import { problemOf } from "#/base/json.ts";
import { maxChildren as maxTasks } from "#/modules/issue/creation.ts";

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

const libraryList = z.object({
  origin: z.exactOptional(z.enum(LibraryOriginKindValues).describe(params.library.origin)),
  type: z.exactOptional(z.enum(LibraryFileKindValues).describe(params.library.type)),
  text: z.exactOptional(z.string().describe(params.library.text)),
});
const libraryName = z.exactOptional(z.string().describe(params.library.name));

const artifactText = {
  content: z.exactOptional(z.string().describe(params.artifact.content)),
  note: z.exactOptional(z.string().describe(params.artifact.note)),
};
const artifactKind = z.enum(ArtifactKindValues).describe(params.artifact.kind);
const artifactDisplay = z.exactOptional(z.enum(ArtifactDisplayValues).describe(params.artifact.display));
const artifactId = z
  .string()
  .describe(params.artifact.id)
  .transform((s) => S.artifactId(s.trim()));
const blockId = (description: string) => z.string().describe(description).transform(S.blockId);
const aliasOf =
  <A extends string>(names: Readonly<Record<string, A>>) =>
  (word: string, ctx: z.RefinementCtx<string>): A => {
    const key = word.trim();
    const value = Object.hasOwn(names, key) ? names[key] : undefined;
    if (value !== undefined) return value;
    ctx.addIssue({ code: "custom", message: `Expected one of: ${Object.keys(names).join(", ")}`, input: word });
    return z.NEVER;
  };
const statusField = (description: string) => z.string().describe(description).transform(aliasOf(statusNames));
const priorityField = (description: string) => z.string().describe(description).transform(aliasOf(priorityNames));
const artifactRead = z.object({
  id: artifactId,
  version: z.exactOptional(z.number().int().describe(params.artifact.version)),
});

const pkmParameters = {
  "pkm.search": z
    .object({
      limit: z.exactOptional(z.number().int().describe(params.pkm.limit)),
      text: z.string().describe(params.pkm.text),
      tier: z.exactOptional(z.enum(PkmTierValues).describe(params.pkm.tier)),
    })
    .meta({ requiredOrder: ["text"] }),
  "pkm.page.get": z.object({ page: z.string().describe(params.pkm.page) }),
  "pkm.capture": z.object({ text: z.string().describe(params.pkm.capture) }),
  "pkm.comment.suggest": z
    .object({
      block: z.string().describe(params.pkm.block),
      rationale: z.exactOptional(z.string().describe(params.pkm.rationale)),
      suggested: z.string().describe(params.pkm.suggested),
    })
    .meta({ requiredOrder: ["block", "suggested"] }),
};

const channelRead = z.object({
  before: z.exactOptional(z.number()),
  id: z.exactOptional(z.string().describe(params.channelMessageList.id)),
  limit: z.exactOptional(z.number()),
  unread: z.exactOptional(z.boolean()),
});

const blockCreateParameters = z
  .object({
    id: artifactId,
    afterBlock: z.exactOptional(blockId(params.blockCreate.afterBlock)),
    checked: z.exactOptional(z.boolean().describe(params.blockCreate.checked)),
    language: z.exactOptional(z.string().describe(params.blockCreate.language)),
    level: z.exactOptional(z.number().int().describe(params.blockCreate.level)),
    parentId: z.exactOptional(blockId(params.blockCreate.parentId)),
    text: z.string().describe(params.blockCreate.text),
    type: z.exactOptional(z.string().describe(params.blockCreate.type)),
  })
  .meta({ requiredOrder: ["id", "text"] });

const blockUpdateParameters = z
  .object({
    baseRev: z.number().int().describe(params.blockUpdate.baseRev),
    block: blockId(params.blockUpdate.block),
    checked: z.exactOptional(z.boolean().describe(params.blockUpdate.checked)),
    id: artifactId,
    language: z.exactOptional(z.string().describe(params.blockUpdate.language)),
    level: z.exactOptional(z.number().int().describe(params.blockUpdate.level)),
    text: z.exactOptional(z.string().describe(params.blockUpdate.text)),
    type: z.exactOptional(z.string().describe(params.blockUpdate.type)),
  })
  .meta({ requiredOrder: ["id", "block", "baseRev"] });

const blockDeleteParameters = z
  .object({
    block: blockId(params.blockDelete.block),
    id: artifactId,
  })
  .meta({ requiredOrder: ["id", "block"] });

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
  "media.job.list": z.object({}),
  "library.item.list": libraryList,
  "library.item.add": z.object({ name: libraryName, url: z.string().describe(params.library.url) }),
  "artifact.content.get": artifactRead,
  "artifact.create": z
    .object({
      ...artifactText,
      channel: z.exactOptional(z.string().describe(params.artifact.channel)),
      issue: z.exactOptional(z.string().describe(params.artifact.issue)),
      kind: artifactKind,
      display: artifactDisplay,
      title: z.string().describe(params.artifact.title),
    })
    .meta({ requiredOrder: ["title", "kind"] }),
  "artifact.get": z.object({ id: artifactId }),
  "artifact.list": z.object({
    channel: z.exactOptional(z.string().describe(params.artifact.channel)),
    issue: z.exactOptional(z.string().describe(params.artifact.issue)),
  }),
  "artifact.version.create": z.object({ ...artifactText, id: artifactId }),
  "artifact.block.create": blockCreateParameters,
  "artifact.block.update": blockUpdateParameters,
  "artifact.block.delete": blockDeleteParameters,
  "channel.create": z.object({
    description: z.exactOptional(z.string()),
    name: z.string(),
    repo: z.exactOptional(z.string()),
  }),
  "channel.list": z.object({}),
  "channel.message.list": channelRead,
  "channel.update": z.object({
    description: z.exactOptional(z.string()),
    id: z.string().describe(params.channelRef),
    repo: z.exactOptional(z.string()),
  }),
  "issue.comment.create": z
    .object({
      id: z.string().describe(params.issueOrAgent),
      text: z.string().describe(params.issueComment.text),
    })
    .meta({ requiredOrder: ["id", "text"] }),
  "issue.create": z.object({
    parent: z.exactOptional(z.string().describe(params.issueOrAgent)),
    blockedBy: z.exactOptional(z.array(z.string().describe(params.issueOrAgent))),
    agent: z.exactOptional(z.string().describe(params.issueCreate.agent)),
    autoSubmitPr: z.exactOptional(z.boolean().describe(params.issueCreate.autoSubmitPr)),
    channel: z.exactOptional(z.string().describe(params.issueCreate.channel)),
    deliver: z.exactOptional(z.enum(DeliverableValues).describe(params.issueCreate.deliver)),
    description: z.exactOptional(z.string().describe(params.issueCreate.description)),
    draft: z.exactOptional(z.boolean().describe(params.issueCreate.draft)),
    priority: z.exactOptional(priorityField(params.issueCreate.priority)),
    repo: z.exactOptional(z.string().describe(params.issueCreate.repo)),
    start: z.exactOptional(z.boolean().describe(params.issueCreate.start)),
    title: z.string().describe(params.issueCreate.title),
  }),
  "issue.diff.get": z.object({
    id: z.string().describe(params.issueOrAgent),
  }),
  "issue.get": z.object({
    id: z.string().describe(params.issueOrAgent),
  }),
  "issue.list": z.object({
    closed: z.exactOptional(z.boolean().describe(params.issueList.closed)),
    limit: z.exactOptional(z.number().describe(params.issueList.limit)),
    repo: z.exactOptional(z.string().describe(params.issueList.repo)),
    status: z.exactOptional(statusField(params.issueList.status)),
    text: z.exactOptional(z.string().describe(params.issueList.text)),
    wantsUser: z.exactOptional(z.boolean().describe(params.issueList.wantsUser)),
  }),
  "issue.review": z
    .object({
      findings: z.exactOptional(z.array(z.string()).describe(params.issueReview.findings)),
      id: z.string().describe(params.issueOrAgent),
      pass: z.boolean().describe(params.issueReview.pass),
      text: z.exactOptional(z.string().describe(params.issueReview.text)),
    })
    .meta({ requiredOrder: ["id", "pass"] }),
  "issue.status.update": z
    .object({
      agent: z.exactOptional(z.string().describe(params.issueStatus.agent)),
      id: z.string().describe(params.issueNumber),
      status: statusField(params.issueStatus.status),
      text: z.exactOptional(z.string().describe(params.issueStatus.text)),
    })
    .meta({ requiredOrder: ["id", "status"] }),
  "issue.update": z.object({
    agent: z.exactOptional(z.string().describe(params.issueUpdate.agent)),
    criteria: z.exactOptional(z.array(z.string()).describe(params.issueUpdate.criteria)),
    deliver: z.exactOptional(z.enum(DeliverableValues).describe(params.issueUpdate.deliver)),
    description: z.exactOptional(z.string().describe(params.issueUpdate.description)),
    id: z.string().describe(params.issueNumber),
    priority: z.exactOptional(priorityField(params.issueUpdate.priority)),
    repo: z.exactOptional(z.string().describe(params.issueUpdate.repo)),
    title: z.exactOptional(z.string().describe(params.issueUpdate.title)),
  }),
  "memory.create": z.object({
    agent: z.string().describe(params.agentProfile),
    repo: z.exactOptional(z.string().describe(params.memoryCreate.repo)),
    text: z.string().describe(params.memoryCreate.text),
  }),
  "memory.search": z.object({
    agent: z.exactOptional(z.string().describe(params.agentProfile)),
    repo: z.exactOptional(z.string().describe(params.repoFolder)),
    text: z.exactOptional(z.string().describe(params.searchText)),
  }),
  "repo.list": z.object({}),
  ...pkmParameters,
  "cron.create": z
    .object({
      agent: z.exactOptional(z.string().describe(params.cron.agent)),
      channel: z.exactOptional(z.string().describe(params.cron.channel)),
      name: z.string().describe(params.cron.name),
      repo: z.exactOptional(z.string().describe(params.cron.repo)),
      text: z.string().describe(params.cron.text),
      tz: z.exactOptional(z.string().describe(params.cron.tz)),
      when: z
        .object({
          at: z.exactOptional(z.string().describe(params.cron.at)),
          days: z.exactOptional(z.array(z.number())),
          expr: z.exactOptional(z.string().describe(params.cron.expr)),
          kind: z.enum(CronWhenKindValues),
          minutes: z.exactOptional(z.number()),
          time: z.exactOptional(z.string().describe("HH:MM")),
        })
        .describe(params.cron.when),
    })
    .meta({ requiredOrder: ["name", "text", "when"] }),
  "cron.delete": z.object({
    id: z.string(),
  }),
  "cron.list": z.object({}),
  "session.list": z.object({}),
  "session.stop": z.object({
    id: z.string().describe(params.issueOrAgent),
  }),
};

/** A session's, by endpoint; channel.message.list is the orchestrator's. */
export const sessionParameters = {
  "artifact.content.get": artifactRead,
  "artifact.create": z
    .object({
      ...artifactText,
      file: z.exactOptional(z.string().describe(params.artifact.file)),
      kind: artifactKind,
      display: artifactDisplay,
      title: z.string().describe(params.artifact.title),
    })
    .meta({ requiredOrder: ["title", "kind"] }),
  "artifact.get": z.object({ id: artifactId }),
  "artifact.list": z.object({
    channel: z.exactOptional(z.string().describe(params.artifact.channel)),
  }),
  "artifact.version.create": z.object({
    ...artifactText,
    file: z.exactOptional(z.string().describe(params.artifact.file)),
    id: artifactId,
  }),
  "channel.message.list": channelRead,
  "channel.message.send": z.object({
    anyway: z.exactOptional(z.boolean().describe(params.channelMessageSend.anyway)),
    confirm: z.exactOptional(z.boolean().describe(params.channelMessageSend.confirm)),
    id: z.exactOptional(z.string()),
    replyTo: z.exactOptional(z.number().int().describe(params.channelMessageSend.replyTo)),
    text: z.string(),
  }),
  "channel.unread.list": z.object({}),
  "artifact.block.create": blockCreateParameters,
  "artifact.block.update": blockUpdateParameters,
  "artifact.block.delete": blockDeleteParameters,
  "issue.split": z.object({
    tasks: z
      .array(
        z
          .strictObject({
            acceptance: z.exactOptional(z.boolean().describe(params.issueSplit.task.acceptance)),
            agent: z.exactOptional(z.string().describe(params.issueSplit.task.agent)),
            brief: z.string().describe(params.issueSplit.task.brief),
            check: z.exactOptional(z.string().describe(params.issueSplit.task.check)),
            id: z.string().describe(params.issueSplit.task.id),
            needs: z.exactOptional(z.array(z.string()).nullable().describe(params.issueSplit.task.needs)),
            scope: z.exactOptional(z.array(z.string()).nullable().describe(params.issueSplit.task.scope)),
            title: z.exactOptional(z.string()),
          })
          .meta({ requiredOrder: ["id", "brief"] }),
      )
      .describe(params.issueSplit.tasksDescription),
    title: z.exactOptional(z.string().describe(params.issueSplit.title)),
  }),
  "memory.create": z.object({
    repo: z.exactOptional(z.string().describe(params.sessionMemory.createRepo)),
    text: z.string().describe(params.sessionMemory.text),
  }),
  "memory.search": z.object({
    repo: z.exactOptional(z.string().describe(params.sessionMemory.searchRepo)),
    text: z.exactOptional(z.string().describe(params.searchText)),
  }),
  "session.list": z.object({}),
  "library.item.list": libraryList,
  "library.item.add": z.object({
    name: libraryName,
    path: z.exactOptional(z.string().describe(params.library.path)),
    url: z.exactOptional(z.string().describe(params.library.url)),
  }),
  ...pkmParameters,
};

const safe = Number.MAX_SAFE_INTEGER;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Zod's JSON Schema, reshaped to the bytes the tools have always been written as: keys sorted, `T | null` as a type
 * pair, no safe-integer bounds, `requiredOrder` as `required`, and objects open unless they are strict. */
const written = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(written);
  if (!isObject(node)) return node;
  let o: Record<string, unknown> = { ...node };
  delete o.$schema;
  const choices = o.anyOf;
  if (Array.isArray(choices) && choices.length === 2) {
    const value: unknown = choices[0];
    const none: unknown = choices[1];
    if (isObject(none) && none.type === "null" && isObject(value)) {
      const { anyOf: _, ...rest } = o;
      o = { ...value, ...rest, type: ["null", value.type] };
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
  if (o.type === "object" && o.additionalProperties === undefined) o.additionalProperties = true;
  if (Array.isArray(o.required) && o.required.length === 0) delete o.required;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(o).toSorted()) {
    const value = o[key];
    out[key] = key === "properties" && isObject(value) ? Object.fromEntries(Object.entries(value).map(([name, p]) => [name, written(p)])) : written(value);
  }
  return out;
};

const toolParameters = (parameters: z.ZodObject): JsonSchema => {
  if (Object.keys(parameters.shape).length === 0) return { additionalProperties: true, properties: {}, type: "object" };
  const shaped = written(z.toJSONSchema(parameters, { io: "input" }));
  return isObject(shaped) ? shaped : {};
};

const shown = (all: Record<string, z.ZodObject>): Record<string, JsonSchema> =>
  Object.fromEntries(Object.entries(all).map(([op, p]) => [op, toolParameters(p)]));

/** As the model is shown them, by endpoint. */
export const schemas = shown(parameters);
const sessionSchemas = shown(sessionParameters);

export type Orchestrator<K extends keyof typeof parameters> = z.output<(typeof parameters)[K]>;

export type SessionInput<K extends keyof typeof sessionParameters> = z.output<(typeof sessionParameters)[K]>;

export interface Caller {
  /** The profile: an orchestrator's own id for an orchestrator. */
  readonly agent: string;
  /** The session working as agent, and the repo it works in; both empty for the orchestrator. */
  readonly session: string;
  readonly repo: string;
  /** The channel the orchestrator is answering. A session's default is its own issue thread, which the channel service knows. */
  readonly here: string;
  /** The profile the user picked for this input, if any: dispatch prefers it. */
  readonly picked: string;
  /** The ingress envelope currently being handled; empty when this run was not opened by one. */
  readonly envelope: string;
  /** Who calls, and on whose word: the services judge what it may do by it. */
  readonly actor: Actor;
}

export type Who = () => Caller;

/** A tool that will not do what it was asked: thrown, its message is what the model reads. */
export class ToolRefusal extends Error {
  override readonly name = "ToolRefusal";
}

export const refuse = (message: string): ToolRefusal => new ToolRefusal(message);

const toFailed = (e: unknown): ToolFailed =>
  e instanceof ToolFailed ? e : new ToolFailed(isApiError(e) ? reasonOf(e) : e instanceof z.ZodError ? problemOf(e) : messageOf(e), e);

export const said = (e: unknown) => toFailed(e).message;

export const callerOf = (who: Who): Caller => {
  try {
    return who();
  } catch (e) {
    throw new ToolRefusal(said(e), { cause: e });
  }
};

/** An answer, or the refusal prefix and why. */
export const answered = async (work: () => Promise<string>): Promise<string> => {
  try {
    return await work();
  } catch (e) {
    return answers.failed(said(e));
  }
};

// Who reads and speaks in a channel: a session as itself, the orchestrator as the orchestrator.
export const participant = (c: Caller) => c.session || c.agent;

type Body<A> = (input: A, signal?: AbortSignal) => string | Promise<string>;

/** A tool's run as one step of a turn: its input read by its Schema, its body run, what it threw as the failed result
 * the model reads. A stop is let through as itself. */
const toolRun =
  <A>(read: (args: unknown) => A, body: Body<A>) =>
  async (args: unknown, signal?: AbortSignal): Promise<string> => {
    try {
      return await body(read(args), signal);
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      throw toFailed(e);
    }
  };

// A tool's arguments are read by its Schema before it runs. the model's JSON Schema is made from the same one.
const toolOf =
  <All extends { readonly [op: string]: z.ZodObject }>(all: All, shown: Record<string, JsonSchema>, words: Record<keyof All & string, string>) =>
  <K extends keyof All & Op>(op: K, body: Body<z.output<All[K]>>) => {
    const schema: All[K] = all[op];
    const read = (args: unknown): z.output<All[K]> => schema.parse(args);
    return runTool({
      name: toolName(op),
      description: words[op],
      parameters: shown[op] ?? {},
      run: toolRun(read, body),
    });
  };

export const tool = toolOf(parameters, schemas, descriptions);
export const sessionSchemaTool = toolOf(sessionParameters, sessionSchemas, {
  ...sessionDescriptions,
  "issue.split": sessionDescriptions["issue.split"](maxTasks),
});

export const customTool = <S extends z.ZodObject>(name: string, description: string, parameters: S, body: Body<z.output<S>>) =>
  runTool({
    name,
    description,
    parameters: toolParameters(parameters),
    run: toolRun((args) => parameters.parse(args), body),
  });
