import { describe, expect, test } from "vite-plus/test";

import { compareStoredEnums, formatFinding, isBoundaryViolation, reviewSchemaSources, scanSchemaBoundaries } from "./schema-audit.ts";

const contract = [{ column: "issue.priority", protocol: "PriorityValues", values: ["high", "low"] }];
const issueSql = (column: string) => `CREATE TABLE issue (id text primary key, ${column});`;
const review = (path: string, source: string) => reviewSchemaSources(new Map([[path, source]]));

const serverFile = "apps/server/src/issue/rows.ts";
const protocolFile = "packages/protocol/src/issue/shapes.ts";

describe("the stored enum contract", () => {
  test.each([
    "priority text check (priority in ('high', 'low'))",
    "priority text CHECK (priority IN ('low', 'high'))",
    "priority\n text\n check (\n priority in (\n 'low',\n 'high'\n )\n )",
    "priority text, check (priority in ('high', 'low'))",
  ])("accepts the same named set regardless of layout: %s", (column) => {
    expect(compareStoredEnums(issueSql(column), contract)).toEqual([]);
  });

  test.each([
    ["priority text check (priority in ('high'))", 'missing ["low"], extra []'],
    ["priority text check (priority in ('high', 'low', 'urgent'))", 'missing [], extra ["urgent"]'],
    ["priority text check (priority in ('high', 'urgent'))", 'missing ["low"], extra ["urgent"]'],
    ["priority text", "missing literal IN CHECK"],
    ["renamed text check (renamed in ('high', 'low'))", "missing text column"],
    ["priority text check (priority in ('high', 'low') or priority = 'urgent')", "missing literal IN CHECK"],
  ])("regression: rejects enum drift or a missing constraint: %s", (column, reason) => {
    expect(compareStoredEnums(issueSql(column), contract)).toEqual([
      { category: "db-enum-mismatch", location: "apps/server/db/migrations/0001_schema.up.sql:1", detail: `issue.priority ↔ PriorityValues: ${reason}` },
    ]);
  });

  test("regression: removing the mapped table fails instead of removing the check", () => {
    expect(compareStoredEnums("CREATE TABLE other (id text);", contract)[0]?.detail).toContain("issue.priority ↔ PriorityValues: missing text column");
  });

  test("regression: matching words in another column or table do not establish ownership", () => {
    const sql = `${issueSql("priority text check (priority in ('high')), other text check (other in ('high', 'low'))")}
      CREATE TABLE unrelated (priority text check (priority in ('high', 'low')));`;
    expect(compareStoredEnums(sql, contract)[0]?.detail).toContain('missing ["low"]');
  });

  test("regression: comments cannot provide the missing constraint", () => {
    const sql = issueSql("priority text /* check (priority in ('high', 'low')) */\n -- check (priority in ('high', 'low'))\n");
    expect(compareStoredEnums(sql, contract)[0]?.detail).toContain("missing literal IN CHECK");
  });

  test("keeps source line numbers after stripping comments", () => {
    const sql = "/* header\n comment */\n" + issueSql("priority text");
    expect(compareStoredEnums(sql, contract)[0]?.location).toBe("apps/server/db/migrations/0001_schema.up.sql:3");
  });

  test("storage-only enums do not need a protocol counterpart", () => {
    const sql = `${issueSql("priority text check (priority in ('high', 'low'))")}
      CREATE TABLE connector_outbox (state text check (state in ('pending', 'sent', 'dropped')));`;
    expect(compareStoredEnums(sql, contract)).toEqual([]);
  });

  test("regression: generated schema text cannot satisfy an independent SQL comparison", () => {
    const sources = new Map([["apps/server/db/generated/types.ts", 'export const Priority = Schema.Literals(["high"]);']]);
    expect(reviewSchemaSources(sources)).toEqual([]);
    expect(compareStoredEnums(issueSql("priority text check (priority in ('high'))"), contract).filter(isBoundaryViolation)).toHaveLength(1);
  });
});

describe("source review hints", () => {
  test.each([
    "jsonOrNone(S.Conflict)(row.conflict)",
    "const decode = jsonOrNone(S.Conflict); decode(row.conflict)",
    "const decode = jsonOrNone(\n  S.Conflict\n); decode(row.conflict)",
    "const columns = { conflict: jsonOf(S.Conflict) }; columns.conflict(row.conflict)",
  ])("regression: extracting or wrapping a decoder does not hide schema reuse: %s", (source) => {
    const findings = review(serverFile, source);
    expect(findings.map((finding) => finding.category)).toEqual(["db-schema-reuse"]);
    expect(findings.filter(isBoundaryViolation)).toEqual([]);
    expect(formatFinding(findings[0]!)).toContain("reuse is valid");
  });

  test.each(["const value: unknown = JSON.parse(line); receive(value);", "const value = JSON\n .parse(\n line\n); decode(value);"])(
    "regression: parsing before contract decoding is a review hint, not a violation: %s",
    (source) => {
      const findings = review("packages/bridge/src/socket.ts", source);
      expect(findings.map((finding) => finding.category)).toEqual(["json-parse-review"]);
      expect(findings.filter(isBoundaryViolation)).toEqual([]);
      expect(formatFinding(findings[0]!)).toContain("follow the unknown value to its contract decoder");
    },
  );

  test("a raw cast and a decoded payload need tracing rather than filename exceptions", () => {
    for (const path of ["packages/protocol/src/client.ts", "apps/mobile/src/FarmScreen.tsx", "packages/ai/src/response.ts", "packages/new/src/transport.ts"]) {
      expect(review(path, "return JSON.parse(text) as Response;").map((finding) => finding.category)).toEqual(["json-parse-review"]);
    }
  });

  test.each([
    [serverFile, 'Schema.Literals(["a", "b"])', "inline-literals"],
    [serverFile, 'Schema.Literals(\n [\n "a",\n "b"\n ]\n)', "inline-literals"],
    [protocolFile, 'export interface Item { kind:\n "a" |\n "b"; }', "inline-union"],
    [protocolFile, "export interface Item {\n issue: string;\n}", "unbranded-id"],
    [protocolFile, "export interface Item {\n blockedBy: readonly string[];\n}", "unbranded-id"],
    [protocolFile, 'export const ModeValues = ["a", "b"] as const;\nexport interface Item {\n mode?: Mode;\n}', "optional-enum"],
    [protocolFile, "export interface Item {\n enabled?: boolean;\n}", "optional-collection-or-flag"],
    [protocolFile, "export interface Item {\n items?: readonly Item[];\n}", "optional-collection-or-flag"],
    [serverFile, "DeliverableValues\n .find(\n value => value === input)", "manual-enum-coercion"],
    ["apps/server/src/tool/schemas.ts", "priority:\n Schema.optionalKey(\n Schema.String)", "tool-downgrade"],
    ["packages/ai/src/messages.ts", "const MessageSchema:\n Schema.Codec<Message> = Schema.Struct({});", "subpackage-dual-shape"],
  ])("reports a candidate without treating it as a proven defect: %s / %s", (path, source, category) => {
    const findings = review(path, source);
    expect(findings.map((finding) => finding.category)).toContain(category);
    expect(findings.filter(isBoundaryViolation)).toEqual([]);
  });

  test.each([
    [serverFile, "Schema.Literals(ModeValues)"],
    [serverFile, "const decode = jsonOrNone(localSchema);"],
    [protocolFile, "export interface Item {\n issue: IssueId;\n enabled: boolean;\n}"],
    [protocolFile, 'export const ModeValues = ["a", "b"] as const;\nexport interface ItemUpdate {\n mode?: Mode;\n enabled?: boolean;\n}'],
    ["apps/server/src/tool/schemas.ts", "priority: Schema.optionalKey(S.Priority)"],
  ])("does not report the corresponding explicit form: %s / %s", (path, source) => {
    expect(review(path, source)).toEqual([]);
  });

  test("reports the first line of a multiline candidate", () => {
    expect(review(serverFile, "\n\njsonOrNone(\n S.Conflict\n)")[0]?.location).toBe(`${serverFile}:3`);
  });
});

test("boundary diagnostics distinguish a repair from a review and link to the permanent rule", () => {
  const violation = compareStoredEnums(issueSql("priority text"), contract)[0]!;
  const message = formatFinding(violation);
  expect(isBoundaryViolation(violation)).toBe(true);
  expect(message).toContain("issue.priority ↔ PriorityValues");
  expect(message).toContain("Fix:");
  expect(message).toContain("See docs/subsystems/foundation.md#边界审计");
  const hint = formatFinding(review(serverFile, "jsonOf(S.Conflict)")[0]!);
  expect(hint).toContain("Review:");
  expect(hint).not.toContain("Fix:");
});

test("mapped database enums match their named protocol contracts", () => {
  const violations = scanSchemaBoundaries().filter(isBoundaryViolation);
  expect(violations.map(formatFinding)).toEqual([]);
});
