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

const CARD_LIKE_BLOCKS: ReadonlySet<DocBlock["type"]> = new Set([
  "kpi",
  "table",
  "callout",
  "code",
  "diagram",
  "chart",
  "baseEmbed",
  "media",
  "compare",
  "quote",
  "issueCard",
  "issueList",
  "preview",
  "bookmark",
  "math",
  "columns",
  "toggle",
  "toc",
  "pageBreak",
]);

export function isCardLikeBlock(type: DocBlock["type"]): boolean {
  return CARD_LIKE_BLOCKS.has(type);
}

export function outerBlockSpacingClass(block: DocBlock, prevBlock?: DocBlock): string {
  if (prevBlock === undefined) {
    return block.type === "heading" ? "mt-1 mb-0.5" : "";
  }
  if (block.type === "heading") {
    switch (block.level) {
      case 1:
        return "mt-5 mb-0.5";
      case 2:
        return "mt-4 mb-0.5";
      default:
        return "mt-3 mb-0.5";
    }
  }
  if ((block.type === "todo" && prevBlock.type === "todo") || (block.type === "list" && prevBlock.type === "list")) {
    return "mt-0";
  }
  if (prevBlock.type === "heading") {
    return "mt-1";
  }
  if (CARD_LIKE_BLOCKS.has(block.type) || CARD_LIKE_BLOCKS.has(prevBlock.type)) {
    return "mt-2.5";
  }
  return "mt-1.5";
}
