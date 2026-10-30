import { t } from "@vibevalley/i18n";
import { Result, Schema, SchemaIssue } from "effect";
import { messageOf } from "@/errors.ts";
import type { Task } from "@vibevalley/protocol";

import { graphProblems } from "./graph.ts";

import { type StepDraft, freshTask } from "./editing.ts";
export type ParsedSplit = { readonly ok: true; readonly title?: string; readonly tasks: Task[] } | { readonly ok: false; readonly problems: string[] };

const taskBlock = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;

/** JSON as Go's decoder reads it; the words for one that does not read say what Go's would where they are the same failure. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (e) {
    const message = messageOf(e);
    throw new Error(body.trim() === "" || /end of JSON input/i.test(message) ? "unexpected end of JSON input" : message, { cause: e });
  }
}

const formatIssue = SchemaIssue.makeFormatterDefault();

const StepDraftSchema: Schema.Codec<StepDraft> = Schema.Struct({
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  brief: Schema.String,
  needs: Schema.optionalKey(Schema.Array(Schema.String)),
  agent: Schema.optionalKey(Schema.String),
  check: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.Array(Schema.String)),
  acceptance: Schema.optionalKey(Schema.Boolean),
});

/** Optional fields may be missing but never null; other keys are ignored. */
const SplitDraft = Schema.Struct({ title: Schema.optionalKey(Schema.String), tasks: Schema.Array(StepDraftSchema) });

/** The first thing wrong with a split, in the words the model is answered with: where it is (["tasks"][0]["brief"]) and
 * what it should have been. */
function splitProblem(issue: SchemaIssue.Issue, path: readonly PropertyKey[] = []): string {
  const at = path.map((k) => (typeof k === "number" ? `[${k}]` : `["${String(k)}"]`)).join("");
  switch (issue._tag) {
    case "Pointer":
      return splitProblem(issue.issue, [...path, ...issue.path]);
    case "Composite":
      return splitProblem(issue.issues[0], path);
    case "MissingKey":
      return t("server.task.parse.missing", { at });
    case "InvalidType":
      switch (issue.ast._tag) {
        case "String":
          return t("server.task.parse.string", { at });
        case "Arrays":
          return t("server.task.parse.array", { at });
        case "Boolean":
          return t("server.task.parse.boolean", { at });
        case "Objects":
          return path.length === 0 ? t("server.task.parse.object") : t("server.task.parse.stepObject", { at });
        default:
          return t("server.task.parse.shape", { why: formatIssue(issue) });
      }
    default:
      return t("server.task.parse.shape", { why: formatIssue(issue) });
  }
}

function decodeSplitDraft(raw: unknown): { title?: string; tasks: readonly StepDraft[] } | string {
  const r = Schema.decodeUnknownResult(SplitDraft)(raw);
  return Result.isSuccess(r) ? r.success : splitProblem(r.failure.issue);
}

export function parseSplit(text: string): ParsedSplit {
  const blocks = [...text.matchAll(taskBlock)].map((m) => m[1]!);
  if (blocks.length === 0) return { ok: false, problems: [t("server.task.parse.noBlock")] };
  let last = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    let raw: unknown;
    try {
      raw = parseJson(blocks[i]!);
    } catch (e) {
      last = t("server.task.parse.unreadable", { why: messageOf(e) });
      continue;
    }
    const draft = decodeSplitDraft(raw);
    if (typeof draft === "string") {
      last = t("server.task.parse.shape", { why: draft });
      continue;
    }
    const tasks = draft.tasks.map(freshTask);
    const problems = graphProblems(tasks);
    if (problems.length > 0) return { ok: false, problems };
    const title = (draft.title ?? "").trim();
    return { ok: true, title: title, tasks };
  }
  return { ok: false, problems: [last] };
}
