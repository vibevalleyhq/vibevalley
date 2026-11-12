import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as T from "@vibevalley/protocol";

const root = resolve(import.meta.dirname, "../..");

/** Read as text: a script may not import the server's files by path (no-cross-package-path), and the server does not export them. */
const serverLiterals = (file: string, name: string): readonly string[] => {
  const source = readFileSync(resolve(root, file), "utf8");
  const list = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`, "u").exec(source)?.[1];
  if (list === undefined) throw new Error(`${file} no longer declares ${name} as a literal array`);
  return [...list.matchAll(/\x22([^\x22]*)\x22/gu)].map((m) => m[1] ?? "");
};
const TriggerSourceValues = serverLiterals("apps/server/src/modules/session/shapes.ts", "TriggerSourceValues");
const sqlPath = "apps/server/db/migrations/0001_schema.up.sql";
const boundaryDocs = "docs/subsystems/foundation.md#边界审计";

type ReviewCategory =
  | "inline-literals"
  | "inline-union"
  | "optional-enum"
  | "tool-downgrade"
  | "db-schema-reuse"
  | "manual-enum-coercion"
  | "optional-collection-or-flag"
  | "subpackage-dual-shape"
  | "json-parse-review";

export interface Finding {
  readonly category: ReviewCategory | "db-enum-mismatch" | "secret-exposure" | "unbranded-id" | "bizcode-registry";
  readonly location: string;
  readonly detail: string;
}

const reviewAdvice: Record<ReviewCategory, string> = {
  "inline-literals": "check whether these words already have a shared enum before adding another definition",
  "inline-union": "check whether this union names a shared enum or only a local alternative",
  "optional-enum": "check whether omission has a meaning distinct from every enum member",
  "tool-downgrade": "trace the tool decoder; references and aliases may be strings until resolved at the boundary",
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
      : finding.category === "secret-exposure"
        ? "Fix: keep a secret a `Secret` (secretOf(...)) on the way out: the protocol never calls `.reveal()`, and `Secret` keeps a `toJSON` that throws and a `toString` that prints [secret]"
        : finding.category === "unbranded-id"
          ? "Fix: use the branded entity ID (`IssueId`, `SessionId`, `ArtifactId`, `BlockId`, `SuggestionId`, `MessageId`) on domain shapes; keep raw `string` only on `*Request` / `*Input` boundaries"
          : finding.category === "bizcode-registry"
            ? "Fix: register each business error code in BizCode as a unique six-digit integer (100000..999999) with matching BizErrorCodeValues and bizCodeMeta entries"
            : `Review: ${reviewAdvice[finding.category]}`;
  return `${finding.category} at ${finding.location}: ${finding.detail}. ${advice}. See ${boundaryDocs}`;
}

export function isBoundaryViolation(finding: Finding): boolean {
  return (
    finding.category === "db-enum-mismatch" ||
    finding.category === "secret-exposure" ||
    finding.category === "unbranded-id" ||
    finding.category === "bizcode-registry"
  );
}

export function auditBizCodeRegistry(source: string, path = "packages/protocol/src/endpoint.ts"): Finding[] {
  const findings: Finding[] = [];
  const lineAt = (index: number) => `${path}:${source.slice(0, index).split("\n").length}`;
  const add = (index: number, detail: string) => findings.push({ category: "bizcode-registry", location: lineAt(index), detail });

  const bizCodeMatch = /\bexport\s+const\s+BizCode\s*=\s*\{([\s\S]*?)\}\s*as\s+const\s*;/u.exec(source);
  if (!bizCodeMatch) {
    add(0, "missing `export const BizCode = { ... } as const;` registry");
    return findings;
  }

  const bizCodeBody = bizCodeMatch[1]!;
  const bizCodeOffset = bizCodeMatch.index + bizCodeMatch[0].indexOf("{") + 1;
  const codeByKey = new Map<string, number>();
  const keyByCode = new Map<number, string>();

  for (const entry of bizCodeBody.matchAll(/^\s*([A-Za-z0-9_]+)\s*:\s*([^,\n]+)\s*,?\s*$/gmu)) {
    const key = entry[1]!;
    const raw = entry[2]!.trim();
    const pos = bizCodeOffset + entry.index;
    if (codeByKey.has(key)) {
      add(pos, `BizCode.${key}: duplicate key`);
      continue;
    }
    if (key === "Ok") {
      if (raw !== "0") add(pos, `BizCode.Ok must be 0, got ${raw}`);
      codeByKey.set(key, 0);
      continue;
    }
    if (!/^[1-9]\d{5}$/u.test(raw)) {
      add(pos, `BizCode.${key}: expected six-digit integer (100000..999999), got ${raw}`);
      continue;
    }
    const num = Number(raw);
    const existing = keyByCode.get(num);
    if (existing !== undefined) {
      add(pos, `BizCode.${key}: duplicate numeric code ${raw} (already used by BizCode.${existing})`);
      continue;
    }
    codeByKey.set(key, num);
    keyByCode.set(num, key);
  }

  if (!codeByKey.has("Ok")) add(bizCodeMatch.index, "BizCode is missing `Ok: 0`");
  const errorKeys = [...codeByKey.keys()].filter((key) => key !== "Ok");

  const valuesMatch = /\bconst\s+BizErrorCodeValues\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/u.exec(source);
  if (!valuesMatch) {
    add(bizCodeMatch.index, "missing `const BizErrorCodeValues = [ ... ] as const;`");
  } else {
    const valuesPos = valuesMatch.index;
    const listed = [...valuesMatch[1]!.matchAll(/\bBizCode\.([A-Za-z0-9_]+)\b/gu)].map((m) => m[1]!);
    const seen = new Set<string>();
    for (const key of listed) {
      if (seen.has(key)) add(valuesPos, `BizErrorCodeValues: duplicate BizCode.${key}`);
      seen.add(key);
    }
    const missingInValues = errorKeys.filter((key) => !seen.has(key));
    const extraInValues = [...seen].filter((key) => key === "Ok" || !codeByKey.has(key));
    if (missingInValues.length > 0 || extraInValues.length > 0) {
      add(valuesPos, `BizErrorCodeValues ↔ BizCode: missing ${JSON.stringify(missingInValues)}, extra ${JSON.stringify(extraInValues)}`);
    }
  }

  const metaMatch = /\bexport\s+const\s+bizCodeMeta\b[^=]*=\s*\{([\s\S]*?)\n\};/u.exec(source);
  if (!metaMatch) {
    add(bizCodeMatch.index, "missing `export const bizCodeMeta = { ... };`");
  } else {
    const metaPos = metaMatch.index;
    const metaBody = metaMatch[1]!;
    const metaOffset = metaMatch.index + metaMatch[0].indexOf("{") + 1;
    const metaSeen = new Set<string>();
    for (const entry of metaBody.matchAll(/\[\s*BizCode\.([A-Za-z0-9_]+)\s*\]\s*:\s*\{\s*status\s*:\s*(\d+)/gu)) {
      const key = entry[1]!;
      const status = Number(entry[2]!);
      const pos = metaOffset + entry.index;
      if (metaSeen.has(key)) add(pos, `bizCodeMeta: duplicate [BizCode.${key}]`);
      metaSeen.add(key);
      if (status < 400 || status > 599) add(pos, `bizCodeMeta[BizCode.${key}]: expected HTTP error status 400..599, got ${status}`);
    }
    const missingInMeta = errorKeys.filter((key) => !metaSeen.has(key));
    const extraInMeta = [...metaSeen].filter((key) => key === "Ok" || !codeByKey.has(key));
    if (missingInMeta.length > 0 || extraInMeta.length > 0) {
      add(metaPos, `bizCodeMeta ↔ BizCode: missing ${JSON.stringify(missingInMeta)}, extra ${JSON.stringify(extraInMeta)}`);
    }
  }

  return findings;
}

const secretPath = "packages/protocol/src/common/schema.ts";

/** What keeps a Secret out of JSON and logs (what `disallowJsonEncode` did for a Redacted): its toJSON throws, it prints as [secret]. */
export function auditSecretClass(source: string, path = secretPath): Finding[] {
  const at = /\bexport\s+class\s+Secret\b/u.exec(source);
  const location = `${path}:${at === null ? 1 : source.slice(0, at.index).split("\n").length}`;
  if (at === null) return [{ category: "secret-exposure", location, detail: "no `export class Secret`" }];
  let depth = 0;
  let end = source.indexOf("{", at.index);
  for (let i = end; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = source.slice(at.index, end + 1);
  const missing = [
    /\btoJSON\s*\(\s*\)\s*:\s*never\s*\{\s*throw\b/u.test(body) ? undefined : "a toJSON(): never that throws",
    /\btoString\s*\(\s*\)\s*:\s*string\s*\{\s*return\s+"\[secret\]"/u.test(body) ? undefined : 'a toString that returns "[secret]"',
    /nodejs\.util\.inspect\.custom/u.test(body) ? undefined : "a nodejs.util.inspect.custom that hides it",
    /#value\b/u.test(body) ? undefined : "its value in a private #field",
  ].filter((m) => m !== undefined);
  return missing.length === 0 ? [] : [{ category: "secret-exposure", location, detail: `Secret lacks ${missing.join(", ")}` }];
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
  { column: "channel_participant.kind", protocol: "ActorKindValues", values: T.ActorKindValues },
  { column: "channel_participant.role", protocol: "AgentRoleValues", values: T.AgentRoleValues },
  { column: "channel_message.kind", protocol: "MessageKindValues", values: T.MessageKindValues },
  { column: "issue.mandate_strength", protocol: "MandateStrengthValues", values: T.MandateStrengthValues },
  { column: "issue.priority", protocol: "PriorityValues", values: T.PriorityValues },
  { column: "issue.delivered", protocol: "LandingValues", values: T.LandingValues },
  { column: "issue.canceled", protocol: "IssueCanceledValues", values: T.IssueCanceledValues },
  { column: "issue.deliver", protocol: "DeliverableValues", values: T.DeliverableValues },
  { column: "session.role", protocol: "AgentRoleValues", values: T.AgentRoleValues },
  { column: "session.closed", protocol: "SessionCloseValues", values: T.SessionCloseValues },
  { column: "session_run.outcome", protocol: "OutcomeValues", values: T.OutcomeValues },
  { column: "session_delivery.source", protocol: "TriggerSourceValues", values: TriggerSourceValues },
  { column: "issue_cron.set_by", protocol: "ActorKindValues", values: T.ActorKindValues },
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
    if (path === "packages/protocol/src/endpoint.ts") findings.push(...auditBizCodeRegistry(source, path));
    const addMatches = (category: ReviewCategory, pattern: RegExp) => {
      for (const match of source.matchAll(pattern)) {
        findings.push({ category, location: `${path}:${source.slice(0, match.index).split("\n").length}`, detail: match[0].replace(/\s+/gu, " ") });
      }
    };
    if (path.startsWith("packages/protocol/src/") || path.startsWith("apps/server/src/")) {
      addMatches("inline-literals", /\bz\s*\.\s*enum\s*\(\s*\[[^\]]+\]/gu);
      addMatches("inline-literals", /\bz\s*\.\s*literal\s*\(\s*"[^"]*"\s*\)\s*,\s*z\s*\.\s*literal\s*\(/gu);
    }
    if (path.startsWith("packages/protocol/src/") && path.endsWith("shapes.ts")) addMatches("inline-union", /:\s*"[^"]+"\s*\|\s*"[^"]+"/gu);
    if (path.startsWith("apps/server/src/")) {
      addMatches("db-schema-reuse", /\b(?:json(?:OrNone|Of)|storedJsonOrUndefined)\s*\(\s*S\.\w+/gu);
      addMatches("manual-enum-coercion", /\b(?:statusOf|priorityOf|\w+Values\s*\.\s*(?:find|includes))\s*\(/gu);
    }
    addMatches("json-parse-review", /\bJSON\s*\.\s*parse\s*\(/gu);
    // The protocol is what goes to the page: a secret it reveals is a secret on the wire.
    if (path.startsWith("packages/protocol/src/")) {
      for (const match of source.matchAll(/\.\s*reveal\s*\(\s*\)/gu))
        findings.push({
          category: "secret-exposure",
          location: `${path}:${source.slice(0, match.index).split("\n").length}`,
          detail: "a secret revealed in the protocol",
        });
    }
    if (path === secretPath) findings.push(...auditSecretClass(source, path));
    if (!path.startsWith("packages/protocol/") && !source.includes("z.lazy("))
      addMatches("subpackage-dual-shape", /\bconst\s+\w+\s*:\s*z\s*\.\s*Zod\w*<\w+>\s*=/gu);
    if (path === "apps/server/src/gateway/tool/schemas.ts")
      addMatches(
        "tool-downgrade",
        /\b(?:priority|status|deliver|tier|afterBlock|parentId)\s*:\s*(?:z\s*\.\s*(?:exactOptional|optional)\s*\(\s*)?z\s*\.\s*string\s*\(/gu,
      );

    if (!path.startsWith("packages/protocol/src/") || !path.endsWith("shapes.ts")) continue;
    let currentInterface = "";
    let currentDecl = "";
    for (const [index, line] of source.split("\n").entries()) {
      const iface = /^export interface (\w+)/u.exec(line);
      const alias = /^export type (\w+)\b/u.exec(line);
      if (iface) {
        currentInterface = iface[1]!;
        currentDecl = iface[1]!;
      } else if (alias) {
        currentInterface = "";
        currentDecl = alias[1]!;
      } else if (line !== "" && !/^\s/u.test(line) && !line.startsWith("|") && !line.startsWith("}") && !line.startsWith("//") && !line.startsWith("/*")) {
        currentInterface = "";
        currentDecl = "";
      }
      if (line.startsWith("}")) {
        currentInterface = "";
        currentDecl = "";
      }
      if (
        currentDecl &&
        !/(?:Request|Input)$/u.test(currentDecl) &&
        !/kind:\s*"orchestrator";\s*session:\s*string/u.test(line) &&
        /\b(?:issue|issueId|blockedBy|session|sessionId|sessionIds|artifact|artifactId|blockId|messageId|suggestion|suggestionId)\??\s*:\s*(?:readonly\s+)?string(?:\[\])?\b/u.test(
          line,
        )
      ) {
        findings.push({ category: "unbranded-id", location: `${path}:${index + 1}`, detail: `${currentDecl}: ${line.trim()}` });
      }
      if (!currentInterface) continue;
      const add = (category: ReviewCategory) => findings.push({ category, location: `${path}:${index + 1}`, detail: `${currentInterface}: ${line.trim()}` });
      const optional = /^\s*(?:readonly\s+)?\w+\?:\s*([A-Za-z0-9_]+)\s*;/u.exec(line);
      const patch = /(?:Update|Filter|Options|Patch|Draft|Meta|Context|Request|Input|Edit)$/u.test(currentInterface);
      if (!patch && optional && enumNames.has(optional[1]!)) add("optional-enum");
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
