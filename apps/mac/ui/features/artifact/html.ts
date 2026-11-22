import type { ArtifactBody, ArtifactDisplay, ArtifactKindValues, ArtifactType } from "@vibevalley/protocol";

type ArtifactKind = (typeof ArtifactKindValues)[number];

export function artifactSuffixOf(a: {
  readonly body: ArtifactBody | "store";
  readonly artifactType?: ArtifactType | undefined;
  readonly display?: ArtifactDisplay | undefined;
}): string {
  if (a.artifactType !== undefined) {
    switch (a.artifactType) {
      case "docs":
        return ".doc.md";
      case "outline":
        return ".outline.md";
      case "slides":
        return ".slide.html";
      case "dashboard":
        return ".dashboard.html";
      case "motion":
        return ".motion.html";
      case "whiteboard":
        return ".whiteboard";
      case "design":
        return ".visual.html";
      case "design-system":
        return ".design-system.json";
    }
  }
  if (a.body === "blocks") return ".doc.md";
  switch (a.display ?? "page") {
    case "slides":
      return ".slide.html";
    case "motion":
      return ".motion.html";
    case "page":
      return ".html";
  }
}

export function inferDisplayFromContent(content: string | undefined): ArtifactDisplay | undefined {
  if (content === undefined || content.trim() === "") return undefined;
  if (/\bvv\.timeline\s*\(/u.test(content)) return "motion";
  if (/<section\b[^>]*>/iu.test(content) && (/<section\b[^>]*>[\s\S]*?<section\b[^>]*>/iu.test(content) || /\bclass=["'][^"']*\bslide\b/iu.test(content))) {
    return "slides";
  }
  return undefined;
}

export interface InferredArtifactName {
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly display?: ArtifactDisplay | undefined;
  readonly artifactType?: ArtifactType | undefined;
}

export function inferArtifactFromName(name: string, content?: string): InferredArtifactName {
  const trimmed = name.trim();
  const rules: readonly {
    readonly re: RegExp;
    readonly kind: ArtifactKind;
    readonly display?: ArtifactDisplay | "infer";
    readonly artifactType?: ArtifactType;
  }[] = [
    { re: /^(.+?)\.(?:slide|slides)\.html$/iu, kind: "html", display: "slides", artifactType: "slides" },
    { re: /^(.+?)\.(?:visual|canvas|design)\.html$/iu, kind: "html", display: "page", artifactType: "design" },
    { re: /^(.+?)\.dashboard\.html$/iu, kind: "html", display: "page", artifactType: "dashboard" },
    { re: /^(.+?)\.motion\.html$/iu, kind: "html", display: "motion", artifactType: "motion" },
    { re: /^(.+?)\.whiteboard(?:\.json|\.html)?$/iu, kind: "html", display: "page", artifactType: "whiteboard" },
    { re: /^(.+?)\.(?:design-system|tokens)\.json$/iu, kind: "html", display: "page", artifactType: "design-system" },
    { re: /^(.+?)\.(?:page\.html|html|htm)$/iu, kind: "html", display: "infer" },
    { re: /^(.+?)\.outline\.md$/iu, kind: "markdown", artifactType: "outline" },
    { re: /^(.+?)\.(?:doc\.md|md|markdown)$/iu, kind: "markdown", artifactType: "docs" },
  ];
  for (const r of rules) {
    const m = r.re.exec(trimmed);
    if (!m) continue;
    const title = m[1]?.trim() || trimmed;
    if (r.kind === "markdown") return { title, kind: "markdown", ...(r.artifactType !== undefined ? { artifactType: r.artifactType } : {}) };
    const display = r.display === "infer" ? (inferDisplayFromContent(content) ?? "page") : r.display;
    return {
      title,
      kind: "html",
      ...(display !== undefined ? { display } : {}),
      ...(r.artifactType !== undefined ? { artifactType: r.artifactType } : {}),
    };
  }
  const byContent = inferDisplayFromContent(content);
  if (byContent !== undefined) return { title: trimmed, kind: "html", display: byContent };
  if (content !== undefined && /^\s*(?:<!doctype\s+html|<html\b|<section\b)/iu.test(content)) {
    return { title: trimmed, kind: "html", display: "page" };
  }
  return { title: trimmed, kind: "markdown" };
}
