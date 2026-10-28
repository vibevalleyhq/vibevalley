// The model is shown these bytes: change a Schema only on purpose, with the orchestrator's evals replayed; tool.test.ts
// holds every one to the bytes it was last given, and each tool's fields to its endpoint's. Unknown fields are let
// through. requiredOrder is the order the required fields are listed in, and a struct that refuses fields it does not
// know (parseOptions) says so in the JSON Schema too (additionalProperties false).

import { Schema } from "effect";
import type { Handlers } from "@vibevalley/protocol/api";
import type { JsonSchema } from "@vibevalley/ai/tools";
import { params } from "./prompts.ts";

/** A tool is an endpoint as a model sees it: its name is the endpoint's (toolName), its fields are the endpoint's. */
export type Op = keyof Handlers;

/** channel.message.send is channel_message_send, issue.status.update is issue_status_update. */
export const toolName = (op: Op) =>
  op
    .split(".")
    .map((w) => w.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()))
    .join("_");

/** Fields a tool takes that its endpoint does not, which only a model has a use for; tool.test.ts lets these through. */
export const agentOnly: Partial<Record<Op, readonly string[]>> = {
  // A helper's words wait while what it has not seen is shown to it, or a thread's reader is sure it means the channel's top.
  "channel.message.send": ["anyway", "confirm"],
  // An agent reads what is new to it; a page reads pages of a channel.
  "channel.message.list": ["unread"],
  // Written down and sent, or drafted by a helper, in one call, from the channel being answered or the one named.
  "issue.create": ["start", "draft", "channel"],
};

const channelRead = Schema.Struct({
  before: Schema.optionalKey(Schema.Finite),
  id: Schema.optionalKey(Schema.String.annotate({ description: params.channelMessageList.id })),
  limit: Schema.optionalKey(Schema.Finite),
  unread: Schema.optionalKey(Schema.Boolean),
});

/** The orchestrator's, by endpoint. */
export const parameters = {
  "channel.create": Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    name: Schema.String,
    project: Schema.optionalKey(Schema.String),
  }),
  "channel.list": Schema.Struct({}),
  "channel.message.list": channelRead,
  "channel.update": Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    id: Schema.String.annotate({ description: params.channelRef }),
    project: Schema.optionalKey(Schema.String),
  }),
  "graph.act": Schema.Struct({
    action: Schema.Literals(["start", "pause", "resume", "abandon", "merge"]),
    id: Schema.String.annotate({ description: params.planId }),
  }).annotate({ requiredOrder: ["id", "action"] }),
  "graph.get": Schema.Struct({
    id: Schema.String.annotate({ description: params.planId }),
  }),
  "graph.list": Schema.Struct({}),
  "graph.split": Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.graphSplit.agent })),
    goal: Schema.String.annotate({ description: params.graphSplit.goal }),
    project: Schema.String.annotate({ description: params.projectFolder }),
  }),
  "graph.task.act": Schema.Struct({
    action: Schema.Literals(["retry", "skip"]),
    id: Schema.String.annotate({ description: params.planId }),
    task: Schema.String.annotate({ description: params.graphTask.task }),
  }).annotate({ requiredOrder: ["id", "task", "action"] }),
  "graph.task.delete": Schema.Struct({
    id: Schema.String.annotate({ description: params.planId }),
    task: Schema.String.annotate({ description: params.graphTask.task }),
  }).annotate({ requiredOrder: ["id", "task"] }),
  "graph.task.update": Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.graphTask.agent })),
    brief: Schema.optionalKey(Schema.String.annotate({ description: params.graphTask.brief })),
    check: Schema.optionalKey(Schema.String.annotate({ description: params.graphTask.check })),
    id: Schema.String.annotate({ description: params.planId }),
    needs: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)).annotate({ description: params.graphTask.needs })),
    task: Schema.String.annotate({ description: params.graphTask.newTask }),
    title: Schema.optionalKey(Schema.String),
  }).annotate({ requiredOrder: ["id", "task"] }),
  "issue.comment.create": Schema.Struct({
    id: Schema.String.annotate({ description: params.issueOrAgent }),
    text: Schema.String.annotate({ description: params.issueComment.text }),
  }).annotate({ requiredOrder: ["id", "text"] }),
  "issue.create": Schema.Struct({
    assignee: Schema.optionalKey(Schema.String.annotate({ description: params.issueCreate.assignee })),
    channel: Schema.optionalKey(Schema.String.annotate({ description: params.issueCreate.channel })),
    deliver: Schema.optionalKey(
      Schema.Literals(["change", "branch", "answer"]).annotate({
        description: params.issueCreate.deliver,
      }),
    ),
    description: Schema.optionalKey(Schema.String.annotate({ description: params.issueCreate.description })),
    draft: Schema.optionalKey(Schema.Boolean.annotate({ description: params.issueCreate.draft })),
    priority: Schema.optionalKey(Schema.String.annotate({ description: params.issueCreate.priority })),
    project: Schema.optionalKey(Schema.String.annotate({ description: params.issueCreate.project })),
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
    project: Schema.optionalKey(Schema.String.annotate({ description: params.issueList.project })),
    status: Schema.optionalKey(Schema.String.annotate({ description: params.issueList.status })),
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
    assignee: Schema.optionalKey(Schema.String.annotate({ description: params.issueStatus.assignee })),
    id: Schema.String.annotate({ description: params.issueNumber }),
    status: Schema.String.annotate({ description: params.issueStatus.status }),
    text: Schema.optionalKey(Schema.String.annotate({ description: params.issueStatus.text })),
  }).annotate({ requiredOrder: ["id", "status"] }),
  "issue.update": Schema.Struct({
    assignee: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.assignee })),
    criteria: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)).annotate({ description: params.issueUpdate.criteria })),
    deliver: Schema.optionalKey(Schema.Literals(["change", "branch", "answer"]).annotate({ description: params.issueUpdate.deliver })),
    description: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.description })),
    id: Schema.String.annotate({ description: params.issueNumber }),
    priority: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.priority })),
    project: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.project })),
    title: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.title })),
  }),
  "memory.create": Schema.Struct({
    agent: Schema.String.annotate({ description: params.agentProfile }),
    project: Schema.optionalKey(Schema.String.annotate({ description: params.memoryCreate.project })),
    text: Schema.String.annotate({ description: params.memoryCreate.text }),
  }),
  "memory.search": Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.agentProfile })),
    project: Schema.optionalKey(Schema.String.annotate({ description: params.projectFolder })),
    text: Schema.optionalKey(Schema.String.annotate({ description: params.searchText })),
  }),
  "project.list": Schema.Struct({}),
  "cron.create": Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.cron.agent })),
    channel: Schema.optionalKey(Schema.String.annotate({ description: params.cron.channel })),
    name: Schema.String.annotate({ description: params.cron.name }),
    project: Schema.optionalKey(Schema.String.annotate({ description: params.cron.project })),
    text: Schema.String.annotate({ description: params.cron.text }),
    tz: Schema.optionalKey(Schema.String.annotate({ description: params.cron.tz })),
    when: Schema.Struct({
      at: Schema.optionalKey(Schema.String.annotate({ description: params.cron.at })),
      days: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Finite))),
      expr: Schema.optionalKey(Schema.String.annotate({ description: params.cron.expr })),
      kind: Schema.Literals(["once", "every", "daily", "weekly", "cron"]),
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
  "channel.message.list": channelRead,
  "channel.message.send": Schema.Struct({
    anyway: Schema.optionalKey(Schema.Boolean.annotate({ description: params.channelMessageSend.anyway })),
    confirm: Schema.optionalKey(Schema.Boolean.annotate({ description: params.channelMessageSend.confirm })),
    id: Schema.optionalKey(Schema.String),
    replyTo: Schema.optionalKey(Schema.Int.annotate({ description: params.channelMessageSend.replyTo })),
    text: Schema.String,
  }),
  "channel.unread.list": Schema.Struct({}),
  "doc.block.create": Schema.Struct({
    id: Schema.String.annotate({ description: params.docId }),
    level: Schema.optionalKey(Schema.Int.annotate({ description: params.docBlockCreate.level })),
    text: Schema.String.annotate({ description: params.docBlockCreate.text }),
    type: Schema.optionalKey(Schema.String.annotate({ description: params.docBlockCreate.type })),
  }),
  "doc.block.update": Schema.Struct({
    baseRev: Schema.Int.annotate({ description: params.docBlockUpdate.baseRev }),
    block: Schema.String.annotate({ description: params.docBlockUpdate.block }),
    id: Schema.String.annotate({ description: params.docId }),
    text: Schema.String.annotate({ description: params.docBlockUpdate.text }),
  }).annotate({ requiredOrder: ["id", "block", "baseRev", "text"] }),
  "doc.get": Schema.Struct({
    id: Schema.String.annotate({ description: params.docId }),
  }),
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
    project: Schema.optionalKey(Schema.String.annotate({ description: params.sessionMemory.createProject })),
    text: Schema.String.annotate({ description: params.sessionMemory.text }),
  }),
  "memory.search": Schema.Struct({
    project: Schema.optionalKey(Schema.String.annotate({ description: params.sessionMemory.searchProject })),
    text: Schema.optionalKey(Schema.String.annotate({ description: params.searchText })),
  }),
  "session.list": Schema.Struct({}),
};

const safe = Number.MAX_SAFE_INTEGER;

/** Effect's JSON Schema, reshaped to the bytes the tools have always been written as. */
const written = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(written);
  if (typeof node !== "object" || node === null) return node;
  let o = { ...(node as Record<string, unknown>) };
  const choices = o.anyOf;
  if (Array.isArray(choices) && choices.length === 2) {
    const [value, none] = choices as Record<string, unknown>[];
    if (none?.type === "null" && value) {
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
  if (o.parseOptions !== undefined) {
    if ((o.parseOptions as { onExcessProperty?: string }).onExcessProperty === "error") o.additionalProperties = false;
    delete o.parseOptions;
  }
  if (Array.isArray(o.required) && o.required.length === 0) delete o.required;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(o).sort()) {
    const value = o[key];
    out[key] =
      key === "properties" && typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value).map(([name, p]) => [name, written(p)]))
        : written(value);
  }
  return out;
};

export const toolParameters = (parameters: Schema.Struct<Schema.Struct.Fields>): JsonSchema =>
  Object.keys(parameters.fields).length === 0
    ? { additionalProperties: true, properties: {}, type: "object" }
    : (written(
        Schema.toJsonSchemaDocument(parameters, { includeAnnotationKey: (key) => key === "requiredOrder" || key === "parseOptions" }).schema,
      ) as JsonSchema);

const shown = <A extends Record<string, Schema.Struct<Schema.Struct.Fields>>>(all: A): Record<keyof A & string, JsonSchema> =>
  Object.fromEntries(Object.entries(all).map(([op, p]) => [op, toolParameters(p)])) as Record<keyof A & string, JsonSchema>;

/** As the model is shown them, by endpoint. */
export const schemas = shown(parameters);
export const sessionSchemas = shown(sessionParameters);
