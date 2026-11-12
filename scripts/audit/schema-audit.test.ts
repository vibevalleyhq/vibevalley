import { describe, expect, test } from "vite-plus/test";

import {
  auditBizCodeRegistry,
  auditSecretClass,
  compareStoredEnums,
  formatFinding,
  isBoundaryViolation,
  reviewSchemaSources,
  scanSchemaBoundaries,
} from "./schema-audit.ts";

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
    const sources = new Map([["apps/server/db/generated/types.ts", 'export const Priority = z.enum(["high"]);']]);
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
    [serverFile, 'z.enum(["a", "b"])', "inline-literals"],
    [serverFile, 'z.enum(\n [\n "a",\n "b"\n ]\n)', "inline-literals"],
    [serverFile, 'z.union([z.literal("a"), z.literal("b")])', "inline-literals"],
    [protocolFile, 'export interface Item { kind:\n "a" |\n "b"; }', "inline-union"],
    [protocolFile, 'export const ModeValues = ["a", "b"] as const;\nexport interface Item {\n mode?: Mode;\n}', "optional-enum"],
    [protocolFile, "export interface Item {\n enabled?: boolean;\n}", "optional-collection-or-flag"],
    [protocolFile, "export interface Item {\n items?: readonly Item[];\n}", "optional-collection-or-flag"],
    [serverFile, "DeliverableValues\n .find(\n value => value === input)", "manual-enum-coercion"],
    ["apps/server/src/modules/tool/schemas.ts", "priority:\n z.exactOptional(\n z.string())", "tool-downgrade"],
    ["packages/ai/src/messages.ts", "const MessageSchema:\n z.ZodType<Message> = z.object({});", "subpackage-dual-shape"],
  ])("reports a candidate without treating it as a proven defect: %s / %s", (path, source, category) => {
    const findings = review(path, source);
    expect(findings.map((finding) => finding.category)).toContain(category);
    expect(findings.filter(isBoundaryViolation)).toEqual([]);
  });

  test.each([
    [serverFile, "z.enum(ModeValues)"],
    [serverFile, "const decode = jsonOrNone(localSchema);"],
    [protocolFile, "export interface Item {\n issue: IssueId;\n enabled: boolean;\n}"],
    [protocolFile, 'export const ModeValues = ["a", "b"] as const;\nexport interface ItemUpdate {\n mode?: Mode;\n enabled?: boolean;\n}'],
    ["apps/server/src/modules/tool/schemas.ts", "priority: z.exactOptional(S.Priority)"],
    ["packages/ai/src/messages.ts", "const MessageSchema = z.object({}) satisfies z.ZodType<Message>;"],
  ])("does not report the corresponding explicit form: %s / %s", (path, source) => {
    expect(review(path, source)).toEqual([]);
  });

  test("reports the first line of a multiline candidate", () => {
    expect(review(serverFile, "\n\njsonOrNone(\n S.Conflict\n)")[0]?.location).toBe(`${serverFile}:3`);
  });

  test("rejects a secret revealed in the protocol as a boundary violation", () => {
    const unsafe = review("packages/protocol/src/setting/schema.ts", "export const Key = secretOf(z.string()).transform((s) => s.reveal());");
    expect(unsafe.map((f) => f.category)).toEqual(["secret-exposure"]);
    expect(unsafe.every(isBoundaryViolation)).toBe(true);
    expect(formatFinding(unsafe[0]!)).toContain("never calls `.reveal()`");
    // The server reveals a secret where it uses it (a header, the file it is kept in): not on the wire.
    expect(review(serverFile, "const header = key.reveal();")).toEqual([]);
  });

  test("rejects a Secret that would go into JSON or a log", () => {
    const safe = [
      "export class Secret {",
      "  readonly #value: string;",
      "  constructor(value: string) { this.#value = value; }",
      "  reveal(): string { return this.#value; }",
      '  toJSON(): never { throw new Error("never JSON"); }',
      '  toString(): string { return "[secret]"; }',
      '  [Symbol.for("nodejs.util.inspect.custom")](): string { return "[secret]"; }',
      "}",
    ].join("\n");
    expect(auditSecretClass(safe)).toEqual([]);
    const leaky = safe.replace('toJSON(): never { throw new Error("never JSON"); }', "toJSON(): string { return this.#value; }");
    const found = auditSecretClass(leaky);
    expect(found.map((f) => f.category)).toEqual(["secret-exposure"]);
    expect(found[0]?.detail).toContain("toJSON");
    expect(found.every(isBoundaryViolation)).toBe(true);
    expect(auditSecretClass("export const Secret = String;").map((f) => f.detail)).toEqual(["no `export class Secret`"]);
  });

  test("rejects unbranded entity IDs on non-request protocol interfaces and type unions as boundary violations", () => {
    const iface = review(protocolFile, "export interface Item {\n  issue: string;\n  blockedBy: readonly string[];\n}");
    expect(iface.map((f) => f.category)).toEqual(["unbranded-id", "unbranded-id"]);
    expect(iface.every(isBoundaryViolation)).toBe(true);
    expect(formatFinding(iface[0]!)).toContain("Fix: use the branded entity ID");
    const union = review(protocolFile, 'export type Watch =\n  | { kind: "history"; session: string }\n  | { kind: "missing"; issue: string };');
    expect(union.map((f) => f.category)).toEqual(["unbranded-id", "unbranded-id"]);
    expect(union.every(isBoundaryViolation)).toBe(true);
    expect(review(protocolFile, "export interface ItemRequest {\n  issue?: string;\n}")).toEqual([]);
  });

  test("enforces unique six-digit BizCode registry parity across BizErrorCodeValues and bizCodeMeta", () => {
    const validEndpoint = [
      "export const BizCode = {",
      "  Ok: 0,",
      "  IssueNotFound: 300001,",
      "  IssueRefused: 300002,",
      "} as const;",
      "const BizErrorCodeValues = [BizCode.IssueNotFound, BizCode.IssueRefused] as const;",
      "export const bizCodeMeta = {",
      '  [BizCode.IssueNotFound]: { status: 404, kind: "Missing", retryable: false },',
      '  [BizCode.IssueRefused]: { status: 409, kind: "Refused", retryable: false },',
      "};",
    ].join("\n");
    expect(auditBizCodeRegistry(validEndpoint)).toEqual([]);
    expect(review("packages/protocol/src/endpoint.ts", validEndpoint)).toEqual([]);

    const badDigits = validEndpoint.replace("IssueNotFound: 300001", "IssueNotFound: 3001");
    expect(auditBizCodeRegistry(badDigits).map((f) => f.detail)).toContain("BizCode.IssueNotFound: expected six-digit integer (100000..999999), got 3001");

    const duplicateCode = validEndpoint.replace("IssueRefused: 300002", "IssueRefused: 300001");
    const dupFindings = auditBizCodeRegistry(duplicateCode);
    expect(dupFindings.every(isBoundaryViolation)).toBe(true);
    expect(dupFindings[0]?.detail).toContain("duplicate numeric code 300001");
    expect(formatFinding(dupFindings[0]!)).toContain("Fix: register each business error code in BizCode");

    const missingMeta = validEndpoint.replace('  [BizCode.IssueRefused]: { status: 409, kind: "Refused", retryable: false },\n', "");
    expect(auditBizCodeRegistry(missingMeta)[0]?.detail).toContain('bizCodeMeta ↔ BizCode: missing ["IssueRefused"]');
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
