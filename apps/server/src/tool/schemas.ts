// The model is shown these bytes: change a Schema only on purpose, with the orchestrator's evals replayed; tool.test.ts
// holds every one to the bytes it has always had. Unknown fields are let through. requiredOrder is the order the required
// fields have always been listed in, and a struct that refuses fields it does not know (parseOptions) says so in the JSON
// Schema too (additionalProperties false).

import { Schema } from "effect";
import type { Schema as JsonSchema } from "../agent/brain/tool.ts";

/** The orchestrator's, by name; read_chat is a session's too. */
export const parameters = {
  accept: Schema.Struct({
    findings: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)).annotate({ description: "没过时，每条要修的一句话" })),
    pass: Schema.Boolean.annotate({ description: "验收过了就是 true" }),
    issue: Schema.String.annotate({ description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字" }),
    text: Schema.optionalKey(Schema.String.annotate({ description: "没过时，还要交代的话" })),
  }).annotate({ requiredOrder: ["issue", "pass"] }),
  cancel_recurrence: Schema.Struct({
    id: Schema.String,
  }),
  changes: Schema.Struct({
    issue: Schema.String.annotate({ description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字" }),
  }),
  channel_settings: Schema.Struct({
    channel: Schema.String,
    description: Schema.optionalKey(Schema.String),
    project: Schema.optionalKey(Schema.String),
  }),
  channels: Schema.Struct({}),
  check: Schema.Struct({
    issue: Schema.String.annotate({ description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字" }),
  }),
  dismiss: Schema.Struct({
    issue: Schema.String.annotate({ description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字" }),
  }),
  graph_action: Schema.Struct({
    action: Schema.Literals(["start", "pause", "resume", "abandon", "merge"]),
    graph: Schema.String.annotate({ description: "计划 id" }),
  }).annotate({ requiredOrder: ["graph", "action"] }),
  graph_split: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: "让谁来拆：帮工名字或 id；不填按规则挑" })),
    goal: Schema.String.annotate({ description: "要做的事，照主人的原话" }),
    project: Schema.String.annotate({ description: "项目文件夹名" }),
  }),
  graphs: Schema.Struct({
    id: Schema.optionalKey(Schema.String.annotate({ description: "计划 id，比如 p1；不填列出所有还没合进主分支的" })),
  }),
  issue_create: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: "谁来做：帮工的名字、id 或 runtime；不填，开工时按挑帮工的规则挑" })),
    channel: Schema.optionalKey(Schema.String.annotate({ description: "工单串开在哪个频道，比如 #clock-in；不填就是你正在回话的频道" })),
    deliver: Schema.optionalKey(
      Schema.Literals(["change", "answer"]).annotate({
        description:
          "交付什么：change 是改代码、合进项目（不填就是它）；answer 是只查清楚、交回一份带依据的结论，不改代码（「查一下」「看看为什么」「是不是」）",
      }),
    ),
    description: Schema.optionalKey(Schema.String.annotate({ description: "说明：主人说的原话和你补的背景；主人没说的写成建议或待定，不写成要求" })),
    draft: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "要不要让帮工读过代码起草（写成标题、说明、验收标准）；会花钱，主人只是随口记一句时不用" }),
    ),
    priority: Schema.optionalKey(Schema.String.annotate({ description: "紧急、高、普通、低；不填是普通" })),
    project: Schema.optionalKey(Schema.String.annotate({ description: "项目文件夹名；频道有默认项目时可以不填；新项目起一个简短的英文名，开工时会新建" })),
    start: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "记下就开工（没空位就排队）：只在主人要马上做时填 true；记一下、先别开始、只是指派都不填" }),
    ),
    title: Schema.String.annotate({ description: "一句话的标题" }),
  }),
  issue_status: Schema.Struct({
    agent: Schema.optionalKey(
      Schema.String.annotate({ description: "挪到待办时谁来做：填另一个帮工的名字、id 或 runtime 就是换人接手，上一个收工、分支留着" }),
    ),
    issue: Schema.String.annotate({ description: "工单编号（#41 或 41）" }),
    keep_branch: Schema.optionalKey(Schema.Boolean.annotate({ description: "挪到已完成时：完成，但分支留着不合（主人说「先别合」「分支留着」时）" })),
    text: Schema.optionalKey(Schema.String.annotate({ description: "带给帮工的一句话：从等你看挪回待办（再干一轮）、重开时必填；换人时写接手的接着做什么" })),
    to: Schema.String.annotate({ description: "挪到：备选、待办、已完成、已取消" }),
  }),
  issue_update: Schema.Struct({
    acceptance: Schema.optionalKey(Schema.String.annotate({ description: "验收方式：glance（完成就算验收）或 required（先验收通过才能完成）" })),
    agent: Schema.optionalKey(Schema.String.annotate({ description: "谁来做：帮工的名字或 id（派出去以前才能改）" })),
    criteria: Schema.optionalKey(
      Schema.mutable(Schema.Array(Schema.String)).annotate({ description: "验收标准，一条一个主人能照着验的点；给空列表就是清掉（派出去以前才能改）" }),
    ),
    description: Schema.optionalKey(Schema.String.annotate({ description: "说明（派出去以前才能改）" })),
    issue: Schema.String.annotate({ description: "工单编号（#41 或 41）" }),
    priority: Schema.optionalKey(Schema.String.annotate({ description: "紧急、高、普通、低" })),
    project: Schema.optionalKey(Schema.String.annotate({ description: "项目（派出去以前才能改）" })),
    title: Schema.optionalKey(Schema.String.annotate({ description: "标题（派出去以前才能改）" })),
  }),
  issues: Schema.Struct({
    closed: Schema.optionalKey(Schema.Boolean.annotate({ description: "也列关上的（已完成、已取消）；不填只列开着的" })),
    issue: Schema.optionalKey(Schema.String.annotate({ description: "看一张的全部：工单编号（#41 或 41）；填了它别的条件都不看" })),
    limit: Schema.optionalKey(Schema.Finite.annotate({ description: "最多列几张，默认 20" })),
    project: Schema.optionalKey(Schema.String.annotate({ description: "只看这个项目的" })),
    status: Schema.optionalKey(Schema.String.annotate({ description: "只看这个状态的：备选、待办、处理中、等你看、已完成、已取消" })),
    text: Schema.optionalKey(Schema.String.annotate({ description: "标题或说明里有这些字的（找重复、找某件事时用）" })),
    wants_owner: Schema.optionalKey(Schema.Boolean.annotate({ description: "只看在等主人的：等回答、等验收、卡住了；按等了多久排，久的在前" })),
  }),
  list_recurrences: Schema.Struct({}),
  memory_add: Schema.Struct({
    agent: Schema.String.annotate({ description: "帮工档案的名字或 id" }),
    project: Schema.optionalKey(Schema.String.annotate({ description: "只在这个项目里用：项目文件夹名" })),
    text: Schema.String.annotate({ description: "要它记住的一句话" }),
  }),
  memory_search: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: "帮工档案的名字或 id" })),
    project: Schema.optionalKey(Schema.String.annotate({ description: "项目文件夹名" })),
    query: Schema.optionalKey(Schema.String.annotate({ description: "要找什么，几个词或一句话；不填就列出最新的" })),
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
    target: Schema.optionalKey(Schema.String.annotate({ description: "#田头、#clock-in，或 #田头:<消息号>" })),
    unread: Schema.optionalKey(Schema.Boolean),
  }),
  roster: Schema.Struct({}),
  recurrence: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: "直接派给哪个帮工档案（名字或 id）；不填就是到点交给你" })),
    at: Schema.optionalKey(Schema.String),
    channel: Schema.optionalKey(Schema.String.annotate({ description: "在哪个频道，比如 #clock-in；不填是你正在回话的频道" })),
    cron: Schema.optionalKey(Schema.String.annotate({ description: "五段 cron：分 时 日 月 周几" })),
    days: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Finite))),
    kind: Schema.Literals(["once", "every", "daily", "weekly", "cron"]),
    minutes: Schema.optionalKey(Schema.Finite),
    name: Schema.String.annotate({ description: "简短的名字，比如 每日测试" }),
    project: Schema.optionalKey(Schema.String.annotate({ description: "直接派活时的项目；不填用频道的默认项目" })),
    text: Schema.String.annotate({ description: "到点时说的话：要做的事" }),
    time: Schema.optionalKey(Schema.String.annotate({ description: "HH:MM" })),
    tz: Schema.optionalKey(Schema.String.annotate({ description: "时区，比如 Asia/Shanghai；不填是这台电脑的" })),
  }).annotate({ requiredOrder: ["name", "text", "kind"] }),
  stop: Schema.Struct({
    issue: Schema.String.annotate({ description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字" }),
  }),
  task_action: Schema.Struct({
    action: Schema.Literals(["retry", "skip"]),
    graph: Schema.String.annotate({ description: "计划 id" }),
    task: Schema.String.annotate({ description: "这件的 id" }),
  }).annotate({ requiredOrder: ["graph", "task", "action"] }),
  task_edit: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: "帮工档案 id；空字符串表示按规则挑" })),
    brief: Schema.optionalKey(Schema.String.annotate({ description: "工单" })),
    check: Schema.optionalKey(Schema.String.annotate({ description: "做完跑的检查命令；空字符串表示不跑" })),
    graph: Schema.String.annotate({ description: "计划 id" }),
    needs: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)).annotate({ description: "要等哪几件做完" })),
    remove: Schema.optionalKey(Schema.Boolean),
    task: Schema.String.annotate({ description: "这件的 id（新加的就起一个简短的英文 id）" }),
    title: Schema.optionalKey(Schema.String),
  }),
  tell: Schema.Struct({
    message: Schema.String.annotate({ description: "要带的话" }),
    issue: Schema.String.annotate({ description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字" }),
  }).annotate({ requiredOrder: ["issue", "message"] }),
};

/** A session's own, where it differs from the orchestrator's of the same name. */
const sessionOwn = {
  memory_add: Schema.Struct({
    agent: Schema.optionalKey(Schema.String.annotate({ description: "不用填：只能记进你自己的档案" })),
    all_projects: Schema.optionalKey(Schema.Boolean.annotate({ description: "所有项目都用得上，不只是这个项目" })),
    text: Schema.String.annotate({ description: "一句以后还用得上的话：约定、坑、命令" }),
  }),
  memory_search: Schema.Struct({
    all_projects: Schema.optionalKey(Schema.Boolean.annotate({ description: "也找别的项目里记下的" })),
    query: Schema.optionalKey(Schema.String.annotate({ description: "要找什么，几个词或一句话；不填就列出最新的" })),
  }),
  channel_inbox: Schema.Struct({}),
  channel_say: Schema.Struct({
    anyway: Schema.optionalKey(Schema.Boolean.annotate({ description: "看过新消息、仍要原样发" })),
    confirm: Schema.optionalKey(Schema.Boolean.annotate({ description: "确实要发到田头顶层，而不是刚读的那个串" })),
    target: Schema.optionalKey(Schema.String),
    text: Schema.String,
  }),
  doc_append: Schema.Struct({
    doc: Schema.String.annotate({ description: "文档的 id" }),
    level: Schema.optionalKey(Schema.Int.annotate({ description: "标题的级别 1–3，只给 heading 用；默认 2" })),
    text: Schema.String.annotate({ description: "这一块的字；可以用 **粗**、_斜_、行内代码、~~删~~ 和链接；代码块照原样存" }),
    type: Schema.optionalKey(Schema.String.annotate({ description: "块的类型：paragraph（默认）、heading、bulleted、numbered、todo、quote、code" })),
  }),
  doc_read: Schema.Struct({
    doc: Schema.String.annotate({ description: "文档的 id" }),
  }),
  doc_update: Schema.Struct({
    base_rev: Schema.Int.annotate({ description: "你读到或写下这一块时它是第几版" }),
    block: Schema.String.annotate({ description: "块的 id" }),
    doc: Schema.String.annotate({ description: "文档的 id" }),
    text: Schema.String.annotate({ description: "这一块完整的新字，不是增量" }),
  }).annotate({ requiredOrder: ["doc", "block", "base_rev", "text"] }),
  issue_split: Schema.Struct({
    tasks: Schema.mutable(
      Schema.Array(
        Schema.Struct({
          acceptance: Schema.optionalKey(Schema.Boolean.annotate({ description: "这张只写现在会失败的测试，别的都等它，合进去以后冻结" })),
          agent: Schema.optionalKey(Schema.String.annotate({ description: "帮工档案 id；不填按规则挑" })),
          brief: Schema.String.annotate({ description: "这张子工单：目标、改哪里、做到什么算完、留给后面的步骤什么；做它的帮工只看得到它和前面步骤的结论" }),
          check: Schema.optionalKey(Schema.String.annotate({ description: "做完在它的分支上跑的检查命令，比如 go test ./..." })),
          id: Schema.String.annotate({ description: "简短的英文小写 id，比如 schema、api" }),
          needs: Schema.optionalKey(
            Schema.NullOr(Schema.mutable(Schema.Array(Schema.String))).annotate({ description: "要等哪几张做完（填 id）；不互相依赖的会同时做" }),
          ),
          scope: Schema.optionalKey(
            Schema.NullOr(Schema.mutable(Schema.Array(Schema.String))).annotate({ description: "它要改的文件或目录；同时做的几张尽量不重叠" }),
          ),
          title: Schema.optionalKey(Schema.String),
        }).annotate({ requiredOrder: ["id", "brief"], parseOptions: { onExcessProperty: "error" } }),
      ),
    ).annotate({ description: "子工单，每张一个帮工在自己的分支上做完、提交、单独验证" }),
    title: Schema.optionalKey(Schema.String.annotate({ description: "拆完的计划叫什么；不填照工单的标题" })),
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
