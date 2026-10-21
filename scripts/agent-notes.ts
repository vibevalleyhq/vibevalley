/**
 * The Agent Note tree and file format (.agents/notes/README.md), checked, and its catalog written. The lifecycle and
 * class sets are closed: this file is their single source, and the README's tables follow it. Runs on Bun:
 *
 *   bun scripts/agent-notes.ts           check every note and that CATALOG.md is current; any error exits 1
 *   bun scripts/agent-notes.ts --write   write CATALOG.md from the notes first, then check
 *
 * Checks: every folder under .agents/notes is a known lifecycle; every note sits at {lifecycle}/{class}/ with a
 * known class and a yyyy-mm-dd-topic.md name; no hand-written INDEX.md; the header block is exactly
 * `# Agent Note: <title>`, blank, `Status: …` matching the lifecycle, blank; the body opens with `## Problem` and has
 * the sections its lifecycle requires, and an implemented note has none of the proposal-era ones; CATALOG.md is what
 * the notes give. Links are checked by doc-links.ts.
 */

import { Glob } from "bun";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export const agentNoteRoot = resolve(import.meta.dir, "../.agents/notes");

/** Active lifecycles: the top-level folders under .agents/notes, in the catalog's order. */
export const AGENT_NOTE_LIFECYCLES = ["proposed", "implemented", "rejected"] as const;
export type Lifecycle = (typeof AGENT_NOTE_LIFECYCLES)[number];

/** Classes: the folder under each lifecycle. Adding one means extending this list and the README's table. */
export const AGENT_NOTE_CLASSES = ["feature", "bug-fix", "simplification", "architecture", "process", "testing"] as const;

/** The catalog this script writes; never edited by hand. */
export const CATALOG = "CATALOG.md";

/** Markdown allowed directly at the notes root or a lifecycle root, besides notes. */
const ROOT_FILES = new Set(["README.md", "AGENTS.md", "CLAUDE.md", CATALOG]);

/** The sections each lifecycle requires, and the ones it forbids. */
const SECTIONS: Record<Lifecycle, { readonly required: readonly string[]; readonly forbidden: readonly string[] }> = {
  proposed: { required: ["Problem", "Proposal", "Alternatives considered", "Acceptance criteria", "Risks"], forbidden: [] },
  implemented: {
    required: ["Problem", "Decision", "Alternatives considered", "Consequences"],
    forbidden: ["Proposal", "Plan", "Migration plan", "Acceptance criteria"],
  },
  rejected: { required: ["Problem", "Proposal", "Alternatives considered"], forbidden: [] },
};

export interface AgentNote {
  readonly lifecycle: Lifecycle;
  readonly cls: string;
  /** Path relative to .agents/notes. */
  readonly rel: string;
  readonly lines: readonly string[];
}

const isLifecycle = (name: string): name is Lifecycle => (AGENT_NOTE_LIFECYCLES as readonly string[]).includes(name);
const isClass = (name: string): boolean => (AGENT_NOTE_CLASSES as readonly string[]).includes(name);

/** Every note in the tree, and one error per structural violation. */
export async function walkAgentNoteTree(): Promise<{ notes: AgentNote[]; errors: string[] }> {
  const notes: AgentNote[] = [];
  const errors: string[] = [];
  for (const entry of readdirSync(agentNoteRoot, { withFileTypes: true })) {
    if (entry.name === "INDEX.md") errors.push(`INDEX.md: no hand-written index; ${CATALOG} is written by this script`);
    else if (entry.isDirectory() && !isLifecycle(entry.name))
      errors.push(`${entry.name}/: unknown lifecycle folder (allowed: ${AGENT_NOTE_LIFECYCLES.join(", ")})`);
    else if (entry.isFile() && !entry.name.startsWith(".") && !ROOT_FILES.has(entry.name))
      errors.push(`${entry.name}: notes live at {lifecycle}/{class}/yyyy-mm-dd-topic.md`);
  }
  for (const lifecycle of AGENT_NOTE_LIFECYCLES) {
    const paths = [...new Glob(`${lifecycle}/**/*`).scanSync({ cwd: agentNoteRoot })].map((p) => p.replaceAll("\\", "/")).sort();
    for (const rel of paths) {
      const segs = rel.split("/");
      const [, cls, base] = segs;
      if (segs.length === 2 && cls !== undefined && ROOT_FILES.has(cls)) continue;
      if (segs.length !== 3 || cls === undefined || base === undefined) {
        errors.push(`${rel}: expected {lifecycle}/{class}/file.md`);
        continue;
      }
      if (!isClass(cls)) {
        errors.push(`${rel}: unknown class folder "${cls}" (allowed: ${AGENT_NOTE_CLASSES.join(", ")})`);
        continue;
      }
      if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(base)) {
        errors.push(`${rel}: the name must be yyyy-mm-dd-topic-title.md (lowercase words joined by -)`);
        continue;
      }
      notes.push({ lifecycle, cls, rel, lines: (await Bun.file(resolve(agentNoteRoot, rel)).text()).split("\n") });
    }
  }
  return { notes, errors };
}

/** The format errors in one note. */
export function checkAgentNote(note: AgentNote): string[] {
  const errors: string[] = [];
  const { lines } = note;
  const at = (msg: string) => errors.push(`${note.rel}: ${msg}`);

  if (!/^# Agent Note: \S/.test(lines[0] ?? "")) at('line 1 must be "# Agent Note: <title>"');
  if (lines[1] !== "") at("line 2 must be blank");
  const status = lines[2] ?? "";
  const statusOk = note.lifecycle === "rejected" ? /^Status: rejected — \S/.test(status) : status === `Status: ${note.lifecycle}`;
  if (!statusOk)
    at(
      note.lifecycle === "rejected"
        ? 'line 3 must be "Status: rejected — <why>"'
        : `line 3 must be "Status: ${note.lifecycle}" (it sits in ${note.lifecycle}/)`,
    );
  if (lines[3] !== "") at("line 4 must be blank");

  // Sections, ignoring fenced code blocks.
  const sections: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (!fenced && line.startsWith("## ")) sections.push(line.slice(3).trim());
  }
  if (sections[0] !== "Problem") at('the body must open with "## Problem"');
  const { required, forbidden } = SECTIONS[note.lifecycle];
  for (const name of required) if (!sections.includes(name)) at(`missing "## ${name}" (required in ${note.lifecycle}/)`);
  for (const name of forbidden) if (sections.includes(name)) at(`"## ${name}" does not belong in ${note.lifecycle}/: describe what shipped`);
  return errors;
}

/** CATALOG.md: every note's date and title, by lifecycle and class, newest first; a rejected one with its reason. */
export function catalogOf(notes: readonly AgentNote[]): string {
  const title = (n: AgentNote) => (n.lines[0] ?? "").replace(/^# Agent Note:\s*/, "").trim() || n.rel;
  const out = [
    "# Agent Notes 目录",
    "",
    `由 [scripts/agent-notes.ts](scripts/agent-notes.ts) 从每篇 Note 的路径和标题写成，不手改：加、挪、删 Note 或改了标题以后跑 \`bun run notes:catalog\`，过期了 \`bun run notes:verify\` 会报错。Note 放在哪、怎么写见 [README](.agents/notes/README.md)。`,
  ];
  for (const lifecycle of AGENT_NOTE_LIFECYCLES) {
    const here = notes.filter((n) => n.lifecycle === lifecycle);
    if (here.length === 0) continue;
    out.push("", `## ${lifecycle}（${here.length} 篇）`);
    for (const cls of AGENT_NOTE_CLASSES) {
      const these = here.filter((n) => n.cls === cls).sort((a, b) => b.rel.localeCompare(a.rel));
      if (these.length === 0) continue;
      out.push("", `### ${cls}`, "");
      for (const n of these) {
        const name = n.rel.split("/").at(-1) ?? "";
        const why = lifecycle === "rejected" ? (n.lines[2] ?? "").replace(/^Status: rejected/, "") : "";
        out.push(`- ${name.slice(0, 10)} [${title(n).replace(/[[\]]/g, "\\$&")}](.agents/notes/${n.rel})${why}`);
      }
    }
  }
  return out.join("\n") + "\n";
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const { notes, errors } = await walkAgentNoteTree();
  const catalog = catalogOf(notes);
  const file = Bun.file(resolve(agentNoteRoot, CATALOG));
  if (write) await Bun.write(file, catalog);
  else if (!(await file.exists()) || (await file.text()) !== catalog) errors.push(`${CATALOG}: out of date; run \`bun run notes:catalog\``);
  const all = [...errors, ...notes.flatMap(checkAgentNote)];
  for (const e of all) console.error(`agent notes: ${e}`);
  if (all.length > 0) process.exit(1);
  console.log(`agent notes: ${notes.length} notes ok${write ? `, ${CATALOG} written` : ""}`);
}
