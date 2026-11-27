import type { Bounds } from "nsh";

import type { DocBlock } from "@vibevalley/protocol";

export interface FocusRequest {
  readonly blockId: string;
  readonly caret?: "start" | "end" | number | undefined;
  readonly itemIndex?: number | undefined;
  readonly seq: number;
}

export interface BlockEditorCaretRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BlockEditorProbeSnapshot {
  readonly focusedBlockId: string | null;
  readonly activeTestId: string | null;
  readonly value: string;
  readonly selection: { readonly start: number; readonly end: number } | null;
  readonly caretBounds: BlockEditorCaretRect | null;
  readonly caretPageBounds: BlockEditorCaretRect | null;
}

export interface BlockEditorTelemetryPatch {
  readonly focusedBlockId?: string | undefined;
  readonly activeTestId?: string | undefined;
  readonly value?: string | undefined;
  readonly selection?: { readonly start: number; readonly end: number } | undefined;
  readonly caretBounds?: BlockEditorCaretRect | undefined;
  readonly caretPageBounds?: BlockEditorCaretRect | undefined;
}

export function roundBounds(b: Bounds): BlockEditorCaretRect {
  return {
    x: Math.round(b.origin.x * 10) / 10,
    y: Math.round(b.origin.y * 10) / 10,
    width: Math.round(b.size.width * 10) / 10,
    height: Math.round(b.size.height * 10) / 10,
  };
}

export function resolveRequestedCaret(caret: "start" | "end" | number | undefined, textLength: number): number {
  if (caret === "start") return 0;
  if (caret === "end" || caret === undefined) return textLength;
  return Math.max(0, Math.min(textLength, caret));
}

export function headingTextClass(level: number): string {
  switch (level) {
    case 1:
      return "text-2xl font-bold leading-8";
    case 2:
      return "text-xl font-semibold leading-7";
    default:
      return "text-base font-semibold leading-6";
  }
}

export function outerBlockSpacingClass(block: DocBlock): string {
  if (block.type !== "heading") return "";
  switch (block.level) {
    case 1:
      return "mt-5 mb-0.5";
    case 2:
      return "mt-4 mb-0.5";
    default:
      return "mt-2.5";
  }
}
