import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";

import { goldenCasesAt, jsonDiff } from "@vibevalley/testkit/golden";

import { coerceArguments, parametersOf, toolArguments } from "./tools.ts";

// Recorded from pi-ai 1.3.0's validateToolArguments: what it made of each tool's arguments, or that it refused them.
const cases = goldenCasesAt(join(import.meta.dirname, "testdata", "arguments.jsonl.gz"));

const optional = Schema.optionalKey;
/** The Schema each recorded JSON Schema was written for. */
const tools: Record<string, Schema.Struct<Schema.Struct.Fields>> = {
  read: Schema.Struct({ path: Schema.String, offset: optional(Schema.Int), limit: optional(Schema.Int) }),
  read2: Schema.Struct({ path: Schema.String, offset: optional(Schema.Int) }),
  bash: Schema.Struct({ command: Schema.String, timeout_seconds: optional(Schema.Finite) }),
  edit: Schema.Struct({ path: Schema.String, old_text: Schema.String, new_text: Schema.String, replace_all: optional(Schema.Boolean) }),
  empty: Schema.Struct({}),
  tasks: Schema.Struct({
    tasks: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        brief: Schema.String,
        after: optional(Schema.Array(Schema.String)),
        by: optional(Schema.Literals(["self", "subagent"])),
      }),
    ),
  }),
  update: Schema.Struct({ id: Schema.String, state: optional(Schema.Literals(["done", "failed"])), after: optional(Schema.Array(Schema.String)) }),
};

it("a tool's Schema is shown to the model as its JSON Schema always was, byte for byte", () => {
  const shown = new Map(cases.map((c) => [(c.in as { tool: string }).tool, (c.in as { schema: unknown }).schema]));
  for (const [name, schema] of Object.entries(tools)) expect(JSON.stringify(parametersOf(schema)), name).toBe(JSON.stringify(shown.get(name)));
});

it("a model's arguments are coerced and refused as pi-ai's validateToolArguments did", () => {
  const failed: string[] = [];
  for (const c of cases) {
    const i = c.in as { tool: string; schema: Record<string, unknown>; arguments: unknown };
    const want = c.out as { ok?: unknown; error?: string };
    const coerced = coerceArguments(i.arguments, i.schema);
    const read = Schema.decodeUnknownExit(tools[i.tool]! as unknown as Schema.Codec<unknown>)(coerced);
    if (want.error && Exit.isSuccess(read)) failed.push(`line ${c.line} ${i.tool} ${JSON.stringify(i.arguments)}: read, pi-ai refused`);
    if (!want.error) {
      if (Exit.isFailure(read)) failed.push(`line ${c.line} ${i.tool} ${JSON.stringify(i.arguments)}: refused, pi-ai read ${JSON.stringify(want.ok)}`);
      const d = jsonDiff(coerced, want.ok);
      if (d) failed.push(`line ${c.line} ${i.tool} ${JSON.stringify(i.arguments)}: ${d}`);
    }
  }
  expect(failed).toEqual([]);
});

it("refused arguments are told in pi-ai's words, a line a problem and then what came", () => {
  const failed: string[] = [];
  for (const c of cases) {
    const i = c.in as { tool: string; schema: Record<string, unknown>; arguments: unknown };
    const want = c.out as { ok?: unknown; error?: string };
    const got = toolArguments(i.tool, i.arguments, i.schema);
    const d = jsonDiff("refused" in got ? { error: got.refused } : { ok: got.ok }, want);
    if (d) failed.push(`line ${c.line} ${i.tool} ${JSON.stringify(i.arguments)}: ${d}`);
  }
  expect(failed).toEqual([]);
});
