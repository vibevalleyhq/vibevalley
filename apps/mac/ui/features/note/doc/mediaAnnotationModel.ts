import {
  type DocBlock,
  type MediaAnnotation,
  type MediaAnnotationRect,
  type MediaAnnotationSeverity,
  MediaAnnotationSeverityValues,
  type MediaAnnotationStatus,
} from "@vibevalley/protocol";

export interface ContainedImageFrame {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface SeverityVisual {
  readonly severity: MediaAnnotationSeverity;
  readonly token: "berry" | "wheat" | "water" | "accent";
  readonly badgeBgClass: string;
  readonly badgeTextClass: string;
  readonly pillBgClass: string;
  readonly pillTextClass: string;
  readonly mixToken?: "water" | undefined;
}

export interface DocAnnotationRef {
  readonly blockId: string;
  readonly annotation: MediaAnnotation;
}

export interface DocAnnotationIndex {
  readonly byAnnotationId: ReadonlyMap<string, DocAnnotationRef>;
  readonly byBaseRowId: ReadonlyMap<string, DocAnnotationRef>;
}

export const ANNOTATION_SEVERITIES: readonly MediaAnnotationSeverity[] = MediaAnnotationSeverityValues;

const MIN_NORM_SIZE = 0.025;
const DEFAULT_PIN_SIZE = 0.06;
const CLICK_DRAG_THRESHOLD_PX = 8;

let annotationCounter = 0;

export function makeAnnotationId(prefix = "ann"): string {
  annotationCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${annotationCounter}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Clamps a normalized [0..1] rect so it stays fully within image bounds with a minimum legible footprint. */
export function clampNormalizedRect(rect: MediaAnnotationRect): MediaAnnotationRect {
  const w = Math.max(MIN_NORM_SIZE, Math.min(1, Number.isFinite(rect.w) ? rect.w : DEFAULT_PIN_SIZE));
  const h = Math.max(MIN_NORM_SIZE, Math.min(1, Number.isFinite(rect.h) ? rect.h : DEFAULT_PIN_SIZE));
  const x = Math.max(0, Math.min(1 - w, Number.isFinite(rect.x) ? rect.x : 0));
  const y = Math.max(0, Math.min(1 - h, Number.isFinite(rect.y) ? rect.y : 0));
  return {
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
    w: Number(w.toFixed(4)),
    h: Number(h.toFixed(4)),
  };
}

/**
 * Computes the rendered image sub-box inside a container using `objectFit: "contain"`.
 * Guarantees normalized [0..1] coordinates stay pixel-locked across 1x/2x Retina, Lightbox zoom, and resizes.
 */
export function computeContainedImageFrame(
  containerWidth: number,
  containerHeight: number,
  naturalWidth?: number,
  naturalHeight?: number,
): ContainedImageFrame {
  const cw = Math.max(1, containerWidth);
  const ch = Math.max(1, containerHeight);
  if (naturalWidth === undefined || naturalHeight === undefined || naturalWidth <= 0 || naturalHeight <= 0) {
    return { offsetX: 0, offsetY: 0, width: cw, height: ch };
  }
  const scale = Math.min(cw / naturalWidth, ch / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    offsetX: (cw - width) / 2,
    offsetY: (ch - height) / 2,
    width,
    height,
  };
}

/** Converts a normalized [0..1] rect to pixel coordinates inside the container. */
export function normalizedRectToPixels(rect: MediaAnnotationRect, frame: ContainedImageFrame): PixelRect {
  const safe = clampNormalizedRect(rect);
  return {
    left: Math.round(frame.offsetX + safe.x * frame.width),
    top: Math.round(frame.offsetY + safe.y * frame.height),
    width: Math.max(18, Math.round(safe.w * frame.width)),
    height: Math.max(18, Math.round(safe.h * frame.height)),
  };
}

/** Converts two container-local drag points into a normalized [0..1] rect relative to the image frame. */
export function rectFromDragPoints(startX: number, startY: number, endX: number, endY: number, frame: ContainedImageFrame): MediaAnnotationRect {
  const dx = Math.abs(endX - startX);
  const dy = Math.abs(endY - startY);
  const fw = Math.max(1, frame.width);
  const fh = Math.max(1, frame.height);

  if (dx < CLICK_DRAG_THRESHOLD_PX && dy < CLICK_DRAG_THRESHOLD_PX) {
    const cx = clamp01((startX - frame.offsetX) / fw);
    const cy = clamp01((startY - frame.offsetY) / fh);
    return clampNormalizedRect({
      x: cx - DEFAULT_PIN_SIZE / 2,
      y: cy - DEFAULT_PIN_SIZE / 2,
      w: DEFAULT_PIN_SIZE,
      h: DEFAULT_PIN_SIZE,
    });
  }

  const x0 = clamp01((Math.min(startX, endX) - frame.offsetX) / fw);
  const y0 = clamp01((Math.min(startY, endY) - frame.offsetY) / fh);
  const x1 = clamp01((Math.max(startX, endX) - frame.offsetX) / fw);
  const y1 = clamp01((Math.max(startY, endY) - frame.offsetY) / fh);

  return clampNormalizedRect({
    x: x0,
    y: y0,
    w: Math.max(MIN_NORM_SIZE, x1 - x0),
    h: Math.max(MIN_NORM_SIZE, y1 - y0),
  });
}

/** Translates a normalized rect by a pixel delta within the contained image frame, clamped to [0..1]. */
export function translateNormalizedRect(rect: MediaAnnotationRect, dxPx: number, dyPx: number, frame: ContainedImageFrame): MediaAnnotationRect {
  const safe = clampNormalizedRect(rect);
  const fw = Math.max(1, frame.width);
  const fh = Math.max(1, frame.height);
  return clampNormalizedRect({
    x: safe.x + dxPx / fw,
    y: safe.y + dyPx / fh,
    w: safe.w,
    h: safe.h,
  });
}

/** Computes a non-overlapping popover anchor inside the container beside the selected annotation rect. */
export function popoverPositionForRect(
  rectPx: PixelRect,
  containerWidth: number,
  containerHeight: number,
  popoverWidth = 264,
  popoverHeight = 168,
): { readonly left: number; readonly top: number } {
  const pad = 8;
  const cw = Math.max(popoverWidth + pad * 2, containerWidth);
  const ch = Math.max(popoverHeight + pad * 2, containerHeight);
  const rightSpace = cw - (rectPx.left + rectPx.width) - pad;
  const leftSpace = rectPx.left - pad;

  let left: number;
  if (rightSpace >= popoverWidth) {
    left = rectPx.left + rectPx.width + 8;
  } else if (leftSpace >= popoverWidth) {
    left = rectPx.left - popoverWidth - 8;
  } else {
    left = Math.max(pad, Math.min(cw - popoverWidth - pad, rectPx.left));
  }

  const top = Math.max(pad, Math.min(ch - popoverHeight - pad, rectPx.top));
  return { left: Math.round(left), top: Math.round(top) };
}

export function severityVisualOf(severity: MediaAnnotationSeverity): SeverityVisual {
  switch (severity) {
    case "p0":
      return {
        severity,
        token: "berry",
        badgeBgClass: "bg-berry",
        badgeTextClass: "text-paper",
        pillBgClass: "bg-bad-soft",
        pillTextClass: "text-berry",
      };
    case "p1":
      return {
        severity,
        token: "wheat",
        badgeBgClass: "bg-wheat",
        badgeTextClass: "text-bark-950",
        pillBgClass: "bg-warn-soft",
        pillTextClass: "text-warn-ink",
      };
    case "p2":
      return {
        severity,
        token: "water",
        badgeBgClass: "bg-water",
        badgeTextClass: "text-paper",
        pillBgClass: "",
        pillTextClass: "text-water",
        mixToken: "water",
      };
    case "ux":
      return {
        severity,
        token: "accent",
        badgeBgClass: "bg-accent",
        badgeTextClass: "text-paper",
        pillBgClass: "bg-ok-soft",
        pillTextClass: "text-ok-ink",
      };
  }
}

export function nextAnnotationNumber(annotations: readonly { readonly number: number }[]): number {
  let max = 0;
  for (const a of annotations) {
    if (Number.isFinite(a.number) && a.number > max) max = Math.floor(a.number);
  }
  return max + 1;
}

export function filterVisibleAnnotations<T extends { readonly status: MediaAnnotationStatus }>(
  annotations: readonly T[],
  showOverlay: boolean,
  unresolvedOnly: boolean,
): readonly T[] {
  if (!showOverlay) return [];
  if (!unresolvedOnly) return annotations;
  return annotations.filter((a) => a.status !== "resolved");
}

/** Builds O(1) lookup maps from annotation ID and linked Base row ID to owning block & annotation across a Doc. */
export function buildDocAnnotationIndex(blocks: readonly DocBlock[]): DocAnnotationIndex {
  const byAnnotationId = new Map<string, DocAnnotationRef>();
  const byBaseRowId = new Map<string, DocAnnotationRef>();

  const walk = (list: readonly DocBlock[]) => {
    for (const block of list) {
      if ((block.type === "media" || block.type === "compare") && block.annotations !== undefined) {
        for (const annotation of block.annotations) {
          const ref: DocAnnotationRef = { blockId: block.id, annotation };
          byAnnotationId.set(annotation.id, ref);
          if (annotation.baseRowId !== undefined && annotation.baseRowId !== "") {
            byBaseRowId.set(annotation.baseRowId, ref);
          }
        }
      }
      if (block.type === "columns") {
        for (const col of block.columns) walk(col.blocks);
      }
      if (block.children !== undefined) walk(block.children);
    }
  };
  walk(blocks);

  return { byAnnotationId, byBaseRowId };
}
