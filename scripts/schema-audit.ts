import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as T from "@vibevalley/protocol";

import { TriggerSourceValues } from "../apps/server/src/mailbox/shapes.ts";

const root = resolve(import.meta.dirname, "..");
const sqlPath = "apps/server/db/migrations/0001_schema.up.sql";
const boundaryDocs = "docs/subsystems/foundation.md#边界审计";

type ReviewCategory =
  | "inline-literals"
  | "inline-union"
  | "optional-enum"
  | "tool-downgrade"
  | "unbranded-id"
  | "db-schema-reuse"
  | "manual-enum-coercion"
  | "optional-collection-or-flag"
  | "subpackage-dual-shape"
  | "json-parse-review";

export interface Finding {
  readonly category: ReviewCategory | "db-enum-mismatch";
  readonly location: string;
  readonly detail: string;
}

const reviewAdvice: Record<ReviewCategory, string> = {
  "inline-literals": "check whether these words already have a shared enum before adding another definition",
  "inline-union": "check whether this union names a shared enum or only a local alternative",
  "optional-enum": "check whether omission has a meaning distinct from every enum member",
  "tool-downgrade": "trace the tool decoder; references and aliases may be strings until resolved at the boundary",
  "unbranded-id": "check whether this is an entity ID or an unresolved reference before choosing a branded type",
  "db-schema-reuse": "check whether storage and wire share the same value object; reuse is valid when they do",
  "manual-enum-coercion": "check whether the input is already decoded; keep reference resolution at its owning boundary",
  "optional-collection-or-flag": "check whether missing differs from empty or false, including patches and sparse wire payloads",
  "subpackage-dual-shape": "check whether a recursive or independent contract needs the annotation before deriving its type",
  "json-parse-review": "follow the unknown value to its contract decoder; parsing JSON is not itself a missing-validation defect",
};

export function formatFinding(finding: Finding): string {
  const advice =
    finding.category === "db-enum-mismatch"
      ? "Fix: align this column's CHECK with its named protocol enum; update the mapping only if the domain relationship changed"
      : `Review: ${reviewAdvice[finding.category]}`;
  return `${finding.category} at ${finding.location}: ${finding.detail}. ${advice}. See ${boundaryDocs}`;
}

export function isBoundaryViolation(finding: Finding): boolean {
  return finding.category === "db-enum-mismatch";
}

interface StoredEnum {
  readonly column: string;
  readonly protocol: string;
  readonly values: readonly string[];
}

const storedEnums: readonly StoredEnum[] = [
  { column: "channel.type", protocol: "ChannelTypeValues", values: T.ChannelTypeValues },
  { column: "channel.subject_kind", protocol: "SubjectKindValues", values: T.SubjectKindValues },
  { column: "channel.notify", protocol: "NotifyValues", values: T.NotifyValues },
  { column: "channel_message.kind", protocol: "MessageKindValues", values: T.MessageKindValues },
  { column: "issue.mandate_strength", protocol: "MandateStrengthValues", values: T.MandateStrengthValues },
  { column: "issue.priority", protocol: "PriorityValues", values: T.PriorityValues },
  { column: "issue.delivered", protocol: "DeliveryValues", values: T.DeliveryValues },
  { column: "issue.canceled", protocol: "IssueCanceledValues", values: T.IssueCanceledValues },
  { column: "issue.deliver", protocol: "DeliverableValues", values: T.DeliverableValues },
  { column: "session.role", protocol: "AgentRoleValues", values: T.AgentRoleValues },
  { column: "session.closed", protocol: "SessionCloseValues", values: T.SessionCloseValues },
  { column: "session_run.outcome", protocol: "OutcomeValues", values: T.OutcomeValues },
  { column: "mailbox_delivery.source", protocol: "TriggerSourceValues", values: TriggerSourceValues },
  { column: "cron.set_by", protocol: "ActorKindValues", values: T.ActorKindValues },
  { column: "memory.kind", protocol: "MemoryKindValues", values: T.MemoryKindValues },
  { column: "memory.author", protocol: "ActorKindValues", values: T.ActorKindValues },
  { column: "connector_account.connector", protocol: "ConnectorIDValues", values: T.ConnectorIDValues },
  { column: "artifact.body", protocol: "ArtifactBodyValues", values: T.ArtifactBodyValues },
  { column: "artifact_block.type", protocol: "BlockTypeValues", values: T.BlockTypeValues },
  { column: "artifact_suggestion.status", protocol: "SuggestionStatusValues", values: T.SuggestionStatusValues },
  { column: "pkm_comment.status", protocol: "PkmCommentStatusValues", values: T.PkmCommentStatusValues },
  // One table for every kind of media job: its phases are every kind's.
  {
    column: "media_job.phase",
    protocol: "MediaPhaseValues and MediaUnderstandingPhaseValues",
    values: [...new Set([...T.MediaUnderstandingPhaseValues, ...T.MediaPhaseValues])],
  },
  {
    column: "media_job.kind",
    protocol: "image, understanding, speech and MediaAudioKindValues",
    values: ["image", "understanding", "speech", ...T.MediaAudioKindValues],
  },
  { column: "media_job.result_format", protocol: "MediaAudioFormatValues", values: T.MediaAudioFormatValues },
];

// Preserve quoted words and line numbers; a CHECK in a comment is not a constraint.
const sqlWithoutComments = (sql: string) =>
  sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//gu, (part) => (part.startsWith("'") ? part : part.replace(/[^\n]/gu, " ")));

export function compareStoredEnums(sql: string, contracts: readonly StoredEnum[]): Finding[] {
  const source = sqlWithoutComments(sql);
  const tables = new Map([...source.matchAll(/\bcreate\s+table\s+(\w+)\s*\(([\s\S]*?)\)\s*;/giu)].map((match) => [match[1]!.toLowerCase(), match]));
  const findings: Finding[] = [];
  for (const contract of contracts) {
    const [table, column] = contract.column.split(".");
    const match = tables.get(table!);
    const body = match?.[2] ?? "";
    const declared = new RegExp(`(?:^|,)\\s*${column}\\s+text\\b`, "iu").test(body);
    const check = new RegExp(`\\bcheck\\s*\\(\\s*${column}\\s+in\\s*\\(\\s*((?:'(?:''|[^'])*'\\s*,?\\s*)+)\\)\\s*\\)`, "iu").exec(body);
    const actual = new Set([...(check?.[1] ?? "").matchAll(/'((?:''|[^'])*)'/gu)].map((word) => word[1]!.replaceAll("''", "'")));
    const expected = new Set(contract.values);
    const missing = [...expected].filter((word) => !actual.has(word));
    const extra = [...actual].filter((word) => !expected.has(word));
    if (declared && check && missing.length === 0 && extra.length === 0) continue;
    const reason = !declared
      ? "missing text column"
      : !check
        ? "missing literal IN CHECK"
        : `missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`;
    findings.push({
      category: "db-enum-mismatch",
      location: `${sqlPath}:${source.slice(0, match?.index ?? 0).split("\n").length}`,
      detail: `${contract.column} ↔ ${contract.protocol}: ${reason}`,
    });
  }
  return findings;
}

export function reviewSchemaSources(sources: ReadonlyMap<string, string>): Finding[] {
  const findings: Finding[] = [];
  const enumNames = new Set<string>(["Locale", "Voice", "Area", "Language", "Model"]);
  for (const [path, source] of sources) {
    if (!path.startsWith("packages/protocol/src/") || !path.endsWith("shapes.ts")) continue;
    for (const match of source.matchAll(/export const (\w+)Values\s*=/gu)) enumNames.add(match[1]!);
  }

  for (const [path, source] of sources) {
    const addMatches = (category: ReviewCategory, pattern: RegExp) => {
      for (const match of source.matchAll(pattern)) {
        findings.push({ category, location: `${path}:${source.slice(0, match.index).split("\n").length}`, detail: match[0].replace(/\s+/gu, " ") });
      }
    };
    if (path.startsWith("packages/protocol/src/") || path.startsWith("apps/server/src/"))
      addMatches("inline-literals", /Schema\s*\.\s*Literals\s*\(\s*\[[^\]]+\]/gu);
    if (path.startsWith("packages/protocol/src/") && path.endsWith("shapes.ts")) addMatches("inline-union", /:\s*"[^"]+"\s*\|\s*"[^"]+"/gu);
    if (path.startsWith("apps/server/src/")) {
      addMatches("db-schema-reuse", /\bjson(?:OrNone|Of)\s*\(\s*S\.\w+/gu);
      addMatches("manual-enum-coercion", /\b(?:statusOf|priorityOf|\w+Values\s*\.\s*(?:find|includes))\s*\(/gu);
    }
    addMatches("json-parse-review", /\bJSON\s*\.\s*parse\s*\(/gu);
    if (!path.startsWith("packages/protocol/") && !source.includes("Schema.suspend("))
      addMatches("subpackage-dual-shape", /\bconst\s+\w+Schema\s*:\s*Schema\.Codec<\w+>/gu);
    if (path === "apps/server/src/tool/schemas.ts")
      addMatches("tool-downgrade", /\b(?:priority|status|deliver|tier|afterBlock|parentId)\s*:\s*(?:Schema\.optionalKey\s*\(\s*)?Schema\.String/gu);

    if (!path.startsWith("packages/protocol/src/") || !path.endsWith("shapes.ts")) continue;
    let currentInterface = "";
    for (const [index, line] of source.split("\n").entries()) {
      const declaration = /^export interface (\w+)/u.exec(line);
      if (declaration) currentInterface = declaration[1]!;
      if (line.startsWith("}")) currentInterface = "";
      if (!currentInterface) continue;
      const add = (category: ReviewCategory) => findings.push({ category, location: `${path}:${index + 1}`, detail: `${currentInterface}: ${line.trim()}` });
      const optional = /^\s*(?:readonly\s+)?\w+\?:\s*([A-Za-z0-9_]+)\s*;/u.exec(line);
      const patch = /(?:Update|Filter|Options|Patch|Draft|Meta|Context|Request|Input|Edit)$/u.test(currentInterface);
      if (!patch && optional && enumNames.has(optional[1]!)) add("optional-enum");
      if (
        !currentInterface.endsWith("Request") &&
        /^\s*(?:readonly\s+)?(?:issue|issueId|blockedBy|session|sessionId|artifact|artifactId|blockId|messageId|suggestionId)\??:\s*(?:readonly\s+)?string(?:\[\])?\s*;/u.test(
          line,
        )
      )
        add("unbranded-id");
      if (!patch && /^\s*(?:readonly\s+)?\w+\?:\s*(?:boolean|(?:readonly\s+)?[A-Za-z0-9_<>[\]]+\[\])\s*;/u.test(line)) add("optional-collection-or-flag");
    }
  }
  return findings;
}

export function scanSchemaBoundaries(): Finding[] {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "packages/**/*.ts", "apps/**/*.ts", "apps/**/*.tsx"],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(
      (path) =>
        path !== "" &&
        !/\.(?:test|spec|stories)\.tsx?$/u.test(path) &&
        !path.includes("/testdata/") &&
        !path.includes("/generated/") &&
        !path.includes("/testing/") &&
        !path.includes("/test/") &&
        !path.endsWith("testing.ts") &&
        existsSync(resolve(root, path)),
    );
  const sources = new Map([...new Set(files)].toSorted().map((path) => [path, readFileSync(resolve(root, path), "utf8")]));
  return [...reviewSchemaSources(sources), ...compareStoredEnums(readFileSync(resolve(root, sqlPath), "utf8"), storedEnums)];
}

if (import.meta.main) {
  const findings = scanSchemaBoundaries();
  for (const finding of findings) console.log(`[${isBoundaryViolation(finding) ? "error" : "review"}] ${formatFinding(finding)}`);
  const errors = findings.filter(isBoundaryViolation).length;
  console.log(`\nschema-audit: ${errors} contract errors, ${findings.length - errors} review hints (not a validation-coverage proof)`);
  if (errors > 0) process.exitCode = 1;
}
