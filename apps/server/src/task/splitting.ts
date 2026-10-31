import { Result, Schema, SchemaIssue } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { TaskDraft } from "@vibevalley/protocol/schema";

import { lastJsonBlock } from "@/base/json.ts";
import { messageOf } from "@/errors.ts";

import { freshTask } from "./editing.ts";
import { graphProblems } from "./graph.ts";
export type ParsedSplit = { readonly ok: true; readonly title?: string; readonly tasks: T.Task[] } | { readonly ok: false; readonly problems: string[] };

/** The words for JSON that does not read say what Go's decoder would where they are the same failure. */
function unparsedJson(e: unknown): string {
  const message = messageOf(e);
  return /end of JSON input/iu.test(message) ? "unexpected end of JSON input" : message;
}

const formatIssue = SchemaIssue.makeFormatterDefault();

/** Optional fields may be missing but never null; other keys are ignored. */
const SplitDraft = Schema.Struct({ title: Schema.optionalKey(Schema.String), tasks: Schema.Array(TaskDraft) });

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

export function parseSplit(text: string): ParsedSplit {
  const read = lastJsonBlock(text, SplitDraft, {
    none: t("server.task.parse.noBlock"),
    unparsed: (e) => t("server.task.parse.unreadable", { why: unparsedJson(e) }),
    misfit: (issue) => t("server.task.parse.shape", { why: splitProblem(issue) }),
  });
  if (Result.isFailure(read)) return { ok: false, problems: [read.failure] };
  const tasks = read.success.tasks.map(freshTask);
  const problems = graphProblems(tasks);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, title: (read.success.title ?? "").trim(), tasks };
}
