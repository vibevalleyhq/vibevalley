import { z } from "zod";

import type { CompareAnnotation, CompareAnnotationSide, CompareAnnotationTone, CompareImage, CompareMarkdownSegment, CompareSpec } from "@vibevalley/protocol";
import {
  CompareAnnotation as CompareAnnotationWire,
  CompareAnnotationSide as CompareAnnotationSideWire,
  CompareAnnotationTone as CompareAnnotationToneWire,
  CompareImage as CompareImageWire,
  CompareMarkdownSegment as CompareMarkdownSegmentWire,
  CompareSpec as CompareSpecWire,
} from "@vibevalley/protocol/schema";

import { coreBridge } from "../infra/rich";

export const CompareAnnotationSideSchema = CompareAnnotationSideWire;
export const CompareAnnotationToneSchema = CompareAnnotationToneWire;
export const CompareImageSchema = CompareImageWire.refine((v) => (v.attachment !== undefined && v.attachment !== "") || (v.url !== undefined && v.url !== ""), {
  message: "Compare image requires either attachment or url",
});
export const CompareAnnotationSchema = CompareAnnotationWire;
export const CompareSpecSchema = CompareSpecWire.refine((v) => v.before !== undefined || v.after !== undefined || v.image !== undefined, {
  message: "Compare spec requires before, after, or image",
});

export type { CompareAnnotation, CompareAnnotationSide, CompareAnnotationTone, CompareImage, CompareMarkdownSegment, CompareSpec };

const SegmentsSchema = z.array(CompareMarkdownSegmentWire);

/** Parses and validates raw JSON from a fenced `compare` block via Rust `VvCore`. */
export function parseCompareSpec(raw: string): CompareSpec | undefined {
  const json = coreBridge()?.parseCompareSpec?.(raw);
  if (!json) return undefined;
  const parsed = CompareSpecSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : undefined;
}

/** Splits Markdown text around valid fenced ` ```compare ` blocks via Rust `VvCore`. */
export function splitMarkdownCompareBlocks(text: string): CompareMarkdownSegment[] {
  if (text === "") return [];
  if (!text.includes("compare")) return [{ kind: "markdown", text }];
  const json = coreBridge()?.splitCompareBlocks?.(text);
  if (!json) return [{ kind: "markdown", text }];
  const parsed = SegmentsSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : [{ kind: "markdown", text }];
}

/** Serializes a validated `CompareSpec` into a fenced ` ```compare ` Markdown block via Rust `VvCore` (or plain fence in headless `nsh test`). */
export function formatCompareBlock(spec: CompareSpec): string {
  const formatted = coreBridge()?.formatCompareBlock?.(JSON.stringify(spec));
  if (formatted !== undefined && formatted !== null) return formatted;
  return `\`\`\`compare\n${JSON.stringify(spec, null, 2)}\n\`\`\``;
}

/** Returns true when a spec has both Before and After images for dual comparison. */
export function isDualCompare(spec: CompareSpec): boolean {
  return spec.before !== undefined && spec.after !== undefined;
}
