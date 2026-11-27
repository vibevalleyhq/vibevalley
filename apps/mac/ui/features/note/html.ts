import { z } from "zod";

import { type DocBlock, NOTE_TYPE_SPECS, NOTE_TYPES, type NoteType } from "@vibevalley/protocol";
import { DocBlock as DocBlockSchema, jsonString } from "@vibevalley/protocol/schema";

import { coreBridge } from "../../infra/rich";

export function entryPathOf(noteType: NoteType): string {
  return NOTE_TYPE_SPECS[noteType].entryPath;
}

export function noteSuffixOf(n: { readonly noteType: NoteType }): string {
  return NOTE_TYPE_SPECS[n.noteType].exportSuffix;
}

interface InferredNoteName {
  readonly title: string;
  readonly noteType: NoteType;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const EXTRA_NAME_PATTERNS: Record<NoteType, readonly RegExp[]> = {
  doc: [/^(.+?)\.(?:doc\.md|markdown|html|htm)$/iu],
  base: [/^(.+?)\.csv$/iu],
  canvas: [],
  media: [],
};

// Longer compound suffixes run before shorter generic suffixes.
const INFER_RULES: readonly { readonly re: RegExp; readonly noteType: NoteType }[] = [...NOTE_TYPES]
  .toSorted((a, b) => NOTE_TYPE_SPECS[b].exportSuffix.length - NOTE_TYPE_SPECS[a].exportSuffix.length)
  .flatMap((noteType) => {
    const canonical = new RegExp(`^(.+?)${escapeRegExp(NOTE_TYPE_SPECS[noteType].exportSuffix)}$`, "iu");
    return [...EXTRA_NAME_PATTERNS[noteType], canonical].map((re) => ({ re, noteType }));
  });

export function inferNoteFromName(name: string, _content?: string): InferredNoteName {
  const trimmed = name.trim();
  for (const r of INFER_RULES) {
    const m = r.re.exec(trimmed);
    if (!m) continue;
    return { title: m[1]?.trim() || trimmed, noteType: r.noteType };
  }
  return { title: trimmed, noteType: "doc" };
}

interface DocDocumentPayload {
  readonly version: 1;
  readonly blocks: readonly DocBlock[];
}

const DocBlockArrayJsonSchema = jsonString(z.array(DocBlockSchema));

/** Converts Markdown text into a canonical `structure/doc.json` payload via Rust `VvCore` (with a minimal prose fallback for headless `nsh test`). */
export function buildDocFromMarkdown(title: string, markdown: string, opts?: { readonly fallbackTitle?: boolean }): DocDocumentPayload {
  const json = coreBridge()?.markdownToBlocks?.(markdown);
  let blocks: DocBlock[] = [];
  if (json !== undefined) {
    const parsed = DocBlockArrayJsonSchema.safeParse(json);
    if (parsed.success) blocks = parsed.data;
  } else {
    const trimmed = markdown.trim();
    if (trimmed.length > 0) {
      blocks = [{ id: "b1", type: "prose", text: trimmed }];
    }
  }

  if (blocks.length === 0 && opts?.fallbackTitle !== false) {
    blocks = [
      { id: "b1", type: "heading", level: 1, text: title.trim() || "Untitled" },
      { id: "b2", type: "prose", text: "" },
    ];
  }

  return { version: 1, blocks };
}
