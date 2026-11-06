import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

export interface Finding {
  readonly category: "inline-literals" | "inline-union" | "optional-enum" | "tool-downgrade" | "unbranded-id" | "db-wire-coupling";
  readonly location: string;
  readonly detail: string;
}

export function scanSchemaBoundaries(): Finding[] {
  const files = execFileSync("git", ["ls-files", "packages/protocol/src/**/*.ts", "apps/server/src/**/*.ts"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f !== "" && !f.endsWith(".test.ts"));

  const findings: Finding[] = [];
  const enumNames = new Set<string>(["Locale", "Voice", "Area", "Language", "Model"]);

  for (const f of files.filter((p) => p.startsWith("packages/protocol/src/") && p.endsWith("shapes.ts"))) {
    const src = readFileSync(resolve(root, f), "utf8");
    for (const m of src.matchAll(/export const (\w+Values)\s*=\s*\[([^\]]+)\]\s*as const/gmsu)) {
      enumNames.add(m[1]!.replace(/Values$/u, ""));
    }
  }

  for (const f of files) {
    const lines = readFileSync(resolve(root, f), "utf8").split("\n");
    for (const [idx, line] of lines.entries()) {
      if (/Schema\.Literals\(\[([^\]]+)\]\)/u.test(line)) {
        findings.push({
          category: "inline-literals",
          location: `${f}:${idx + 1}`,
          detail: line.trim(),
        });
      }
      if (f.startsWith("packages/protocol/src/") && f.endsWith("shapes.ts") && /:\s*"[^"]+"\s*\|\s*"[^"]+"/u.test(line)) {
        findings.push({
          category: "inline-union",
          location: `${f}:${idx + 1}`,
          detail: line.trim(),
        });
      }
      if (f.startsWith("apps/server/src/") && /jsonOrNone\(S\.\w+\)/u.test(line)) {
        findings.push({
          category: "db-wire-coupling",
          location: `${f}:${idx + 1}`,
          detail: line.trim(),
        });
      }
    }
  }

  for (const f of files.filter((p) => p.startsWith("packages/protocol/src/") && p.endsWith("shapes.ts"))) {
    const lines = readFileSync(resolve(root, f), "utf8").split("\n");
    let currentInterface = "";
    for (const [idx, line] of lines.entries()) {
      const im = /^export interface (\w+)/u.exec(line);
      if (im) {
        currentInterface = im[1]!;
        continue;
      }
      if (line.startsWith("}")) {
        currentInterface = "";
        continue;
      }
      if (!currentInterface) continue;
      const em = /^\s*(?:readonly\s+)?(\w+)\?:\s*([A-Za-z0-9_]+)\s*;/u.exec(line);
      if (em && enumNames.has(em[2]!)) {
        // A request, patch or metadata bag may leave an enum out; so may a field whose owning state already says
        // "not applicable" (an open issue has no delivered, a running run no outcome). Those are not fake optionals.
        const trulyOptional =
          /(?:Update|Filter|Options|Patch|Draft|Meta|Context)$/u.test(currentInterface) ||
          currentInterface === "SuggestionChange" ||
          currentInterface === "PkmSearchRequest" ||
          currentInterface === "PkmPageRequest" ||
          currentInterface === "PkmClipRequest" ||
          currentInterface === "IssueRequest";
        const stateSaysIt = new Set(["Issue", "IssueStage", "PkmBlock", "PkmSearchHit", "SessionEvent", "Run", "FactSessionLeft"]).has(currentInterface);
        if (!trulyOptional && !stateSaysIt) {
          findings.push({
            category: "optional-enum",
            location: `${f}:${idx + 1}`,
            detail: `${currentInterface}.${em[1]}?: ${em[2]}`,
          });
        }
      }
      const bm =
        /^\s*(?:readonly\s+)?(issue|issueId|parent|blockedBy|session|sessionId|artifact|artifactId|block|blockId|messageId|suggestionId)(\?)?:\s*(string(?:\[\])?)\s*;/u.exec(
          line,
        );
      if (bm) {
        findings.push({
          category: "unbranded-id",
          location: `${f}:${idx + 1}`,
          detail: `${currentInterface}.${bm[1]}${bm[2] ?? ""}: ${bm[3]}`,
        });
      }
    }
  }

  const toolLines = readFileSync(resolve(root, "apps/server/src/tool/schemas.ts"), "utf8").split("\n");
  for (const [idx, line] of toolLines.entries()) {
    if (/^\s*(priority|status|deliver|type|tier|id|issue|parent|block|afterBlock|parentId):\s*(?:Schema\.optionalKey\()?Schema\.String/u.test(line)) {
      findings.push({
        category: "tool-downgrade",
        location: `apps/server/src/tool/schemas.ts:${idx + 1}`,
        detail: line.trim(),
      });
    }
  }

  return findings;
}

if (import.meta.main) {
  const all = scanSchemaBoundaries();
  const byCategory = new Map<Finding["category"], Finding[]>();
  for (const finding of all) byCategory.set(finding.category, [...(byCategory.get(finding.category) ?? []), finding]);
  for (const [category, items] of byCategory) {
    console.log(`\n## ${category} (${items.length})`);
    for (const item of items) console.log(`- ${item.location} — ${item.detail}`);
  }
  console.log(`\nschema-audit: ${all.length} findings across ${byCategory.size} categories`);
}
