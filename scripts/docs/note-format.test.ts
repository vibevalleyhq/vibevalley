import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";

const root = resolve(import.meta.dirname, "../..");

function extractSerdeRenames(rustSource: string, enumName: string): string[] {
  const start = rustSource.indexOf(`pub enum ${enumName} {`);
  if (start < 0) throw new Error(`enum ${enumName} not found in contract`);
  let depth = 0;
  let end = start;
  for (let i = start; i < rustSource.length; i++) {
    const ch = rustSource[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = rustSource.slice(start, end + 1);
  return [...body.matchAll(/#\[serde\([^)]*rename\s*=\s*"([^"]+)"/gu)].map((m) => m[1] ?? "");
}

describe("Note 3+1 format.md contract alignment (#162)", () => {
  const noteContract = readFileSync(resolve(root, "crates/protocol/src/contract/note.rs"), "utf8");

  test("doc/references/format.md documents all 24 BlockKind wire names", () => {
    const docFormat = readFileSync(resolve(root, "crates/server/assets/note/types/doc/references/format.md"), "utf8");
    const kinds = extractSerdeRenames(noteContract, "BlockKind");
    expect(kinds).toHaveLength(24);
    for (const wire of kinds) {
      expect(docFormat, `missing BlockKind "${wire}" in doc/references/format.md`).toContain(`"${wire}"`);
    }
  });

  test("base/references/format.md documents all BaseColumnKind, BaseCellValue, BaseViewKind, BaseFilterOp, and BaseSummaryOp wire names", () => {
    const baseFormat = readFileSync(resolve(root, "crates/server/assets/note/types/base/references/format.md"), "utf8");
    const checks: readonly (readonly [string, number])[] = [
      ["BaseColumnKind", 12],
      ["BaseCellValue", 8],
      ["BaseViewKind", 4],
      ["BaseFilterOp", 5],
      ["BaseSummaryOp", 5],
    ];
    for (const [enumName, expectedCount] of checks) {
      const wires = extractSerdeRenames(noteContract, enumName);
      expect(wires, `${enumName} count`).toHaveLength(expectedCount);
      for (const wire of wires) {
        expect(baseFormat, `missing ${enumName} "${wire}" in base/references/format.md`).toContain(`\`${wire}\``);
      }
    }
  });
});

describe("Orchestrator & session prompts (#162, #163)", () => {
  const PromptsSchema = z.object({
    system: z.string(),
    talk: z.string(),
    workplace: z.object({
      branch: z.string(),
      pullRequest: z.string(),
      folder: z.string(),
      draft: z.string(),
      answer: z.string(),
    }),
  });

  test("prompts.json eliminates legacy docs/outline wording and injects Base/DocBlock + pstack engineering disciplines", () => {
    const raw = readFileSync(resolve(root, "crates/server/assets/orchestrator/prompts.json"), "utf8");
    const prompts = PromptsSchema.parse(JSON.parse(raw));

    expect(prompts.system).not.toContain("`docs`/`outline` 作品");
    expect(prompts.talk).not.toContain("`docs`/`outline` 作品");
    expect(prompts.system).toContain("note_base_upsert_row");
    expect(prompts.system).toContain("note_doc_append_block");
    expect(prompts.system).toContain("ketchup");
    expect(prompts.system).toContain("Attention");

    for (const mode of [prompts.workplace.branch, prompts.workplace.pullRequest, prompts.workplace.folder]) {
      expect(mode).toContain("Attack the Premise");
      expect(mode).toContain("Subtract Before You Add");
      expect(mode).toContain("Sequence Verifiable Units");
      expect(mode).toContain("note_base_upsert_row");
      expect(mode).toContain("note_doc_append_block");
    }
    expect(prompts.workplace.draft).toContain("起草");
  });
});
