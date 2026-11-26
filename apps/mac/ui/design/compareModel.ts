import { z } from "zod";

export const CompareAnnotationSideSchema = z.enum(["before", "after", "both"]);
export type CompareAnnotationSide = z.output<typeof CompareAnnotationSideSchema>;

export const CompareAnnotationToneSchema = z.enum(["issue", "fixed", "note"]);
export type CompareAnnotationTone = z.output<typeof CompareAnnotationToneSchema>;

export const CompareImageSchema = z
  .object({
    attachment: z.exactOptional(z.string().min(1)),
    url: z.exactOptional(z.string().min(1)),
    label: z.exactOptional(z.string()),
  })
  .refine((v) => v.attachment !== undefined || v.url !== undefined, {
    message: "Compare image requires either attachment or url",
  });
export type CompareImage = z.output<typeof CompareImageSchema>;

const CompareRectSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);

export const CompareAnnotationSchema = z.object({
  n: z.number().int().positive(),
  side: z.exactOptional(CompareAnnotationSideSchema),
  rect: CompareRectSchema,
  tone: z.exactOptional(CompareAnnotationToneSchema),
  note: z.string(),
});
export type CompareAnnotation = z.output<typeof CompareAnnotationSchema>;

export const CompareSpecSchema = z
  .object({
    title: z.exactOptional(z.string()),
    before: z.exactOptional(CompareImageSchema),
    after: z.exactOptional(CompareImageSchema),
    image: z.exactOptional(CompareImageSchema),
    annotations: z.exactOptional(z.array(CompareAnnotationSchema)),
  })
  .refine((v) => v.before !== undefined || v.after !== undefined || v.image !== undefined, {
    message: "Compare spec requires before, after, or image",
  });
export type CompareSpec = z.output<typeof CompareSpecSchema>;

export type CompareMarkdownSegment =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "compare"; readonly raw: string; readonly spec: CompareSpec };

/** Parses and validates raw JSON from a fenced `compare` block; returns undefined on malformed input. */
export function parseCompareSpec(raw: string): CompareSpec | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const checked = CompareSpecSchema.safeParse(parsed);
  return checked.success ? checked.data : undefined;
}

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/u;

function isClosingFence(line: string, markerChar: string, minLength: number): boolean {
  const trimmed = line.replace(/^[ \t]{0,3}/u, "").replace(/[ \t]+$/u, "");
  if (trimmed.length < minLength) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== markerChar) return false;
  }
  return true;
}

function appendMarkdown(out: CompareMarkdownSegment[], text: string): void {
  const normalized = text.replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/gu, "");
  if (normalized.trim() === "") return;
  const last = out.at(-1);
  if (last?.kind === "markdown") {
    out[out.length - 1] = { kind: "markdown", text: `${last.text}\n${normalized}` };
  } else {
    out.push({ kind: "markdown", text: normalized });
  }
}

/**
 * Splits Markdown text around valid fenced ` ```compare ` blocks.
 * Unclosed blocks (e.g. while streaming) and malformed JSON blocks remain plain Markdown code fences.
 */
export function splitMarkdownCompareBlocks(text: string): CompareMarkdownSegment[] {
  if (text === "") return [];
  if (!text.includes("compare")) return [{ kind: "markdown", text }];

  const lines = text.split(/\r?\n/u);
  const segments: CompareMarkdownSegment[] = [];
  let mdLines: string[] = [];

  let fenceChar: string | undefined;
  let fenceLen = 0;
  let fenceIsCompare = false;
  let compareRawLines: string[] = [];
  let compareBodyLines: string[] = [];

  const flushMarkdown = () => {
    if (mdLines.length === 0) return;
    appendMarkdown(segments, mdLines.join("\n"));
    mdLines = [];
  };

  for (const line of lines) {
    if (fenceChar === undefined) {
      const match = FENCE_OPEN_RE.exec(line);
      if (match) {
        const marker = match[1] ?? "";
        const info = (match[2] ?? "").trim();
        fenceChar = marker[0];
        fenceLen = marker.length;
        if (info === "compare") {
          fenceIsCompare = true;
          compareRawLines = [line];
          compareBodyLines = [];
          continue;
        }
        fenceIsCompare = false;
        mdLines.push(line);
        continue;
      }
      mdLines.push(line);
      continue;
    }

    if (isClosingFence(line, fenceChar, fenceLen)) {
      if (fenceIsCompare) {
        const body = compareBodyLines.join("\n");
        const spec = parseCompareSpec(body);
        if (spec !== undefined) {
          flushMarkdown();
          segments.push({ kind: "compare", raw: body, spec });
        } else {
          mdLines.push(...compareRawLines, line);
        }
        compareRawLines = [];
        compareBodyLines = [];
      } else {
        mdLines.push(line);
      }
      fenceChar = undefined;
      fenceLen = 0;
      fenceIsCompare = false;
      continue;
    }

    if (fenceIsCompare) {
      compareRawLines.push(line);
      compareBodyLines.push(line);
    } else {
      mdLines.push(line);
    }
  }

  if (fenceIsCompare && compareRawLines.length > 0) {
    mdLines.push(...compareRawLines);
  }
  flushMarkdown();
  return segments;
}

function cleanImage(image: CompareImage): CompareImage {
  return {
    ...(image.attachment !== undefined ? { attachment: image.attachment } : {}),
    ...(image.url !== undefined ? { url: image.url } : {}),
    ...(image.label !== undefined && image.label.trim() !== "" ? { label: image.label.trim() } : {}),
  };
}

/** Serializes a validated `CompareSpec` into a fenced ` ```compare ` Markdown block. */
export function formatCompareBlock(spec: CompareSpec): string {
  const normalized: Record<string, unknown> = {};
  if (spec.title !== undefined && spec.title.trim() !== "") normalized.title = spec.title.trim();
  if (spec.before !== undefined) normalized.before = cleanImage(spec.before);
  if (spec.after !== undefined) normalized.after = cleanImage(spec.after);
  if (spec.image !== undefined) normalized.image = cleanImage(spec.image);
  if (spec.annotations !== undefined && spec.annotations.length > 0) {
    normalized.annotations = spec.annotations.map((item) => ({
      n: item.n,
      ...(item.side !== undefined ? { side: item.side } : {}),
      rect: item.rect,
      ...(item.tone !== undefined ? { tone: item.tone } : {}),
      note: item.note,
    }));
  }
  return `\`\`\`compare\n${JSON.stringify(normalized, null, 2)}\n\`\`\``;
}

/** Returns true when a spec has both Before and After images for dual comparison. */
export function isDualCompare(spec: CompareSpec): boolean {
  return spec.before !== undefined && spec.after !== undefined;
}
