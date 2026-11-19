import { type ArtifactEntry, type ArtifactEntryKind, type ArtifactEntryWriteInput, type ArtifactType, ArtifactTypeValues } from "@vibevalley/protocol";

export { ArtifactTypeValues };
export type { ArtifactEntry, ArtifactEntryKind, ArtifactEntryWriteInput, ArtifactType };

const entryPathMax = 240;
const hasControlChar = (s: string) => {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

/** undefined when valid (unlike string-returning xProblem helpers). */
export function entryPathProblem(path: string): string | undefined {
  if (path.length === 0) return "empty path";
  if (path.length > entryPathMax) return `exceeds ${entryPathMax} characters`;
  if (hasControlChar(path)) return "contains control characters";
  if (path.includes("\\")) return "use forward slashes (/)";
  if (path.startsWith("/") || path.endsWith("/")) return "must be relative without leading or trailing /";
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "") return "contains empty path segment (//)";
    if (part === "." || part === "..") return "dot path segments are not allowed";
  }
  return undefined;
}

const assetExtensions: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const textExtensions: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".md": "text/markdown",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".json": "application/json",
};

function extOf(path: string): string {
  const base = path.split("/").at(-1) ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

export function inferEntryKind(path: string): ArtifactEntryKind {
  const ext = extOf(path);
  if (ext === ".json") return "json";
  if (ext in assetExtensions) return "asset";
  if (path.startsWith("datasets/") || path.startsWith("elements/") || path.startsWith("board/") || path.startsWith("dash/") || path === "film/meta") {
    return "json";
  }
  if (path === "film/script") return "text";
  return "text";
}

export function inferEntryMime(path: string, kind: ArtifactEntryKind): string {
  if (kind === "json") return "application/json";
  const ext = extOf(path);
  if (kind === "asset") return assetExtensions[ext] ?? "application/octet-stream";
  if (path === "film/script") return "text/javascript";
  return textExtensions[ext] ?? "text/plain";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 7396 JSON Merge Patch: null deletes object keys, arrays replace wholesale, nested plain objects merge recursively. */
function jsonMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const base: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === null) {
      delete base[key];
    } else {
      base[key] = jsonMergePatch(base[key], patchValue);
    }
  }
  return base;
}

export type JsonTextResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly why: string };

export function applyJsonMergePatch(currentRaw: string | undefined, patchRaw: string): JsonTextResult {
  let target: unknown = {};
  if (currentRaw !== undefined && currentRaw !== "") {
    try {
      target = JSON.parse(currentRaw);
    } catch (e) {
      return { ok: false, why: e instanceof Error ? e.message : String(e) };
    }
  }
  let patch: unknown;
  try {
    patch = JSON.parse(patchRaw);
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, value: JSON.stringify(jsonMergePatch(target, patch)) };
}

export function formatStoreSummary(
  artifact: { readonly title: string; readonly artifactType?: ArtifactType | undefined; readonly seq: number },
  entries: readonly ArtifactEntry[],
): string {
  const header = `# ${artifact.title}\n\ntype: ${artifact.artifactType ?? "store"} · seq: ${artifact.seq} · entries: ${entries.length}`;
  if (entries.length === 0) return `${header}\n\n(empty store)`;
  const lines = entries.map((e) => `- \`${e.path}\` (${e.kind}, rev ${e.rev}, ${e.size} B)`);
  const metaPaths = new Set([
    "project/deck.json",
    "project/canvas.json",
    "project/design-system.json",
    "board/meta",
    "film/meta",
    "dash/params",
    "project/README.md",
  ]);
  const snippets = entries
    .filter((e) => e.value !== undefined && (metaPaths.has(e.path) || e.path.startsWith("datasets/")) && e.value.length <= 4000)
    .slice(0, 6)
    .map((e) => `\n## ${e.path}\n\n\`\`\`${e.kind === "json" ? "json" : "markdown"}\n${e.value}\n\`\`\``);
  return `${header}\n\n## Entries\n\n${lines.join("\n")}${snippets.join("")}`;
}
