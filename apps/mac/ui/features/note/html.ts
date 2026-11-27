import { type DocBlock, NOTE_TYPE_SPECS, NOTE_TYPES, type NoteType } from "@vibevalley/protocol";

export function entryPathOf(noteType: NoteType): string {
  return NOTE_TYPE_SPECS[noteType].entryPath;
}

export function noteSuffixOf(n: { readonly noteType: NoteType }): string {
  return NOTE_TYPE_SPECS[n.noteType].exportSuffix;
}

export interface InferredNoteName {
  readonly title: string;
  readonly noteType: NoteType;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const EXTRA_NAME_PATTERNS: Record<NoteType, readonly RegExp[]> = {
  doc: [/^(.+?)\.(?:doc\.md|outline\.json|outline\.md|slides?\.json|diagram\.json|dashboard\.json|prototype\.html|page\.html|md|markdown|html|htm)$/iu],
  base: [/^(.+?)\.(?:base\.json|sheet\.json|csv)$/iu],
  canvas: [/^(.+?)\.(?:canvas\.json|whiteboard(?:\.json|\.html)?|design\.json|design-system\.json|tokens\.json)$/iu],
  media: [/^(.+?)\.(?:media\.json|motion\.json|storyboard\.json)$/iu],
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

export interface DocDocumentPayload {
  readonly version: 1;
  readonly blocks: readonly DocBlock[];
}

/** Converts simple Markdown lines into a canonical `structure/doc.json` payload for client-side seed creation. */
export function buildDocFromMarkdown(title: string, markdown: string): DocDocumentPayload {
  const blocks: DocBlock[] = [];
  let seq = 0;
  const nextId = () => `b${++seq}`;

  const lines = markdown.split(/\r?\n/u);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (!line) {
      i += 1;
      continue;
    }

    if (line === "---" || line === "***") {
      blocks.push({ id: nextId(), type: "divider" });
      i += 1;
      continue;
    }

    const fence = /^```(\S*)$/u.exec(line);
    if (fence) {
      const lang = fence[1]?.trim() ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      if (lang.toLowerCase() === "mermaid") {
        blocks.push({ id: nextId(), type: "diagram", source: body.join("\n") });
      } else {
        blocks.push({ id: nextId(), type: "code", ...(lang ? { language: lang } : {}), code: body.join("\n") });
      }
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (headingMatch) {
      blocks.push({
        id: nextId(),
        type: "heading",
        level: headingMatch[1]?.length ?? 1,
        text: headingMatch[2]?.trim() ?? "",
      });
      i += 1;
      continue;
    }

    const todoMatch = /^[-*]\s+\[([ xX])\]\s*(.*)$/u.exec(line);
    if (todoMatch) {
      blocks.push({
        id: nextId(),
        type: "todo",
        checked: todoMatch[1]?.toLowerCase() === "x",
        text: todoMatch[2]?.trim() ?? "",
      });
      i += 1;
      continue;
    }

    const bulletMatch = /^[-*]\s+(.*)$/u.exec(line);
    if (bulletMatch) {
      const items: string[] = [bulletMatch[1]?.trim() ?? ""];
      i += 1;
      while (i < lines.length) {
        const nextLine = (lines[i] ?? "").trim();
        if (/^[-*]\s+\[([ xX])\]/u.test(nextLine)) break;
        const m = /^[-*]\s+(.*)$/u.exec(nextLine);
        if (!m) break;
        items.push(m[1]?.trim() ?? "");
        i += 1;
      }
      blocks.push({ id: nextId(), type: "list", ordered: false, items });
      continue;
    }

    const orderedMatch = /^\d+\.\s+(.*)$/u.exec(line);
    if (orderedMatch) {
      const items: string[] = [orderedMatch[1]?.trim() ?? ""];
      i += 1;
      while (i < lines.length) {
        const m = /^\d+\.\s+(.*)$/u.exec((lines[i] ?? "").trim());
        if (!m) break;
        items.push(m[1]?.trim() ?? "");
        i += 1;
      }
      blocks.push({ id: nextId(), type: "list", ordered: true, items });
      continue;
    }

    const quoteMatch = /^>\s?(.*)$/u.exec(line);
    if (quoteMatch) {
      blocks.push({ id: nextId(), type: "quote", text: quoteMatch[1]?.trim() ?? "" });
      i += 1;
      continue;
    }

    blocks.push({ id: nextId(), type: "prose", text: line });
    i += 1;
  }

  if (blocks.length === 0) {
    blocks.push({ id: "b1", type: "heading", level: 1, text: title.trim() || "Untitled" }, { id: "b2", type: "prose", text: "" });
  }

  return { version: 1, blocks };
}
