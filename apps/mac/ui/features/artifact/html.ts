import type { ArtifactType } from "@vibevalley/protocol";

export interface ArtifactTypeMeta {
  readonly entry: string;
  readonly suffix: string;
  readonly mime: string;
}

/** Mirrors `crates/core/src/artifact/manifest.rs::ALL_SPECS`. */
const ARTIFACT_TYPE_META: Record<ArtifactType, ArtifactTypeMeta> = {
  docs: { entry: "structure/index.md", suffix: ".md", mime: "text/markdown" },
  outline: { entry: "structure/outline.json", suffix: ".outline.json", mime: "application/json" },
  slides: { entry: "structure/deck.json", suffix: ".slides.json", mime: "application/json" },
  dashboard: { entry: "structure/dashboard.json", suffix: ".dashboard.json", mime: "application/json" },
  motion: { entry: "structure/timeline.json", suffix: ".motion.json", mime: "application/json" },
  whiteboard: { entry: "structure/board.json", suffix: ".whiteboard.json", mime: "application/json" },
  design: { entry: "structure/frames/main.json", suffix: ".design.json", mime: "application/json" },
  "design-system": { entry: "structure/tokens.json", suffix: ".design-system.json", mime: "application/json" },
  sheet: { entry: "structure/workbook.json", suffix: ".sheet.json", mime: "application/json" },
  prototype: { entry: "structure/index.html", suffix: ".html", mime: "text/html" },
  diagram: { entry: "structure/diagram.json", suffix: ".diagram.json", mime: "application/json" },
  storyboard: { entry: "structure/shots.json", suffix: ".storyboard.json", mime: "application/json" },
};

export function entryPathOf(artifactType: ArtifactType): string {
  return ARTIFACT_TYPE_META[artifactType].entry;
}

export function artifactSuffixOf(a: { readonly artifactType: ArtifactType }): string {
  return ARTIFACT_TYPE_META[a.artifactType].suffix;
}

export interface InferredArtifactName {
  readonly title: string;
  readonly artifactType: ArtifactType;
}

export function inferArtifactFromName(name: string, content?: string): InferredArtifactName {
  const trimmed = name.trim();
  const rules: readonly { readonly re: RegExp; readonly artifactType: ArtifactType }[] = [
    { re: /^(.+?)\.(?:slide|slides)\.(?:json|html)$/iu, artifactType: "slides" },
    { re: /^(.+?)\.(?:visual|canvas|design)\.(?:json|html)$/iu, artifactType: "design" },
    { re: /^(.+?)\.dashboard\.(?:json|html)$/iu, artifactType: "dashboard" },
    { re: /^(.+?)\.motion\.(?:json|html)$/iu, artifactType: "motion" },
    { re: /^(.+?)\.whiteboard(?:\.json|\.html)?$/iu, artifactType: "whiteboard" },
    { re: /^(.+?)\.(?:design-system|tokens)\.json$/iu, artifactType: "design-system" },
    { re: /^(.+?)\.sheet\.json$/iu, artifactType: "sheet" },
    { re: /^(.+?)\.diagram\.json$/iu, artifactType: "diagram" },
    { re: /^(.+?)\.storyboard\.json$/iu, artifactType: "storyboard" },
    { re: /^(.+?)\.outline\.(?:json|md)$/iu, artifactType: "outline" },
    { re: /^(.+?)\.(?:prototype\.html|page\.html|html|htm)$/iu, artifactType: "prototype" },
    { re: /^(.+?)\.(?:doc\.md|md|markdown)$/iu, artifactType: "docs" },
  ];
  for (const r of rules) {
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
