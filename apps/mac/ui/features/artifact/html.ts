import { ARTIFACT_TYPE_SPECS, ARTIFACT_TYPES, type ArtifactType } from "@vibevalley/protocol";

export function entryPathOf(artifactType: ArtifactType): string {
  return ARTIFACT_TYPE_SPECS[artifactType].entryPath;
}

export function artifactSuffixOf(a: { readonly artifactType: ArtifactType }): string {
  return ARTIFACT_TYPE_SPECS[a.artifactType].exportSuffix;
}

export interface InferredArtifactName {
  readonly title: string;
  readonly artifactType: ArtifactType;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const EXTRA_NAME_PATTERNS: Record<ArtifactType, readonly RegExp[]> = {
  slides: [/^(.+?)\.(?:slide|slides)\.(?:json|html)$/iu],
  design: [/^(.+?)\.(?:visual|canvas|design)\.(?:json|html)$/iu],
  dashboard: [/^(.+?)\.dashboard\.(?:json|html)$/iu],
  motion: [/^(.+?)\.motion\.(?:json|html)$/iu],
  whiteboard: [/^(.+?)\.whiteboard(?:\.json|\.html)?$/iu],
  "design-system": [/^(.+?)\.(?:design-system|tokens)\.json$/iu],
  sheet: [],
  diagram: [],
  storyboard: [],
  outline: [/^(.+?)\.outline\.(?:json|md)$/iu],
  prototype: [/^(.+?)\.(?:prototype\.html|page\.html|html|htm)$/iu],
  docs: [/^(.+?)\.(?:doc\.md|md|markdown)$/iu],
};

// Longer compound suffixes (e.g. `.outline.json`, `.design-system.json`) must run before generic `.html` / `.md`.
const INFER_RULES: readonly { readonly re: RegExp; readonly artifactType: ArtifactType }[] = [...ARTIFACT_TYPES]
  .toSorted((a, b) => ARTIFACT_TYPE_SPECS[b].exportSuffix.length - ARTIFACT_TYPE_SPECS[a].exportSuffix.length)
  .flatMap((artifactType) => {
    const canonical = new RegExp(`^(.+?)${escapeRegExp(ARTIFACT_TYPE_SPECS[artifactType].exportSuffix)}$`, "iu");
    return [...EXTRA_NAME_PATTERNS[artifactType], canonical].map((re) => ({ re, artifactType }));
  });

export function inferArtifactFromName(name: string, content?: string): InferredArtifactName {
  const trimmed = name.trim();
  for (const r of INFER_RULES) {
    const m = r.re.exec(trimmed);
    if (!m) continue;
    return { title: m[1]?.trim() || trimmed, artifactType: r.artifactType };
  }
  if (content !== undefined && /^\s*(?:<!doctype\s+html|<html\b|<section\b)/iu.test(content)) {
    return { title: trimmed, artifactType: "prototype" };
  }
  return { title: trimmed, artifactType: "docs" };
}

export interface OutlineNode {
  readonly id: string;
  readonly text: string;
  readonly kind: "heading" | "bullet" | "todo";
  readonly checked?: boolean;
  readonly children: readonly string[];
}

export interface OutlineDocument {
  readonly version: number;
  readonly rootIds: readonly string[];
  readonly nodes: Readonly<Record<string, OutlineNode>>;
}

/** Converts simple Markdown headings/bullets/todos into a canonical `structure/outline.json` payload. */
export function buildOutlineFromMarkdown(title: string, markdown: string): OutlineDocument {
  const nodes: Record<string, OutlineNode> = {};
  const rootIds: string[] = [];
  let seq = 0;
  let currentHeadingId: string | undefined;

  const lines = markdown.split(/\r?\n/u);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const headingMatch = /^#{1,6}\s+(.+)$/u.exec(line);
    if (headingMatch) {
      const id = `n_${++seq}`;
      nodes[id] = { id, text: headingMatch[1]?.trim() ?? "", kind: "heading", children: [] };
      rootIds.push(id);
      currentHeadingId = id;
      continue;
    }
    const todoMatch = /^[-*]\s+\[([ xX])\]\s*(.*)$/u.exec(line);
    if (todoMatch) {
      const id = `n_${++seq}`;
      const node: OutlineNode = { id, text: todoMatch[2]?.trim() ?? "", kind: "todo", checked: todoMatch[1]?.toLowerCase() === "x", children: [] };
      nodes[id] = node;
      const parent = currentHeadingId !== undefined ? nodes[currentHeadingId] : undefined;
      if (currentHeadingId !== undefined && parent !== undefined) {
        nodes[currentHeadingId] = { ...parent, children: [...parent.children, id] };
      } else {
        rootIds.push(id);
      }
      continue;
    }
    const bulletMatch = /^[-*]\s*(.*)$/u.exec(line);
    const text = bulletMatch ? (bulletMatch[1]?.trim() ?? "") : line;
    const id = `n_${++seq}`;
    nodes[id] = { id, text, kind: "bullet", children: [] };
    const parent = currentHeadingId !== undefined ? nodes[currentHeadingId] : undefined;
    if (currentHeadingId !== undefined && parent !== undefined) {
      nodes[currentHeadingId] = { ...parent, children: [...parent.children, id] };
    } else {
      rootIds.push(id);
    }
  }

  if (rootIds.length === 0) {
    const label = title.trim() || "Untitled Outline";
    nodes.n_root = { id: "n_root", text: label, kind: "heading", children: [] };
    rootIds.push("n_root");
  }

  return { version: 1, rootIds, nodes };
}
