import { z } from "zod";

export interface VdpUiBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const VdpUiBoundsSchema: z.ZodType<VdpUiBounds> = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export interface VdpLayoutNode {
  readonly id: string;
  readonly role: string;
  readonly surface?: string | undefined;
  readonly text?: string | undefined;
  readonly bounds?: VdpUiBounds | undefined;
  readonly localBounds?: VdpUiBounds | undefined;
  readonly lineCount?: number | undefined;
  readonly focused?: boolean | undefined;
  readonly pressable: boolean;
  readonly children?: readonly VdpLayoutNode[] | undefined;
}

const optString = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);
const optBounds = VdpUiBoundsSchema.nullish().transform((v) => v ?? undefined);
const optLineCount = z
  .number()
  .int()
  .nonnegative()
  .nullish()
  .transform((v) => v ?? undefined);
const optBool = z
  .boolean()
  .nullish()
  .transform((v) => v ?? undefined);

const VdpLayoutNodeSchema: z.ZodType<VdpLayoutNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    role: z.string(),
    surface: optString,
    text: optString,
    bounds: optBounds,
    localBounds: optBounds,
    lineCount: optLineCount,
    focused: optBool,
    pressable: z.boolean().default(false),
    children: z
      .array(VdpLayoutNodeSchema)
      .nullish()
      .transform((v) => v ?? undefined),
  }),
);

export interface VdpLayoutDump {
  readonly viewport: VdpUiBounds;
  readonly scaleFactor: number;
  readonly themeDark: boolean;
  readonly route?: string | undefined;
  readonly surfaces: readonly VdpLayoutNode[];
}

export const VdpLayoutDumpSchema: z.ZodType<VdpLayoutDump> = z.object({
  viewport: VdpUiBoundsSchema,
  scaleFactor: z.number(),
  themeDark: z.boolean().default(false),
  route: optString,
  surfaces: z.array(VdpLayoutNodeSchema).default([]),
});

export interface FlattenedLayoutNode {
  readonly key: string;
  readonly id: string;
  readonly surface: string;
  readonly role: string;
  readonly path: string;
  readonly bounds: VdpUiBounds | undefined;
  readonly lineCount: number | undefined;
  readonly focused: boolean | undefined;
  readonly pressable: boolean;
  readonly text: string | undefined;
}

export interface NodeBoundsDelta {
  readonly key: string;
  readonly id: string;
  readonly dx: number;
  readonly dy: number;
  readonly dWidth: number;
  readonly dHeight: number;
  readonly maxDelta: number;
  readonly before: VdpUiBounds;
  readonly after: VdpUiBounds;
}

export interface LayoutDiffResult {
  readonly shiftedNodes: readonly NodeBoundsDelta[];
  readonly maxDeltaPx: number;
  readonly addedIds: readonly string[];
  readonly removedIds: readonly string[];
}

export interface InlineStabilityOptions {
  readonly targetId: string;
  readonly tolerancePx?: number | undefined;
  readonly allowTargetWidthChange?: boolean | undefined;
  readonly ignoreIdPrefixes?: readonly string[] | undefined;
}

const DEFAULT_TRANSIENT_OVERLAY_PREFIXES = ["doc-format-bar-", "doc-presence-badge-", "whiteboard-presence-badge-", "doc-slash-menu-", "doc-wikilink-menu-"];

/** Keyed by `<surface>::<id>`; first occurrence wins per surface. */
export function flattenLayoutDump(dump: VdpLayoutDump): Map<string, FlattenedLayoutNode> {
  const out = new Map<string, FlattenedLayoutNode>();
  const walk = (node: VdpLayoutNode, surface: string, parentPath: string) => {
    const path = parentPath ? `${parentPath}/${node.id}` : node.id;
    const key = `${surface}::${node.id}`;
    if (!out.has(key)) {
      out.set(key, {
        key,
        id: node.id,
        surface,
        role: node.role,
        path,
        bounds: node.bounds ?? undefined,
        lineCount: node.lineCount ?? undefined,
        focused: node.focused ?? undefined,
        pressable: node.pressable,
        text: node.text ?? undefined,
      });
    }
    for (const child of node.children ?? []) {
      walk(child, surface, path);
    }
  };
  for (const surfaceRoot of dump.surfaces) {
    const surfaceName = surfaceRoot.surface ?? surfaceRoot.id.replace(/^view:/u, "");
    walk(surfaceRoot, surfaceName, "");
  }
  return out;
}

function findNodeById(map: ReadonlyMap<string, FlattenedLayoutNode>, id: string): FlattenedLayoutNode | undefined {
  for (const entry of map.values()) {
    if (entry.id === id) return entry;
  }
  return undefined;
}

function shouldIgnoreOverlay(id: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => id.startsWith(prefix));
}

function computeDelta(before: FlattenedLayoutNode, after: FlattenedLayoutNode): NodeBoundsDelta | undefined {
  if (!before.bounds || !after.bounds) return undefined;
  const dx = Math.round((after.bounds.x - before.bounds.x) * 100) / 100;
  const dy = Math.round((after.bounds.y - before.bounds.y) * 100) / 100;
  const dWidth = Math.round((after.bounds.width - before.bounds.width) * 100) / 100;
  const dHeight = Math.round((after.bounds.height - before.bounds.height) * 100) / 100;
  const maxDelta = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dWidth), Math.abs(dHeight));
  return { key: before.key, id: before.id, dx, dy, dWidth, dHeight, maxDelta, before: before.bounds, after: after.bounds };
}

export function diffLayoutDumps(
  before: VdpLayoutDump,
  after: VdpLayoutDump,
  options?: { readonly tolerancePx?: number | undefined; readonly ignoreIdPrefixes?: readonly string[] | undefined },
): LayoutDiffResult {
  const tol = options?.tolerancePx ?? 0.5;
  const prefixes = options?.ignoreIdPrefixes ?? DEFAULT_TRANSIENT_OVERLAY_PREFIXES;
  const beforeMap = flattenLayoutDump(before);
  const afterMap = flattenLayoutDump(after);
  const shiftedNodes: NodeBoundsDelta[] = [];
  const addedIds: string[] = [];
  const removedIds: string[] = [];
  let maxDeltaPx = 0;

  for (const [key, prev] of beforeMap) {
    if (shouldIgnoreOverlay(prev.id, prefixes)) continue;
    const next = afterMap.get(key);
    if (!next) {
      removedIds.push(prev.id);
      continue;
    }
    const delta = computeDelta(prev, next);
    if (delta) {
      if (delta.maxDelta > maxDeltaPx) maxDeltaPx = delta.maxDelta;
      if (delta.maxDelta > tol) {
        shiftedNodes.push(delta);
      }
    }
  }
  for (const [key, next] of afterMap) {
    if (shouldIgnoreOverlay(next.id, prefixes)) continue;
    if (!beforeMap.has(key)) {
      addedIds.push(next.id);
    }
  }
  return { shiftedNodes, maxDeltaPx, addedIds, removedIds };
}

export function assertInlineLayoutStable(before: VdpLayoutDump, after: VdpLayoutDump, opts: InlineStabilityOptions): LayoutDiffResult {
  const tol = opts.tolerancePx ?? 0.5;
  const prefixes = opts.ignoreIdPrefixes ?? DEFAULT_TRANSIENT_OVERLAY_PREFIXES;
  const beforeMap = flattenLayoutDump(before);
  const afterMap = flattenLayoutDump(after);

  const prevTarget = findNodeById(beforeMap, opts.targetId);
  const nextTarget = findNodeById(afterMap, opts.targetId);
  if (!prevTarget || !nextTarget) {
    throw new Error(`inline layout target "${opts.targetId}" missing (before=${prevTarget !== undefined}, after=${nextTarget !== undefined})`);
  }
  if (!prevTarget.bounds || !nextTarget.bounds) {
    throw new Error(`inline layout target "${opts.targetId}" lacks measured bounds`);
  }
  if (prevTarget.lineCount !== undefined && nextTarget.lineCount !== undefined && prevTarget.lineCount !== nextTarget.lineCount) {
    throw new Error(
      `inline layout target "${opts.targetId}" changed lineCount (${prevTarget.lineCount} -> ${nextTarget.lineCount}); non-wrapping edit violated`,
    );
  }

  const targetDelta = computeDelta(prevTarget, nextTarget);
  if (targetDelta) {
    const heightShifted = Math.abs(targetDelta.dy) > tol || Math.abs(targetDelta.dHeight) > tol;
    const widthShifted = opts.allowTargetWidthChange !== true && (Math.abs(targetDelta.dx) > tol || Math.abs(targetDelta.dWidth) > tol);
    if (heightShifted || widthShifted) {
      throw new Error(
        `inline layout target "${opts.targetId}" shifted during non-wrapping edit: Δ=(x:${targetDelta.dx}, y:${targetDelta.dy}, w:${targetDelta.dWidth}, h:${targetDelta.dHeight})`,
      );
    }
  }

  const diff = diffLayoutDumps(before, after, { tolerancePx: tol, ignoreIdPrefixes: prefixes });
  const unexpectedShifts = diff.shiftedNodes.filter((n) => {
    if (n.id === opts.targetId && opts.allowTargetWidthChange === true) {
      return Math.abs(n.dy) > tol || Math.abs(n.dHeight) > tol;
    }
    return true;
  });
  if (unexpectedShifts.length > 0) {
    const sample = unexpectedShifts
      .slice(0, 6)
      .map((s) => `${s.id}(dx=${s.dx},dy=${s.dy},dw=${s.dWidth},dh=${s.dHeight})`)
      .join(", ");
    throw new Error(`non-wrapping edit on "${opts.targetId}" shifted ${unexpectedShifts.length} node(s): ${sample}`);
  }
  return diff;
}
