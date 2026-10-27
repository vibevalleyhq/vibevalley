// The model is shown these bytes: change a Schema only on purpose, with the orchestrator's evals replayed; tool.test.ts
// holds every one to the bytes it has always had. Unknown fields are let through. requiredOrder is the order the required
// fields have always been listed in, and a struct that refuses fields it does not know (parseOptions) says so in the JSON
// Schema too (additionalProperties false).

import { Schema } from "effect";
import type { JsonSchema } from "../ai/tools.ts";
import { params } from "./prompts.ts";

/** The orchestrator's, by name; read_chat is a session's too. */
export const parameters = {
  accept: Schema.Struct({
    findings: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)).annotate({ description: params.accept.findings })),
    pass: Schema.Boolean.annotate({ description: params.accept.pass }),
    issue: Schema.String.annotate({ description: params.issueOrAgent }),
    text: Schema.optionalKey(Schema.String.annotate({ description: params.accept.text })),
  }).annotate({ requiredOrder: ["issue", "pass"] }),
  cancel_recurrence: Schema.Struct({
    id: Schema.String,
  }),
  changes: Schema.Struct({
    issue: Schema.String.annotate({ description: params.issueOrAgent }),
  }),
  channel_settings: Schema.Struct({
    channel: Schema.String,
    description: Schema.optionalKey(Schema.String),
    project: Schema.optionalKey(Schema.String),
  }),
  channels: Schema.Struct({}),
  check: Schema.Struct({
    issue: Schema.String.annotate({ description: params.issueOrAgent }),
  }),
  dismiss: Schema.Struct({
    issue: Schema.String.annotate({ description: params.issueOrAgent }),
  }),
  graph_action: Schema.Struct({
    action: Schema.Literals(["start", "pause", "resume", "abandon", "merge"]),
    graph: Schema.String.annotate({ description: params.planId }),
  }).annotate({ requiredOrder: ["graph", "action"] }),
  graph_split: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.graphSplit.agent })),
    goal: Schema.String.annotate({ description: params.graphSplit.goal }),
    project: Schema.String.annotate({ description: params.projectFolder }),
  }),
  graphs: Schema.Struct({
    id: Schema.optionalKey(Schema.String.annotate({ description: params.graphs.id })),
  }),
  issue_create: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.issueCreate.agent })),
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
  issue_status: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.issueStatus.agent })),
    issue: Schema.String.annotate({ description: params.issueNumber }),
    text: Schema.optionalKey(Schema.String.annotate({ description: params.issueStatus.text })),
    to: Schema.String.annotate({ description: params.issueStatus.to }),
  }),
  issue_update: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.agent })),
    criteria: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)).annotate({ description: params.issueUpdate.criteria })),
    deliver: Schema.optionalKey(Schema.Literals(["change", "branch", "answer"]).annotate({ description: params.issueUpdate.deliver })),
    description: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.description })),
    issue: Schema.String.annotate({ description: params.issueNumber }),
    priority: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.priority })),
    project: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.project })),
    title: Schema.optionalKey(Schema.String.annotate({ description: params.issueUpdate.title })),
  }),
  issues: Schema.Struct({
    closed: Schema.optionalKey(Schema.Boolean.annotate({ description: params.issues.closed })),
    issue: Schema.optionalKey(Schema.String.annotate({ description: params.issues.issue })),
    limit: Schema.optionalKey(Schema.Finite.annotate({ description: params.issues.limit })),
    project: Schema.optionalKey(Schema.String.annotate({ description: params.issues.project })),
    status: Schema.optionalKey(Schema.String.annotate({ description: params.issues.status })),
    text: Schema.optionalKey(Schema.String.annotate({ description: params.issues.text })),
    wants_owner: Schema.optionalKey(Schema.Boolean.annotate({ description: params.issues.wantsOwner })),
  }),
  list_recurrences: Schema.Struct({}),
  memory_add: Schema.Struct({
    agent: Schema.String.annotate({ description: params.agentProfile }),
    project: Schema.optionalKey(Schema.String.annotate({ description: params.memoryAdd.project })),
    text: Schema.String.annotate({ description: params.memoryAdd.text }),
  }),
  memory_search: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.agentProfile })),
    project: Schema.optionalKey(Schema.String.annotate({ description: params.projectFolder })),
    query: Schema.optionalKey(Schema.String.annotate({ description: params.searchQuery })),
  }),
  open_channel: Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    name: Schema.String,
    project: Schema.optionalKey(Schema.String),
  }),
  projects: Schema.Struct({}),
  read_chat: Schema.Struct({
    before: Schema.optionalKey(Schema.Finite),
    limit: Schema.optionalKey(Schema.Finite),
    target: Schema.optionalKey(Schema.String.annotate({ description: params.readChat.target })),
    unread: Schema.optionalKey(Schema.Boolean),
  }),
  roster: Schema.Struct({}),
  recurrence: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.recurrence.agent })),
    at: Schema.optionalKey(Schema.String),
    channel: Schema.optionalKey(Schema.String.annotate({ description: params.recurrence.channel })),
    cron: Schema.optionalKey(Schema.String.annotate({ description: params.recurrence.cron })),
    days: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Finite))),
    kind: Schema.Literals(["once", "every", "daily", "weekly", "cron"]),
    minutes: Schema.optionalKey(Schema.Finite),
    name: Schema.String.annotate({ description: params.recurrence.name }),
    project: Schema.optionalKey(Schema.String.annotate({ description: params.recurrence.project })),
    text: Schema.String.annotate({ description: params.recurrence.text }),
    time: Schema.optionalKey(Schema.String.annotate({ description: "HH:MM" })),
    tz: Schema.optionalKey(Schema.String.annotate({ description: params.recurrence.tz })),
  }).annotate({ requiredOrder: ["name", "text", "kind"] }),
  stop: Schema.Struct({
    issue: Schema.String.annotate({ description: params.issueOrAgent }),
  }),
  task_action: Schema.Struct({
    action: Schema.Literals(["retry", "skip"]),
    graph: Schema.String.annotate({ description: params.planId }),
    task: Schema.String.annotate({ description: params.taskAction.task }),
  }).annotate({ requiredOrder: ["graph", "task", "action"] }),
  task_edit: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.taskEdit.agent })),
    brief: Schema.optionalKey(Schema.String.annotate({ description: params.taskEdit.brief })),
    check: Schema.optionalKey(Schema.String.annotate({ description: params.taskEdit.check })),
    graph: Schema.String.annotate({ description: params.planId }),
    needs: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)).annotate({ description: params.taskEdit.needs })),
    remove: Schema.optionalKey(Schema.Boolean),
    task: Schema.String.annotate({ description: params.taskEdit.task }),
    title: Schema.optionalKey(Schema.String),
  }),
  tell: Schema.Struct({
    message: Schema.String.annotate({ description: params.tell.message }),
    issue: Schema.String.annotate({ description: params.issueOrAgent }),
  }).annotate({ requiredOrder: ["issue", "message"] }),
};

/** A session's own, where it differs from the orchestrator's of the same name. */
const sessionOwn = {
  memory_add: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: params.sessionMemoryAdd.agent })),
    all_projects: Schema.optionalKey(Schema.Boolean.annotate({ description: params.sessionMemoryAdd.allProjects })),
    text: Schema.String.annotate({ description: params.sessionMemoryAdd.text }),
  }),
  memory_search: Schema.Struct({
    all_projects: Schema.optionalKey(Schema.Boolean.annotate({ description: params.sessionMemorySearch.allProjects })),
    query: Schema.optionalKey(Schema.String.annotate({ description: params.searchQuery })),
  }),
  channel_inbox: Schema.Struct({}),
  channel_say: Schema.Struct({
    anyway: Schema.optionalKey(Schema.Boolean.annotate({ description: params.channelSay.anyway })),
    confirm: Schema.optionalKey(Schema.Boolean.annotate({ description: params.channelSay.confirm })),
    reply: Schema.optionalKey(Schema.Int.annotate({ description: params.channelSay.reply })),
    target: Schema.optionalKey(Schema.String),
    text: Schema.String,
  }),
  doc_append: Schema.Struct({
    doc: Schema.String.annotate({ description: params.docId }),
    level: Schema.optionalKey(Schema.Int.annotate({ description: params.docAppend.level })),
    text: Schema.String.annotate({ description: params.docAppend.text }),
    type: Schema.optionalKey(Schema.String.annotate({ description: params.docAppend.type })),
  }),
  doc_read: Schema.Struct({
    doc: Schema.String.annotate({ description: params.docId }),
  }),
  doc_update: Schema.Struct({
    base_rev: Schema.Int.annotate({ description: params.docUpdate.baseRev }),
    block: Schema.String.annotate({ description: params.docUpdate.block }),
    doc: Schema.String.annotate({ description: params.docId }),
    text: Schema.String.annotate({ description: params.docUpdate.text }),
  }).annotate({ requiredOrder: ["doc", "block", "base_rev", "text"] }),
  issue_split: Schema.Struct({
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
  session_list: Schema.Struct({}),
};

export const sessionParameters = { ...parameters, ...sessionOwn };

export type Parameters = typeof sessionParameters;

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
  Object.fromEntries(Object.entries(all).map(([name, p]) => [name, toolParameters(p)])) as Record<keyof A & string, JsonSchema>;

export const schemas = shown(parameters);

/** A session's: the orchestrator's, but where its own differs. */
export const sessionSchemas = shown(sessionParameters);
