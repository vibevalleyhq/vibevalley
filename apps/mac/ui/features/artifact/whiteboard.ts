import { z } from "zod";

import type { ArtifactEntryWriteInput } from "@vibevalley/protocol";

import { type ShellTheme, themeVariables, typeVariables } from "./shell";

export const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const EndpointSchema = z.union([
  z.object({
    id: z.string(),
    side: z.exactOptional(z.enum(["top", "right", "bottom", "left", "n", "e", "s", "w"])),
  }),
  PointSchema,
]);

const TimelineMilestoneSchema = z.object({
  t: z.exactOptional(z.number()),
  x: z.exactOptional(z.number()),
  y: z.exactOptional(z.number()),
  label: z.string(),
  kind: z.exactOptional(z.enum(["major", "minor"])),
  tone: z.exactOptional(z.string()),
  caption: z.exactOptional(z.string()),
});

export const WhiteboardElementSchema = z.object({
  id: z.string(),
  type: z.enum(["shape", "container", "arrow", "text", "table", "svg", "html", "claim", "timeline", "path", "sticker"]),
  shape: z.exactOptional(z.string()),
  variant: z.exactOptional(z.enum(["title", "subtitle", "callout", "body"])),
  x: z.exactOptional(z.number()),
  y: z.exactOptional(z.number()),
  w: z.exactOptional(z.number()),
  h: z.exactOptional(z.number()),
  label: z.exactOptional(z.string()),
  text: z.exactOptional(z.string()),
  title: z.exactOptional(z.string()),
  body: z.exactOptional(z.string()),
  subtitle: z.exactOptional(z.string()),
  highlight: z.exactOptional(z.string()),
  icon: z.exactOptional(z.string()),
  badge: z.exactOptional(z.string()),
  align: z.exactOptional(z.enum(["left", "center", "right"])),
  fill: z.exactOptional(z.string()),
  stroke: z.exactOptional(z.string()),
  strokeWidth: z.exactOptional(z.number()),
  sticker: z.exactOptional(z.string()),
  stickerSvg: z.exactOptional(z.string()),
  curve: z.exactOptional(z.enum(["smooth", "orthogonal", "straight"])),
  style: z.exactOptional(z.enum(["solid", "dashed"])),
  head: z.exactOptional(z.enum(["arrow", "none"])),
  from: z.exactOptional(EndpointSchema),
  to: z.exactOptional(EndpointSchema),
  bends: z.exactOptional(z.array(PointSchema)),
  points: z.exactOptional(z.array(PointSchema)),
  milestones: z.exactOptional(z.array(TimelineMilestoneSchema)),
  headers: z.exactOptional(z.array(z.string())),
  rows: z.exactOptional(z.array(z.array(z.string()))),
  svg: z.exactOptional(z.string()),
  html: z.exactOptional(z.string()),
});

export const WhiteboardPresenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.exactOptional(z.enum(["coral", "teal", "blue", "leaf", "wheat", "lavender"])),
  x: z.number(),
  y: z.number(),
  status: z.exactOptional(z.string()),
});

export type WbPoint = z.output<typeof PointSchema>;
export type WbEndpoint = z.output<typeof EndpointSchema>;
export type WbElementData = z.output<typeof WhiteboardElementSchema>;
export type WbElement = WbElementData & { readonly rev: number; readonly raw: string };
export type WbPresence = z.output<typeof WhiteboardPresenceSchema>;

export type WbTool = "select" | "pan" | "text" | "container" | "sticky" | "pen" | "rect" | "sticker" | "arrow" | "timeline";
export type PlaceableTool = Exclude<WbTool, "select" | "pan" | "arrow" | "pen">;

export const FILL_OPTIONS = ["default", "sun", "peach", "leaf", "water", "lavender", "berry", "side"] as const;
export type WbFill = (typeof FILL_OPTIONS)[number];

export const WhiteboardBridgeMessageSchema = z.discriminatedUnion("vibevalley", [
  z.object({ vibevalley: z.literal("wb-ready") }),
  z.object({ vibevalley: z.literal("wb-select"), ids: z.array(z.string()).max(200) }),
  z.object({
    vibevalley: z.literal("wb-move"),
    moves: z.array(z.object({ id: z.string(), x: z.number(), y: z.number() })).max(200),
  }),
  z.object({
    vibevalley: z.literal("wb-resize"),
    id: z.string(),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }),
  z.object({
    vibevalley: z.literal("wb-create"),
    kind: z.enum(["rect", "sticky", "text", "container", "sticker", "timeline"]),
    x: z.number(),
    y: z.number(),
    sticker: z.exactOptional(z.string()),
  }),
  z.object({
    vibevalley: z.literal("wb-path"),
    points: z.array(PointSchema).min(2).max(2000),
  }),
  z.object({
    vibevalley: z.literal("wb-arrow"),
    fromId: z.string(),
    toId: z.string(),
    fromSide: z.exactOptional(z.enum(["n", "e", "s", "w"])),
    toSide: z.exactOptional(z.enum(["n", "e", "s", "w"])),
  }),
  z.object({ vibevalley: z.literal("wb-label"), id: z.string(), text: z.string(), body: z.exactOptional(z.string()) }),
  z.object({ vibevalley: z.literal("wb-delete"), ids: z.array(z.string()).min(1).max(200) }),
  z.object({ vibevalley: z.literal("wb-duplicate"), ids: z.array(z.string()).min(1).max(200) }),
  z.object({ vibevalley: z.literal("wb-tool"), tool: z.enum(["select", "pan", "text", "container", "sticky", "pen", "rect", "sticker", "arrow", "timeline"]) }),
  z.object({ vibevalley: z.literal("wb-undo") }),
  z.object({ vibevalley: z.literal("wb-redo") }),
  z.object({ vibevalley: z.literal("wb-chat") }),
  z.object({ vibevalley: z.literal("wb-template"), template: z.enum(["timeline", "architecture"]) }),
  z.object({ vibevalley: z.literal("wb-viewport"), zoom: z.number() }),
]);

export const WHITEBOARD_STICKERS = {
  "berry-lock":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M24 22c-6-6-10-4-12 2 6 3 10 2 14-1zm12 0c6-6 10-4 12 2-6 3-10 2-14-1z" fill="#74a046" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><circle cx="24" cy="30" r="8" fill="#8b63a8" stroke="#2a2520" stroke-width="2"/><circle cx="34" cy="27" r="8" fill="#9a72b8" stroke="#2a2520" stroke-width="2"/><circle cx="30" cy="36" r="8" fill="#7c5699" stroke="#2a2520" stroke-width="2"/><path d="M40 38v-4a6 6 0 0 1 12 0v4" fill="none" stroke="#2a2520" stroke-width="2.2" stroke-linecap="round"/><rect x="37" y="38" width="18" height="15" rx="4" fill="#a8c3e8" stroke="#2a2520" stroke-width="2"/><circle cx="46" cy="45" r="2.2" fill="#2a2520"/></svg>',
  "price-tag":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M18 14c-6 0-8 7-3 11" fill="none" stroke="#8b5a2b" stroke-width="2" stroke-linecap="round"/><path d="M18 14h24l12 16-22 22-14-14z" fill="#f3b07a" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><circle cx="25" cy="22" r="3" fill="#fcfcfb" stroke="#2a2520" stroke-width="1.8"/><text x="34" y="38" text-anchor="middle" font-family="Georgia,serif" font-size="18" font-weight="700" fill="#2a2520">$</text></svg>',
  "chart-board":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="12" y="10" width="40" height="44" rx="5" fill="#d9c6a3" stroke="#2a2520" stroke-width="2"/><rect x="17" y="15" width="30" height="34" rx="2" fill="#fcfcfb" stroke="#2a2520" stroke-width="1.6"/><rect x="24" y="7" width="16" height="6" rx="3" fill="#e5a93c" stroke="#2a2520" stroke-width="1.8"/><rect x="21" y="36" width="5" height="9" fill="#74a046" stroke="#2a2520" stroke-width="1.4"/><rect x="29" y="30" width="5" height="15" fill="#e5a93c" stroke="#2a2520" stroke-width="1.4"/><rect x="37" y="22" width="5" height="23" fill="#dd6f57" stroke="#2a2520" stroke-width="1.4"/><path d="M21 31l10-7 10-8" fill="none" stroke="#2a2520" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  crate:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="24" cy="24" r="6" fill="#8b63a8" stroke="#2a2520" stroke-width="1.8"/><circle cx="33" cy="22" r="6.5" fill="#9a72b8" stroke="#2a2520" stroke-width="1.8"/><circle cx="42" cy="25" r="6" fill="#7c5699" stroke="#2a2520" stroke-width="1.8"/><circle cx="29" cy="29" r="6" fill="#8b63a8" stroke="#2a2520" stroke-width="1.8"/><circle cx="38" cy="29" r="6" fill="#9a72b8" stroke="#2a2520" stroke-width="1.8"/><rect x="13" y="30" width="38" height="22" rx="3" fill="#d9a86c" stroke="#2a2520" stroke-width="2"/><path d="M13 38h38M13 45h38M25 30v22M39 30v22" stroke="#2a2520" stroke-width="1.6"/></svg>',
  storefront:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="12" y="26" width="40" height="28" rx="3" fill="#f7e8c4" stroke="#2a2520" stroke-width="2"/><path d="M10 14h44l3 12H7z" fill="#dd6f57" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><path d="M21 14v12M32 14v12M43 14v12" stroke="#fcfcfb" stroke-width="2.6"/><rect x="26" y="36" width="12" height="18" rx="2" fill="#e5a93c" stroke="#2a2520" stroke-width="1.8"/><rect x="16" y="33" width="7" height="9" rx="1.5" fill="#9fc5e8" stroke="#2a2520" stroke-width="1.6"/><rect x="41" y="33" width="7" height="9" rx="1.5" fill="#9fc5e8" stroke="#2a2520" stroke-width="1.6"/></svg>',
  bowl: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M44 12L35 28" stroke="#8b5a2b" stroke-width="3.5" stroke-linecap="round"/><path d="M12 28h40c0 14-8 24-20 24S12 42 12 28z" fill="#9d96e0" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><ellipse cx="32" cy="28" rx="20" ry="6" fill="#cfcbf5" stroke="#2a2520" stroke-width="2"/><ellipse cx="32" cy="29" rx="15" ry="4" fill="#6f5396"/></svg>',
  truck:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 64"><rect x="8" y="16" width="50" height="32" rx="4" fill="#89b8e6" stroke="#2a2520" stroke-width="2.2"/><path d="M58 24h16l10 11v13H58z" fill="#f3b07a" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/><path d="M62 28h10l6 7H62z" fill="#dcebf8" stroke="#2a2520" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 26h36M14 34h28" stroke="#fcfcfb" stroke-width="2.2" stroke-linecap="round"/><circle cx="24" cy="49" r="7" fill="#5e5852" stroke="#2a2520" stroke-width="2"/><circle cx="24" cy="49" r="2.8" fill="#f6f5f3"/><circle cx="72" cy="49" r="7" fill="#5e5852" stroke="#2a2520" stroke-width="2"/><circle cx="72" cy="49" r="2.8" fill="#f6f5f3"/></svg>',
  mascot:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M24 14l4-6 4 5 5-5 3 6" fill="#74a046" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><circle cx="32" cy="32" r="16" fill="#e8b8cc" stroke="#2a2520" stroke-width="2.2"/><circle cx="32" cy="32" r="11" fill="#f8e8ef" stroke="#2a2520" stroke-width="1.5"/><circle cx="27" cy="30" r="2.4" fill="#2a2520"/><circle cx="37" cy="30" r="2.4" fill="#2a2520"/><path d="M26 36c2.5 3.5 9.5 3.5 12 0" fill="none" stroke="#2a2520" stroke-width="2" stroke-linecap="round"/><path d="M16 32l-7-4M48 32l7-4M25 47l-3 9M39 47l3 9" stroke="#74a046" stroke-width="3" stroke-linecap="round"/></svg>',
  warning:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 10L8 52h48z" fill="#ffe380" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/><path d="M32 25v14" stroke="#2a2520" stroke-width="3" stroke-linecap="round"/><circle cx="32" cy="45" r="2.4" fill="#2a2520"/></svg>',
  lightbulb:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M22 36c-4-4-6-9-6-14a16 16 0 0 1 32 0c0 5-2 10-6 14l-2 6H24z" fill="#ffe380" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/><rect x="25" y="42" width="14" height="6" rx="2" fill="#d4d0ca" stroke="#2a2520" stroke-width="2"/><rect x="27" y="48" width="10" height="5" rx="2" fill="#aca59e" stroke="#2a2520" stroke-width="1.8"/></svg>',
  rocket:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 8c10 8 14 20 12 32H20C18 28 22 16 32 8z" fill="#fcfcfb" stroke="#2a2520" stroke-width="2.2" stroke-linejoin="round"/><path d="M20 30l-8 8 8 4M44 30l8 8-8 4" fill="#dd6f57" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><circle cx="32" cy="24" r="5" fill="#89b8e6" stroke="#2a2520" stroke-width="2"/><path d="M26 42l6 13 6-13" fill="#e5a93c" stroke="#2a2520" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  flag: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M18 10v44" stroke="#2a2520" stroke-width="2.6" stroke-linecap="round"/><path d="M18 13h28l-6 9 6 9H18z" fill="#dd6f57" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/></svg>',
  calendar:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="10" y="14" width="44" height="40" rx="6" fill="#fcfcfb" stroke="#2a2520" stroke-width="2.2"/><path d="M10 24h44" stroke="#2a2520" stroke-width="2"/><path d="M21 9v8M43 9v8" stroke="#2a2520" stroke-width="2.6" stroke-linecap="round"/><circle cx="24" cy="36" r="3" fill="#dd6f57"/><circle cx="34" cy="36" r="3" fill="#74a046"/><circle cx="44" cy="36" r="3" fill="#e5a93c"/></svg>',
  clock:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="21" fill="#fcfcfb" stroke="#2a2520" stroke-width="2.2"/><circle cx="32" cy="32" r="17" fill="#fff4d8"/><path d="M32 19v13l9 6" fill="none" stroke="#2a2520" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="21" fill="#b4cb7c" stroke="#2a2520" stroke-width="2.2"/><path d="M22 33l7 7 14-16" fill="none" stroke="#2a2520" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sparkles:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M28 10l4 14 14 4-14 4-4 14-4-14-14-4 14-4z" fill="#ffe380" stroke="#2a2520" stroke-width="2" stroke-linejoin="round"/><path d="M48 38l2.5 7 7 2.5-7 2.5-2.5 7-2.5-7-7-2.5 7-2.5z" fill="#f3b07a" stroke="#2a2520" stroke-width="1.8" stroke-linejoin="round"/></svg>',
} as const;

export type StickerId = keyof typeof WHITEBOARD_STICKERS;

const isStickerId = (value: string): value is StickerId => Object.hasOwn(WHITEBOARD_STICKERS, value);

export const STICKER_IDS: readonly StickerId[] = Object.keys(WHITEBOARD_STICKERS).filter(isStickerId);

export function resolveStickerSvg(sticker?: string, stickerSvg?: string): string | undefined {
  if (stickerSvg && stickerSvg.trim().startsWith("<svg")) return stickerSvg;
  if (sticker && isStickerId(sticker)) return WHITEBOARD_STICKERS[sticker];
  return undefined;
}

const escapeXml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function labelOf(el: Pick<WbElementData, "label" | "text" | "title">): string {
  return el.title ?? el.label ?? el.text ?? "";
}

export function bodyOf(el: Pick<WbElementData, "body" | "subtitle" | "label" | "title" | "text">): string {
  if (el.body) return el.body;
  if (el.subtitle) return el.subtitle;
  if (el.title && el.label && el.label !== el.title) return el.label;
  if (el.title && el.text && el.text !== el.title) return el.text;
  return "";
}

export function makeElementId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 6) : Math.random().toString(36).slice(2, 8);
  return `${prefix}-${rand}`;
}

export function anchorPoint(
  ep: WbEndpoint | undefined,
  byId: ReadonlyMap<string, Pick<WbElementData, "x" | "y" | "w" | "h">>,
  fallbackSide: "n" | "e" | "s" | "w",
): WbPoint | undefined {
  if (!ep) return undefined;
  if ("x" in ep) return { x: ep.x, y: ep.y };
  const target = byId.get(ep.id);
  if (!target) return undefined;
  const x = target.x ?? 0;
  const y = target.y ?? 0;
  const w = target.w ?? 160;
  const h = target.h ?? 72;
  const side = ep.side ?? fallbackSide;
  switch (side) {
    case "top":
    case "n":
      return { x: x + w / 2, y };
    case "bottom":
    case "s":
      return { x: x + w / 2, y: y + h };
    case "left":
    case "w":
      return { x, y: y + h / 2 };
    case "right":
    case "e":
      return { x: x + w, y: y + h / 2 };
  }
}

function normalizeSide(side: string | undefined, fallback: "n" | "e" | "s" | "w"): "n" | "e" | "s" | "w" {
  switch (side) {
    case "top":
    case "n":
      return "n";
    case "bottom":
    case "s":
      return "s";
    case "left":
    case "w":
      return "w";
    case "right":
    case "e":
      return "e";
    default:
      return fallback;
  }
}

export function autoAnchorSides(
  fromEl: Pick<WbElementData, "x" | "y" | "w" | "h">,
  toEl: Pick<WbElementData, "x" | "y" | "w" | "h">,
): { readonly fromSide: "n" | "e" | "s" | "w"; readonly toSide: "n" | "e" | "s" | "w" } {
  const fx = (fromEl.x ?? 0) + (fromEl.w ?? 160) / 2;
  const fy = (fromEl.y ?? 0) + (fromEl.h ?? 80) / 2;
  const tx = (toEl.x ?? 0) + (toEl.w ?? 160) / 2;
  const ty = (toEl.y ?? 0) + (toEl.h ?? 80) / 2;
  const dx = tx - fx;
  const dy = ty - fy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: "e", toSide: "w" } : { fromSide: "w", toSide: "e" };
  }
  return dy >= 0 ? { fromSide: "s", toSide: "n" } : { fromSide: "n", toSide: "s" };
}

export function catmullRomPath(points: readonly WbPoint[], tension = 0.5): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${Math.round(points[0].x)} ${Math.round(points[0].y)}`;
  if (points.length === 2) {
    return `M ${Math.round(points[0].x)} ${Math.round(points[0].y)} L ${Math.round(points[1].x)} ${Math.round(points[1].y)}`;
  }
  const segs: string[] = [`M ${Math.round(points[0].x)} ${Math.round(points[0].y)}`];
  const factor = tension / 3;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) * factor;
    const c1y = p1.y + (p2.y - p0.y) * factor;
    const c2x = p2.x - (p3.x - p1.x) * factor;
    const c2y = p2.y - (p3.y - p1.y) * factor;
    segs.push(`C ${Math.round(c1x)} ${Math.round(c1y)}, ${Math.round(c2x)} ${Math.round(c2y)}, ${Math.round(p2.x)} ${Math.round(p2.y)}`);
  }
  return segs.join(" ");
}

/** By arc length, not by vertex: 0 is the start, 1 the end; outside that is clamped. */
export function samplePolyline(points: readonly WbPoint[], t: number): WbPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  const clamped = Math.max(0, Math.min(1, t));
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    lengths.push(len);
    total += len;
  }
  if (total === 0) return points[0];
  const target = clamped * total;
  let acc = 0;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i];
    if (acc + len >= target || i === lengths.length - 1) {
      const a = points[i];
      const b = points[i + 1];
      const localT = len === 0 ? 0 : (target - acc) / len;
      return { x: a.x + (b.x - a.x) * localT, y: a.y + (b.y - a.y) * localT };
    }
    acc += len;
  }
  return points.at(-1)!;
}

function sideVector(side: "n" | "e" | "s" | "w", dist: number): WbPoint {
  switch (side) {
    case "n":
      return { x: 0, y: -dist };
    case "s":
      return { x: 0, y: dist };
    case "w":
      return { x: -dist, y: 0 };
    case "e":
      return { x: dist, y: 0 };
  }
}

export interface ArrowGeometry {
  readonly d: string;
  readonly start: WbPoint;
  readonly end: WbPoint;
  readonly labelX: number;
  readonly labelY: number;
}

export function buildArrowGeometry(
  arr: Pick<WbElementData, "from" | "to" | "bends" | "curve">,
  byId: ReadonlyMap<string, Pick<WbElementData, "x" | "y" | "w" | "h">>,
): ArrowGeometry | undefined {
  const fromSide = arr.from && "side" in arr.from ? normalizeSide(arr.from.side, "e") : "e";
  const toSide = arr.to && "side" in arr.to ? normalizeSide(arr.to.side, "w") : "w";
  const start = anchorPoint(arr.from, byId, fromSide);
  const end = anchorPoint(arr.to, byId, toSide);
  if (!start || !end) return undefined;
  const bends = arr.bends ?? [];
  const curve = arr.curve ?? "smooth";

  if (curve === "straight" || (curve === "orthogonal" && bends.length > 0)) {
    const pts = [start, ...bends, end];
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${Math.round(p.x)} ${Math.round(p.y)}`).join(" ");
    const mid = samplePolyline(pts, 0.5);
    return { d, start, end, labelX: Math.round(mid.x), labelY: Math.round(mid.y) - 8 };
  }

  if (curve === "orthogonal") {
    const midX = Math.round((start.x + end.x) / 2);
    const pts =
      fromSide === "n" || fromSide === "s"
        ? [start, { x: start.x, y: Math.round((start.y + end.y) / 2) }, { x: end.x, y: Math.round((start.y + end.y) / 2) }, end]
        : [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${Math.round(p.x)} ${Math.round(p.y)}`).join(" ");
    const mid = samplePolyline(pts, 0.5);
    return { d, start, end, labelX: Math.round(mid.x), labelY: Math.round(mid.y) - 8 };
  }

  if (bends.length > 0) {
    const pts = [start, ...bends, end];
    const mid = samplePolyline(pts, 0.5);
    return { d: catmullRomPath(pts), start, end, labelX: Math.round(mid.x), labelY: Math.round(mid.y) - 8 };
  }

  const span = Math.max(32, Math.min(140, Math.hypot(end.x - start.x, end.y - start.y) * 0.42));
  const v1 = arr.from && "id" in arr.from ? sideVector(fromSide, span) : { x: (end.x - start.x) * 0.35, y: 0 };
  const v2 = arr.to && "id" in arr.to ? sideVector(toSide, span) : { x: -(end.x - start.x) * 0.35, y: 0 };
  const c1 = { x: start.x + v1.x, y: start.y + v1.y };
  const c2 = { x: end.x + v2.x, y: end.y + v2.y };
  const d = `M ${Math.round(start.x)} ${Math.round(start.y)} C ${Math.round(c1.x)} ${Math.round(c1.y)}, ${Math.round(c2.x)} ${Math.round(c2.y)}, ${Math.round(end.x)} ${Math.round(end.y)}`;
  // Cubic Bezier at t = 0.5: the middle of the curve, not of the chord.
  const mx = (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8;
  const my = (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8;
  return { d, start, end, labelX: Math.round(mx), labelY: Math.round(my) - 8 };
}

function perpendicularDistance(pt: WbPoint, a: WbPoint, b: WbPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq));
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}

/** Ramer-Douglas-Peucker. */
export function simplifyStroke(points: readonly WbPoint[], tolerance = 2.5): WbPoint[] {
  if (points.length <= 2) return points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = -1;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > tolerance) {
    const left = simplifyStroke(points.slice(0, index + 1), tolerance);
    const right = simplifyStroke(points.slice(index), tolerance);
    return [...left.slice(0, -1), ...right];
  }
  return [
    { x: Math.round(first.x), y: Math.round(first.y) },
    { x: Math.round(last.x), y: Math.round(last.y) },
  ];
}

export interface UndoStep {
  readonly undo: readonly ArtifactEntryWriteInput[];
  readonly redo: readonly ArtifactEntryWriteInput[];
}

export interface UndoStack {
  push(step: UndoStep): void;
  popUndo(): UndoStep | undefined;
  popRedo(): UndoStep | undefined;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
}

export function createUndoStack(limit = 50): UndoStack {
  const past: UndoStep[] = [];
  const future: UndoStep[] = [];
  return {
    push(step) {
      if (step.undo.length === 0 && step.redo.length === 0) return;
      past.push(step);
      if (past.length > limit) past.shift();
      future.length = 0;
    },
    popUndo() {
      const step = past.pop();
      if (step) future.push(step);
      return step;
    },
    popRedo() {
      const step = future.pop();
      if (step) past.push(step);
      return step;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear() {
      past.length = 0;
      future.length = 0;
    },
  };
}

interface PaletteTone {
  readonly bg: string;
  readonly border: string;
  readonly ink: string;
  readonly sub: string;
}

const LIGHT_TONES: Record<WbFill, PaletteTone> = {
  default: { bg: "#fcfcfb", border: "#d4d0ca", ink: "#1c1917", sub: "#5e5852" },
  sun: { bg: "#ffe380", border: "#ecc346", ink: "#2a210f", sub: "#59481f" },
  peach: { bg: "#ffc183", border: "#e79e54", ink: "#2b190b", sub: "#603a1c" },
  leaf: { bg: "#e4efd8", border: "#74a046", ink: "#1f2e14", sub: "#476130" },
  water: { bg: "#e1eef9", border: "#3d7cb5", ink: "#13293d", sub: "#365673" },
  lavender: { bg: "#ebe5f8", border: "#8c74c9", ink: "#241b3d", sub: "#4f4178" },
  berry: { bg: "#f8e2de", border: "#c25140", ink: "#3d1611", sub: "#75352d" },
  side: { bg: "#f3f1ed", border: "#d4d0ca", ink: "#1c1917", sub: "#5e5852" },
};

const DARK_TONES: Record<WbFill, PaletteTone> = {
  default: { bg: "#21201d", border: "#44403a", ink: "#ecebe8", sub: "#a9a49e" },
  sun: { bg: "#403517", border: "#8f7328", ink: "#fae9b2", sub: "#dcc583" },
  peach: { bg: "#462c18", border: "#9d5b2d", ink: "#fce1c6", sub: "#dfb691" },
  leaf: { bg: "#26341c", border: "#5b8536", ink: "#dcebc8", sub: "#afc894" },
  water: { bg: "#1c2d3d", border: "#4a82b5", ink: "#d5e7f8", sub: "#9ec0e0" },
  lavender: { bg: "#2b243d", border: "#7a65b5", ink: "#e6dff9", sub: "#b8addb" },
  berry: { bg: "#3f221e", border: "#b55245", ink: "#f9dcd8", sub: "#d7a49d" },
  side: { bg: "#1b1a18", border: "#36332f", ink: "#ecebe8", sub: "#a9a49e" },
};

function toneForFill(fill: string | undefined, shape: string | undefined, theme: ShellTheme = "light"): PaletteTone {
  const bank = theme === "dark" ? DARK_TONES : LIGHT_TONES;
  if (!fill && shape === "sticky") return bank.sun;
  if (!fill && shape === "card") return bank.sun;
  switch (fill) {
    case "sun":
    case "wheat":
    case "amber":
    case "yellow":
      return bank.sun;
    case "peach":
    case "orange":
      return bank.peach;
    case "leaf":
    case "green":
    case "ok":
      return bank.leaf;
    case "water":
    case "blue":
      return bank.water;
    case "lavender":
    case "purple":
      return bank.lavender;
    case "berry":
    case "red":
    case "bad":
      return bank.berry;
    case "side":
    case "muted":
    case "neutral":
      return bank.side;
    default:
      return bank.default;
  }
}

const PRESENCE_HEX: Record<string, string> = {
  coral: "#df765b",
  teal: "#0f8278",
  blue: "#2563eb",
  leaf: "#4d7a2a",
  wheat: "#c77c1e",
  lavender: "#7c5cdb",
};

function approxGlyphSpan(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0xff) {
      w += fontSize * 1.0;
    } else if (/[\s.,:;!|/\\iljt'`"()[\]]/u.test(ch)) {
      w += fontSize * 0.34;
    } else {
      w += fontSize * 0.56;
    }
  }
  return w;
}

function wrapLines(text: string, maxChars: number): string[] {
  if (!text) return [];
  const result: string[] = [];
  for (const para of text.split(/\r?\n/u)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    let cur = "";
    for (const ch of trimmed) {
      cur += ch;
      if (cur.length >= maxChars && /[\s，。、,.!?;；)/]/u.test(ch)) {
        result.push(cur.trim());
        cur = "";
      } else if (cur.length >= maxChars + 4) {
        result.push(cur.trim());
        cur = "";
      }
    }
    if (cur.trim()) result.push(cur.trim());
  }
  return result.slice(0, 4);
}

function stripOuterSvg(raw: string): { readonly viewBox: string; readonly inner: string } {
  const vbMatch = /viewBox="([^"]+)"/u.exec(raw);
  const viewBox = vbMatch?.[1] ?? "0 0 64 64";
  const openEnd = raw.indexOf(">");
  const closeStart = raw.lastIndexOf("</svg>");
  if (openEnd >= 0 && closeStart > openEnd) {
    return { viewBox, inner: raw.slice(openEnd + 1, closeStart) };
  }
  return { viewBox, inner: raw };
}

/** Self-contained: styles are inlined so it renders outside the WebView. */
export function buildWhiteboardSvg(
  elements: readonly Pick<
    WbElement,
    | "id"
    | "type"
    | "shape"
    | "variant"
    | "x"
    | "y"
    | "w"
    | "h"
    | "label"
    | "text"
    | "title"
    | "body"
    | "subtitle"
    | "highlight"
    | "icon"
    | "badge"
    | "align"
    | "fill"
    | "stroke"
    | "strokeWidth"
    | "sticker"
    | "stickerSvg"
    | "curve"
    | "style"
    | "head"
    | "from"
    | "to"
    | "bends"
    | "points"
    | "milestones"
    | "headers"
    | "rows"
    | "svg"
  >[],
  presences: readonly WbPresence[] = [],
  theme: ShellTheme = "light",
): string {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const nonArrows = elements.filter((e) => e.type !== "arrow");
  const arrows = elements.filter((e) => e.type === "arrow");

  const xs: number[] = [];
  const ys: number[] = [];
  const maxXs: number[] = [];
  const maxYs: number[] = [];

  for (const el of nonArrows) {
    if (el.points && el.points.length > 0) {
      for (const p of el.points) {
        xs.push(p.x - 24);
        ys.push(p.y - 24);
        maxXs.push(p.x + 24);
        maxYs.push(p.y + 44);
      }
    } else {
      const x = el.x ?? 0;
      const y = el.y ?? 0;
      const w = el.w ?? 180;
      const h = el.h ?? 88;
      xs.push(x);
      ys.push(el.type === "shape" && (el.sticker || el.stickerSvg) ? y - 34 : y);
      maxXs.push(x + w);
      maxYs.push(y + h);
    }
  }
  for (const p of presences) {
    xs.push(p.x - 8);
    ys.push(p.y - 8);
    maxXs.push(p.x + 110);
    maxYs.push(p.y + 36);
  }

  const minX = xs.length > 0 ? Math.min(...xs) - 48 : 0;
  const minY = ys.length > 0 ? Math.min(...ys) - 48 : 0;
  const maxX = maxXs.length > 0 ? Math.max(...maxXs) + 48 : 960;
  const maxY = maxYs.length > 0 ? Math.max(...maxYs) + 48 : 600;
  const width = Math.max(360, Math.round(maxX - minX));
  const height = Math.max(260, Math.round(maxY - minY));

  const pageBg = theme === "dark" ? "#151413" : "#fcfcfb";
  const gridStroke = theme === "dark" ? "rgba(236,235,232,0.05)" : "rgba(28,25,23,0.05)";
  const ink = theme === "dark" ? "#ecebe8" : "#1c1917";
  const muted = theme === "dark" ? "#a9a49e" : "#5e5852";
  const cardBgPill = theme === "dark" ? "#21201d" : "#fcfcfb";
  const hlBg = theme === "dark" ? "rgba(106,166,220,0.22)" : "rgba(77,114,255,0.12)";
  const hlInk = theme === "dark" ? "#8fc1ef" : "#3655d9";
  const arrowStrokeDefault = theme === "dark" ? "#c98566" : "#b86b4d";

  const defs = `<defs>
    <pattern id="wb-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 L 0 0 0 24" fill="none" stroke="${gridStroke}" stroke-width="1"/></pattern>
    <linearGradient id="wb-ribbon" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#dd6f57"/><stop offset="55%" stop-color="#ec9658"/><stop offset="100%" stop-color="#e5864c"/></linearGradient>
    <marker id="wb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="${arrowStrokeDefault}"/></marker>
    <filter id="wb-shadow" x="-10%" y="-10%" width="125%" height="130%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#1c1917" flood-opacity="${theme === "dark" ? "0.38" : "0.09"}"/></filter>
  </defs>`;

  const backLayers: string[] = [];
  const arrowLayers: string[] = [];
  const midLayers: string[] = [];
  const frontLayers: string[] = [];

  for (const el of nonArrows) {
    const x = el.x ?? 0;
    const y = el.y ?? 0;
    const w = el.w ?? 188;
    const h = el.h ?? 92;
    const title = labelOf(el);
    const body = bodyOf(el);

    if (el.type === "container" || el.type === "claim") {
      const stroke = el.type === "claim" ? "#e5a93c" : theme === "dark" ? "#4a453f" : "#aca59e";
      const fill = el.type === "claim" ? "rgba(229,169,60,0.09)" : theme === "dark" ? "rgba(255,255,255,0.03)" : "rgba(252,252,251,0.7)";
      backLayers.push(
        `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="1.8" stroke-dasharray="6 4"/>` +
          `<text x="${x + 14}" y="${y + 24}" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="${muted}">${escapeXml(title)}</text></g>`,
      );
      continue;
    }

    if (el.type === "timeline") {
      const pts =
        el.points && el.points.length >= 2
          ? el.points
          : [
              { x, y: y + h / 2 },
              { x: x + w, y: y + h / 2 },
            ];
      const pathD = catmullRomPath(pts);
      const ms = (el.milestones ?? []).map((m, idx) => {
        const pt = m.x !== undefined && m.y !== undefined ? { x: m.x, y: m.y } : samplePolyline(pts, m.t ?? (idx + 1) / ((el.milestones?.length ?? 1) + 1));
        const px = Math.round(pt.x);
        const py = Math.round(pt.y);
        const caption = m.caption
          ? `<text x="${px}" y="${py + 28}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11.5" font-weight="600" fill="${ink}">${escapeXml(m.caption)}</text>`
          : "";
        if (m.kind === "minor") {
          return (
            `<g><circle cx="${px}" cy="${py}" r="10.5" fill="${cardBgPill}" stroke="#e58d5e" stroke-width="1.8"/>` +
            `<text x="${px}" y="${py + 3.5}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5" font-weight="600" fill="${ink}">${escapeXml(m.label)}</text>${caption}</g>`
          );
        }
        const pillW = Math.max(54, Math.round(approxGlyphSpan(m.label, 11.5)) + 22);
        return (
          `<g><rect x="${px - Math.round(pillW / 2)}" y="${py - 13}" width="${pillW}" height="26" rx="13" fill="#df765b" filter="url(#wb-shadow)"/>` +
          `<text x="${px}" y="${py + 4}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11.5" font-weight="700" fill="#ffffff">${escapeXml(m.label)}</text>${caption}</g>`
        );
      });
      midLayers.push(
        `<g><path d="${pathD}" fill="none" stroke="url(#wb-ribbon)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>${ms.join("")}</g>`,
      );
      continue;
    }

    if (el.type === "path" && el.points && el.points.length >= 2) {
      const pathD = catmullRomPath(el.points, 0.45);
      const sw = el.strokeWidth ?? 3;
      const sc = el.stroke ?? "#c25140";
      frontLayers.push(`<path d="${pathD}" fill="none" stroke="${escapeXml(sc)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`);
      continue;
    }

    if (el.type === "text") {
      const anchor = el.align === "center" ? "middle" : el.align === "right" ? "end" : "start";
      const tx = el.align === "center" ? x + w / 2 : el.align === "right" ? x + w : x;
      if (el.variant === "title") {
        frontLayers.push(
          `<text x="${tx}" y="${y + 34}" text-anchor="${anchor}" font-family="Georgia,'Times New Roman','Songti SC',serif" font-size="32" font-weight="600" letter-spacing="-0.6" fill="${ink}">${escapeXml(title)}</text>`,
        );
      } else if (el.variant === "subtitle") {
        const hl = el.highlight?.trim();
        const idx = hl ? title.indexOf(hl) : -1;
        if (hl && idx >= 0) {
          const before = title.slice(0, idx);
          const after = title.slice(idx + hl.length);
          const estBeforeW = approxGlyphSpan(before, 13.5);
          const estHlW = Math.max(24, approxGlyphSpan(hl, 13.5) + 10);
          frontLayers.push(
            `<g><rect x="${Math.round(tx + estBeforeW - 5)}" y="${y + 4}" width="${Math.round(estHlW)}" height="21" rx="6" fill="${hlBg}"/>` +
              `<text x="${tx}" y="${y + 20}" font-family="system-ui,sans-serif" font-size="13.5" fill="${muted}">${escapeXml(before)}<tspan fill="${hlInk}" font-weight="600">${escapeXml(hl)}</tspan>${escapeXml(after)}</text></g>`,
          );
        } else {
          frontLayers.push(
            `<text x="${tx}" y="${y + 20}" text-anchor="${anchor}" font-family="system-ui,sans-serif" font-size="13.5" fill="${muted}">${escapeXml(title)}</text>`,
          );
        }
      } else if (el.variant === "callout") {
        const prefix = el.icon ? `${el.icon} ` : "";
        const lines = wrapLines(`${prefix}${title}`, 24);
        const tspans = lines
          .map(
            (line, i) =>
              `<text x="${tx}" y="${y + 18 + i * 17}" font-family="system-ui,sans-serif" font-size="12.5" font-weight="500" fill="${ink}">${escapeXml(line)}</text>`,
          )
          .join("");
        frontLayers.push(`<g>${tspans}</g>`);
      } else {
        frontLayers.push(
          `<text x="${tx}" y="${y + 22}" text-anchor="${anchor}" font-family="system-ui,sans-serif" font-size="14" font-weight="500" fill="${ink}">${escapeXml(title)}</text>`,
        );
      }
      continue;
    }

    if (el.type === "sticker" || el.type === "svg") {
      const rawSvg = el.type === "svg" ? el.svg : resolveStickerSvg(el.sticker, el.stickerSvg);
      if (rawSvg) {
        const { viewBox, inner } = stripOuterSvg(rawSvg);
        frontLayers.push(`<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${escapeXml(viewBox)}">${inner}</svg>`);
      } else if (el.sticker) {
        frontLayers.push(`<text x="${x + w / 2}" y="${y + h / 2 + 12}" text-anchor="middle" font-size="36">${escapeXml(el.sticker)}</text>`);
      }
      continue;
    }

    if (el.type === "table") {
      const headers = el.headers ?? [];
      const rows = el.rows ?? [];
      const rowCols = rows[0]?.length ?? 1;
      const cols = Math.max(1, headers.length > 0 ? headers.length : rowCols);
      const colW = w / cols;
      const rowH = 26;
      const headCells = headers
        .map(
          (c, idx) =>
            `<text x="${x + idx * colW + 8}" y="${y + 18}" font-family="system-ui,sans-serif" font-size="11.5" font-weight="700" fill="${muted}">${escapeXml(c)}</text>`,
        )
        .join("");
      const bodyCells = rows
        .map((r, ri) =>
          r
            .map(
              (c, ci) =>
                `<text x="${x + ci * colW + 8}" y="${y + 42 + ri * rowH}" font-family="system-ui,sans-serif" font-size="11.5" fill="${ink}">${escapeXml(c)}</text>`,
            )
            .join(""),
        )
        .join("");
      frontLayers.push(
        `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${cardBgPill}" stroke="${theme === "dark" ? "#36332f" : "#d4d0ca"}" stroke-width="1.2"/>${headCells}${bodyCells}</g>`,
      );
      continue;
    }

    const tone = toneForFill(el.fill, el.shape, theme);
    const rx = el.shape === "pill" || el.shape === "ellipse" ? Math.round(h / 2) : 14;
    const stickerRaw = resolveStickerSvg(el.sticker, el.stickerSvg);
    const hasTopSticker = Boolean(stickerRaw || el.sticker);

    const shapeBox =
      el.shape === "diamond"
        ? `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" fill="${tone.bg}" stroke="${tone.border}" stroke-width="1.5" filter="url(#wb-shadow)"/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${tone.bg}" stroke="${tone.border}" stroke-width="1.25" filter="url(#wb-shadow)"/>`;

    let stickerMarkup = "";
    if (stickerRaw) {
      const { viewBox, inner } = stripOuterSvg(stickerRaw);
      const sw = 62;
      const sh = 50;
      stickerMarkup = `<svg x="${Math.round(x + w / 2 - sw / 2)}" y="${Math.round(y - 24)}" width="${sw}" height="${sh}" viewBox="${escapeXml(viewBox)}">${inner}</svg>`;
    } else if (el.sticker) {
      stickerMarkup = `<text x="${Math.round(x + w / 2)}" y="${Math.round(y + 12)}" text-anchor="middle" font-size="28">${escapeXml(el.sticker)}</text>`;
    }

    const titleLines = wrapLines(title, 20);
    const bodyLines = wrapLines(body, 22);
    const contentTop = y + (hasTopSticker ? 42 : bodyLines.length > 0 ? 30 : Math.round(h / 2) + 4 - (titleLines.length - 1) * 8);
    const titleSvg = titleLines
      .map(
        (line, i) =>
          `<text x="${x + w / 2}" y="${contentTop + i * 16}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="${tone.ink}">${escapeXml(line)}</text>`,
      )
      .join("");
    const bodyStart = contentTop + titleLines.length * 16 + 2;
    const bodySvg = bodyLines
      .map(
        (line, i) =>
          `<text x="${x + w / 2}" y="${bodyStart + i * 15}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${tone.sub}">${escapeXml(line)}</text>`,
      )
      .join("");

    frontLayers.push(`<g>${shapeBox}${titleSvg}${bodySvg}${stickerMarkup}</g>`);
  }

  for (const arr of arrows) {
    const geom = buildArrowGeometry(arr, byId);
    if (!geom) continue;
    const stroke = arr.stroke ?? arrowStrokeDefault;
    const dash = arr.style === "dashed" ? ' stroke-dasharray="5 4"' : "";
    const marker = arr.head === "none" ? "" : ' marker-end="url(#wb-arrow)"';
    const label = arr.label
      ? `<text x="${geom.labelX}" y="${geom.labelY}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11.5" font-weight="500" fill="${muted}">${escapeXml(arr.label)}</text>`
      : "";
    arrowLayers.push(`<g><path d="${geom.d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="1.6"${dash}${marker}/>${label}</g>`);
  }

  const presenceLayers = presences.map((p) => {
    const color = PRESENCE_HEX[p.color ?? "coral"] ?? "#df765b";
    const pillW = Math.max(46, Math.round(approxGlyphSpan(p.name, 11.5)) + 20);
    return (
      `<g transform="translate(${Math.round(p.x)},${Math.round(p.y)})">` +
      `<path d="M 0 0 L 12 5 L 7 12 z" fill="${color}" stroke="#ffffff" stroke-width="1"/>` +
      `<rect x="10" y="10" width="${pillW}" height="22" rx="7" fill="${color}" filter="url(#wb-shadow)"/>` +
      `<text x="${10 + Math.round(pillW / 2)}" y="24.5" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11.5" font-weight="600" fill="#ffffff">${escapeXml(p.name)}</text></g>`
    );
  });

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${Math.round(minX)} ${Math.round(minY)} ${width} ${height}" width="${width}" height="${height}">` +
    `${defs}<rect x="${Math.round(minX)}" y="${Math.round(minY)}" width="${width}" height="${height}" fill="${pageBg}"/>` +
    `<rect x="${Math.round(minX)}" y="${Math.round(minY)}" width="${width}" height="${height}" fill="url(#wb-grid)"/>` +
    `${backLayers.join("")}${arrowLayers.join("")}${midLayers.join("")}${frontLayers.join("")}${presenceLayers.join("")}</svg>`
  );
}

export interface TimelineTemplateCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly highlight: string;
  readonly day1: string;
  readonly day2: string;
  readonly day3: string;
  readonly day7: string;
  readonly day8: string;
  readonly roadCaption: string;
  readonly step1Title: string;
  readonly step1Body: string;
  readonly step2Title: string;
  readonly step2Body: string;
  readonly step3Title: string;
  readonly step3Body: string;
  readonly step4Title: string;
  readonly step4Body: string;
  readonly step5Title: string;
  readonly step5Body: string;
  readonly step6Title: string;
  readonly step6Body: string;
  readonly callout: string;
  readonly userLabel: string;
  readonly orchLabel: string;
  readonly helperLabel: string;
}

export function buildTimelineTemplate(copy: TimelineTemplateCopy): ArtifactEntryWriteInput[] {
  const nodes: Record<string, unknown>[] = [
    { id: "t-title", type: "text", variant: "title", x: 72, y: 36, w: 680, h: 48, label: copy.title },
    { id: "t-sub", type: "text", variant: "subtitle", x: 72, y: 84, w: 680, h: 28, label: copy.subtitle, highlight: copy.highlight },
    {
      id: "tl-main",
      type: "timeline",
      x: 72,
      y: 268,
      w: 840,
      h: 96,
      fill: "peach",
      points: [
        { x: 76, y: 356 },
        { x: 240, y: 350 },
        { x: 430, y: 312 },
        { x: 640, y: 306 },
        { x: 890, y: 264 },
      ],
      milestones: [
        { t: 0.04, label: copy.day1, kind: "major" },
        { t: 0.16, label: copy.day2, kind: "major" },
        { t: 0.27, label: copy.day3, kind: "major" },
        { t: 0.38, label: "4", kind: "minor" },
        { t: 0.49, label: "5", kind: "minor", caption: copy.roadCaption },
        { t: 0.6, label: "6", kind: "minor" },
        { t: 0.72, label: copy.day7, kind: "major" },
        { t: 0.85, label: copy.day8, kind: "major" },
        { t: 0.96, label: "9", kind: "minor" },
      ],
    },
    {
      id: "c-1",
      type: "shape",
      shape: "card",
      x: 64,
      y: 174,
      w: 160,
      h: 108,
      title: copy.step1Title,
      body: copy.step1Body,
      fill: "sun",
      sticker: "berry-lock",
    },
    {
      id: "c-2",
      type: "shape",
      shape: "card",
      x: 112,
      y: 422,
      w: 168,
      h: 120,
      title: copy.step2Title,
      body: copy.step2Body,
      fill: "sun",
      sticker: "chart-board",
    },
    {
      id: "c-3",
      type: "shape",
      shape: "card",
      x: 246,
      y: 146,
      w: 168,
      h: 110,
      title: copy.step3Title,
      body: copy.step3Body,
      fill: "sun",
      sticker: "price-tag",
    },
    { id: "c-4", type: "shape", shape: "card", x: 298, y: 372, w: 170, h: 108, title: copy.step4Title, body: copy.step4Body, fill: "sun", sticker: "crate" },
    {
      id: "c-5",
      type: "shape",
      shape: "card",
      x: 640,
      y: 114,
      w: 176,
      h: 114,
      title: copy.step5Title,
      body: copy.step5Body,
      fill: "peach",
      sticker: "storefront",
    },
    { id: "c-6", type: "shape", shape: "card", x: 752, y: 356, w: 176, h: 118, title: copy.step6Title, body: copy.step6Body, fill: "peach", sticker: "bowl" },
    { id: "s-truck", type: "sticker", sticker: "truck", x: 462, y: 244, w: 112, h: 68, label: copy.roadCaption },
    { id: "s-mascot", type: "sticker", sticker: "mascot", x: 752, y: 26, w: 72, h: 72, label: copy.helperLabel },
    { id: "t-callout", type: "text", variant: "callout", icon: "⚠", x: 492, y: 404, w: 204, h: 48, label: copy.callout },
    { id: "a-1", type: "arrow", curve: "straight", head: "none", stroke: "#c96e52", from: { id: "c-1", side: "s" }, to: { x: 112, y: 354 } },
    { id: "a-2", type: "arrow", curve: "straight", head: "none", stroke: "#c96e52", from: { id: "c-2", side: "n" }, to: { x: 204, y: 352 } },
    { id: "a-3", type: "arrow", curve: "straight", head: "none", stroke: "#c96e52", from: { id: "c-3", side: "s" }, to: { x: 298, y: 338 } },
    { id: "a-4", type: "arrow", curve: "straight", head: "none", stroke: "#c96e52", from: { id: "c-4", side: "n" }, to: { x: 392, y: 320 } },
    { id: "a-5", type: "arrow", curve: "straight", head: "none", stroke: "#c96e52", from: { id: "c-5", side: "s" }, to: { x: 676, y: 300 } },
    { id: "a-6", type: "arrow", curve: "straight", head: "none", stroke: "#c96e52", from: { id: "c-6", side: "n" }, to: { x: 780, y: 282 } },
    { id: "a-callout", type: "arrow", curve: "smooth", head: "arrow", stroke: "#c96e52", from: { id: "t-callout", side: "e" }, to: { id: "c-6", side: "w" } },
  ];

  const presences: WbPresence[] = [
    { id: "orch", name: copy.orchLabel, color: "coral", x: 540, y: 88 },
    { id: "helper", name: copy.helperLabel, color: "teal", x: 822, y: 74 },
    { id: "user", name: copy.userLabel, color: "blue", x: 634, y: 454 },
  ];

  return [
    ...nodes.map((n) => ({
      op: "set" as const,
      path: `elements/${String(n.id)}`,
      kind: "json" as const,
      value: JSON.stringify(n),
    })),
    ...presences.map((p) => ({
      op: "set" as const,
      path: `presence/${p.id}`,
      kind: "json" as const,
      value: JSON.stringify(p),
    })),
  ];
}

export interface ArchitectureTemplateCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly highlight: string;
  readonly zoneCore: string;
  readonly zoneStore: string;
  readonly clientTitle: string;
  readonly clientBody: string;
  readonly apiTitle: string;
  readonly apiBody: string;
  readonly coreTitle: string;
  readonly coreBody: string;
  readonly sqliteTitle: string;
  readonly sqliteBody: string;
  readonly callout: string;
}

export function buildArchitectureTemplate(copy: ArchitectureTemplateCopy): ArtifactEntryWriteInput[] {
  const nodes: Record<string, unknown>[] = [
    { id: "t-arch", type: "text", variant: "title", x: 64, y: 36, w: 680, h: 48, label: copy.title },
    { id: "t-sub", type: "text", variant: "subtitle", x: 64, y: 86, w: 680, h: 28, label: copy.subtitle, highlight: copy.highlight },
    { id: "z-core", type: "container", x: 300, y: 136, w: 500, h: 220, title: copy.zoneCore, fill: "side" },
    { id: "z-store", type: "container", x: 300, y: 384, w: 500, h: 170, title: copy.zoneStore, fill: "side" },
    {
      id: "n-client",
      type: "shape",
      shape: "card",
      x: 64,
      y: 186,
      w: 188,
      h: 120,
      title: copy.clientTitle,
      body: copy.clientBody,
      fill: "water",
      sticker: "rocket",
    },
    { id: "n-api", type: "shape", shape: "card", x: 332, y: 186, w: 196, h: 120, title: copy.apiTitle, body: copy.apiBody, fill: "leaf", sticker: "sparkles" },
    {
      id: "n-core",
      type: "shape",
      shape: "card",
      x: 576,
      y: 186,
      w: 196,
      h: 120,
      title: copy.coreTitle,
      body: copy.coreBody,
      fill: "sun",
      sticker: "chart-board",
    },
    {
      id: "n-db",
      type: "shape",
      shape: "card",
      x: 444,
      y: 420,
      w: 220,
      h: 112,
      title: copy.sqliteTitle,
      body: copy.sqliteBody,
      fill: "peach",
      sticker: "crate",
    },
    { id: "t-rule", type: "text", variant: "callout", icon: "⚡", x: 64, y: 438, w: 210, h: 68, label: copy.callout },
    { id: "a-1", type: "arrow", curve: "smooth", head: "arrow", from: { id: "n-client", side: "e" }, to: { id: "n-api", side: "w" }, label: "SSE / RPC" },
    { id: "a-2", type: "arrow", curve: "smooth", head: "arrow", from: { id: "n-api", side: "e" }, to: { id: "n-core", side: "w" }, label: "Facts" },
    { id: "a-3", type: "arrow", curve: "smooth", head: "arrow", from: { id: "n-core", side: "s" }, to: { id: "n-db", side: "e" }, label: "Ledger" },
    { id: "a-4", type: "arrow", curve: "smooth", head: "arrow", style: "dashed", from: { id: "t-rule", side: "e" }, to: { id: "n-db", side: "w" } },
  ];
  return nodes.map((n) => ({
    op: "set" as const,
    path: `elements/${String(n.id)}`,
    kind: "json" as const,
    value: JSON.stringify(n),
  }));
}

export interface WhiteboardRuntimeLabels {
  readonly emptyHint: string;
  readonly doubleClickEdit: string;
  readonly chatWithOrchestrator: string;
  readonly templateTimeline: string;
  readonly templateArchitecture: string;
  readonly select: string;
  readonly pan: string;
  readonly text: string;
  readonly container: string;
  readonly sticky: string;
  readonly pen: string;
  readonly rect: string;
  readonly sticker: string;
  readonly arrow: string;
  readonly timeline: string;
}

const DOCK_ICONS: Record<WbTool, string> = {
  select: '<svg viewBox="0 0 20 20"><path d="M5 3l10 7-4.5 1.2L12.5 16l-2 1-2.2-4.8L5 14.5z" fill="currentColor"/></svg>',
  pan: '<svg viewBox="0 0 20 20"><path d="M8 10V4.5a1 1 0 1 1 2 0V9m0-3.5a1 1 0 1 1 2 0V9m0-2.5a1 1 0 1 1 2 0V11m0-1.5a1 1 0 1 1 2 0v3.2a4.3 4.3 0 0 1-4.3 4.3h-1.8a4 4 0 0 1-3.2-1.6l-2.1-2.8a1 1 0 1 1 1.6-1.2L8 12.6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  text: '<svg viewBox="0 0 20 20"><path d="M4.5 5h11M10 5v10.5M7.5 15.5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  container:
    '<svg viewBox="0 0 20 20"><path d="M7.5 3.5l-1.5 13M14 3.5l-1.5 13M4 7.5h12.5M3.5 12.5H16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  sticky:
    '<svg viewBox="0 0 20 20"><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3h9A1.5 1.5 0 0 1 16 4.5v8L12.5 16h-7A1.5 1.5 0 0 1 4 14.5z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12.5 16v-3.5H16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  pen: '<svg viewBox="0 0 20 20"><path d="M4 16l1-4L13.5 3.5a1.8 1.8 0 0 1 2.5 2.5L7.5 14.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  rect: '<svg viewBox="0 0 20 20"><rect x="3.5" y="4.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  sticker:
    '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7.8" cy="8.5" r="1" fill="currentColor"/><circle cx="12.2" cy="8.5" r="1" fill="currentColor"/><path d="M7.3 12c.8 1.2 4.6 1.2 5.4 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  arrow:
    '<svg viewBox="0 0 20 20"><path d="M4 14.5c4.5 0 4-9 11.5-9m0 0l-3-2.5m3 2.5l-2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  timeline:
    '<svg viewBox="0 0 20 20"><path d="M2.5 12c4-5 11 1 15-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="5.5" cy="9.7" r="1.8" fill="currentColor"/><circle cx="14.5" cy="10.2" r="1.8" fill="currentColor"/></svg>',
};

export function buildWhiteboardHtml(initialTheme: ShellTheme, labels: WhiteboardRuntimeLabels): string {
  const stickerDataUris = Object.fromEntries(
    Object.entries(WHITEBOARD_STICKERS).map(([k, svg]) => [k, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`]),
  );

  const dockButtonsHtml = (["select", "pan", "text", "container", "sticky", "pen", "rect", "sticker", "arrow", "timeline"] as const)
    .map((id) => `<button class="wb-dock-btn" data-tool="${id}" title="${escapeXml(labels[id])}">${DOCK_ICONS[id]}</button>`)
    .join("");

  const stickerChoicesHtml = STICKER_IDS.map(
    (id) => `<button class="wb-sticker-opt" data-sticker="${id}" title="${escapeXml(id)}"><img src="${stickerDataUris[id]}" alt="${escapeXml(id)}"/></button>`,
  ).join("");

  const runtime = String.raw`(() => {
    const say = (payload) => parent.postMessage(payload, "*");
    const STICKERS = ${JSON.stringify(stickerDataUris)};
    const PRESENCE_HEX = ${JSON.stringify(PRESENCE_HEX)};
    const DBL_HINT = ${JSON.stringify(labels.doubleClickEdit)};

    const viewport = document.getElementById("wb-viewport");
    const stage = document.getElementById("wb-stage");
    const backSvg = document.getElementById("wb-svg-back");
    const nodesLayer = document.getElementById("wb-nodes");
    const presenceLayer = document.getElementById("wb-presence");
    const marqueeEl = document.getElementById("wb-marquee");
    const emptyEl = document.getElementById("wb-empty");
    const dockEl = document.getElementById("wb-dock");
    const stickerPop = document.getElementById("wb-sticker-pop");

    let elements = [];
    let presences = [];
    let selectedIds = [];
    let tool = "select";
    let pendingSticker = "sparkles";
    let panX = 36;
    let panY = 28;
    let zoom = 1;
    let arrowStart = null;
    let editingId = null;
    let dragState = null;
    let spacePan = false;
    let didInitialFit = false;

    const escapeHtml = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

    const applyTransform = () => {
      stage.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + zoom + ")";
      const step = Math.max(8, 24 * zoom);
      viewport.style.backgroundSize = step + "px " + step + "px";
      viewport.style.backgroundPosition = panX + "px " + panY + "px";
    };

    const toWorld = (clientX, clientY) => {
      const r = viewport.getBoundingClientRect();
      return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom };
    };

    const labelOf = (el) => el.title ?? el.label ?? el.text ?? "";
    const bodyOf = (el) => {
      if (el.body) return el.body;
      if (el.subtitle) return el.subtitle;
      if (el.title && el.label && el.label !== el.title) return el.label;
      if (el.title && el.text && el.text !== el.title) return el.text;
      return "";
    };

    const normSide = (side, fb) => {
      if (side === "top" || side === "n") return "n";
      if (side === "bottom" || side === "s") return "s";
      if (side === "left" || side === "w") return "w";
      if (side === "right" || side === "e") return "e";
      return fb;
    };

    const anchorPt = (ep, byId, fb) => {
      if (!ep) return null;
      if (typeof ep.x === "number" && typeof ep.y === "number") return { x: ep.x, y: ep.y };
      const t = byId.get(ep.id);
      if (!t) return null;
      const x = t.x ?? 0, y = t.y ?? 0, w = t.w ?? 180, h = t.h ?? 90;
      const s = normSide(ep.side, fb);
      if (s === "n") return { x: x + w / 2, y };
      if (s === "s") return { x: x + w / 2, y: y + h };
      if (s === "w") return { x, y: y + h / 2 };
      return { x: x + w, y: y + h / 2 };
    };

    const catmull = (pts, tension = 0.5) => {
      if (!pts || pts.length === 0) return "";
      if (pts.length === 1) return "M " + Math.round(pts[0].x) + " " + Math.round(pts[0].y);
      if (pts.length === 2) return "M " + Math.round(pts[0].x) + " " + Math.round(pts[0].y) + " L " + Math.round(pts[1].x) + " " + Math.round(pts[1].y);
      const out = ["M " + Math.round(pts[0].x) + " " + Math.round(pts[0].y)];
      const k = tension / 3;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
        const c1x = p1.x + (p2.x - p0.x) * k, c1y = p1.y + (p2.y - p0.y) * k;
        const c2x = p2.x - (p3.x - p1.x) * k, c2y = p2.y - (p3.y - p1.y) * k;
        out.push("C " + Math.round(c1x) + " " + Math.round(c1y) + ", " + Math.round(c2x) + " " + Math.round(c2y) + ", " + Math.round(p2.x) + " " + Math.round(p2.y));
      }
      return out.join(" ");
    };

    const samplePoly = (pts, t) => {
      if (!pts || pts.length === 0) return { x: 0, y: 0 };
      if (pts.length === 1) return pts[0];
      const clamped = Math.max(0, Math.min(1, t));
      const lens = [];
      let total = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
        lens.push(l);
        total += l;
      }
      if (total === 0) return pts[0];
      const target = clamped * total;
      let acc = 0;
      for (let i = 0; i < lens.length; i++) {
        const l = lens[i];
        if (acc + l >= target || i === lens.length - 1) {
          const lt = l === 0 ? 0 : (target - acc) / l;
          return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * lt, y: pts[i].y + (pts[i + 1].y - pts[i].y) * lt };
        }
        acc += l;
      }
      return pts[pts.length - 1];
    };

    const sideVec = (s, d) => s === "n" ? { x: 0, y: -d } : s === "s" ? { x: 0, y: d } : s === "w" ? { x: -d, y: 0 } : { x: d, y: 0 };

    const arrowPath = (arr, byId) => {
      const fs = arr.from && "side" in arr.from ? normSide(arr.from.side, "e") : "e";
      const ts = arr.to && "side" in arr.to ? normSide(arr.to.side, "w") : "w";
      const s = anchorPt(arr.from, byId, fs);
      const e = anchorPt(arr.to, byId, ts);
      if (!s || !e) return null;
      const bends = arr.bends || [];
      const curve = arr.curve || "smooth";
      if (curve === "straight" || (curve === "orthogonal" && bends.length > 0)) {
        const pts = [s, ...bends, e];
        const mid = samplePoly(pts, 0.5);
        return { d: pts.map((p, i) => (i === 0 ? "M " : "L ") + Math.round(p.x) + " " + Math.round(p.y)).join(" "), lx: Math.round(mid.x), ly: Math.round(mid.y) - 8 };
      }
      if (curve === "orthogonal") {
        const mx = Math.round((s.x + e.x) / 2);
        const my = Math.round((s.y + e.y) / 2);
        const pts = fs === "n" || fs === "s" ? [s, { x: s.x, y: my }, { x: e.x, y: my }, e] : [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e];
        const mid = samplePoly(pts, 0.5);
        return { d: pts.map((p, i) => (i === 0 ? "M " : "L ") + Math.round(p.x) + " " + Math.round(p.y)).join(" "), lx: Math.round(mid.x), ly: Math.round(mid.y) - 8 };
      }
      if (bends.length > 0) {
        const pts = [s, ...bends, e];
        const mid = samplePoly(pts, 0.5);
        return { d: catmull(pts), lx: Math.round(mid.x), ly: Math.round(mid.y) - 8 };
      }
      const span = Math.max(32, Math.min(140, Math.hypot(e.x - s.x, e.y - s.y) * 0.42));
      const v1 = arr.from && "id" in arr.from ? sideVec(fs, span) : { x: (e.x - s.x) * 0.35, y: 0 };
      const v2 = arr.to && "id" in arr.to ? sideVec(ts, span) : { x: -(e.x - s.x) * 0.35, y: 0 };
      const c1 = { x: s.x + v1.x, y: s.y + v1.y };
      const c2 = { x: e.x + v2.x, y: e.y + v2.y };
      return {
        d: "M " + Math.round(s.x) + " " + Math.round(s.y) + " C " + Math.round(c1.x) + " " + Math.round(c1.y) + ", " + Math.round(c2.x) + " " + Math.round(c2.y) + ", " + Math.round(e.x) + " " + Math.round(e.y),
        lx: Math.round((s.x + 3 * c1.x + 3 * c2.x + e.x) / 8),
        ly: Math.round((s.y + 3 * c1.y + 3 * c2.y + e.y) / 8) - 8,
      };
    };

    const fillTone = (fill, shape) => {
      if (!fill && (shape === "sticky" || shape === "card")) return "tone-sun";
      if (fill === "sun" || fill === "wheat" || fill === "amber" || fill === "yellow") return "tone-sun";
      if (fill === "peach" || fill === "orange") return "tone-peach";
      if (fill === "leaf" || fill === "green" || fill === "ok") return "tone-leaf";
      if (fill === "water" || fill === "blue") return "tone-water";
      if (fill === "lavender" || fill === "purple") return "tone-lavender";
      if (fill === "berry" || fill === "red" || fill === "bad") return "tone-berry";
      if (fill === "side" || fill === "muted" || fill === "neutral") return "tone-side";
      return "tone-page";
    };

    const effectiveElements = () => {
      return elements.map((el) => {
        if (dragState && dragState.kind === "nodes" && dragState.offsets[el.id]) {
          const d = dragState.offsets[el.id];
          const copy = Object.assign({}, el, { x: (el.x ?? 0) + d.dx, y: (el.y ?? 0) + d.dy });
          if (Array.isArray(el.points)) {
            copy.points = el.points.map((p) => ({ x: p.x + d.dx, y: p.y + d.dy }));
          }
          return copy;
        }
        if (dragState && dragState.kind === "resize" && dragState.id === el.id) {
          return Object.assign({}, el, { x: dragState.nx, y: dragState.ny, w: dragState.nw, h: dragState.nh });
        }
        return el;
      });
    };

    const updateDockUI = () => {
      for (const btn of dockEl.querySelectorAll(".wb-dock-btn[data-tool]")) {
        btn.classList.toggle("is-active", btn.getAttribute("data-tool") === tool);
      }
      viewport.classList.toggle("is-crosshair", tool !== "select" && tool !== "pan");
      viewport.classList.toggle("is-grab", tool === "pan" || spacePan);
    };

    const stickerImgUrl = (el) => {
      if (el.stickerSvg && String(el.stickerSvg).trim().startsWith("<svg")) {
        return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(el.stickerSvg);
      }
      if (el.sticker && STICKERS[el.sticker]) return STICKERS[el.sticker];
      return null;
    };

    const renderSvgOnly = (all, byId) => {
      const arrows = all.filter((e) => e.type === "arrow");
      const timelines = all.filter((e) => e.type === "timeline");
      const paths = all.filter((e) => e.type === "path");

      let svgParts = '<defs><linearGradient id="wb-grad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#dd6f57"/><stop offset="55%" stop-color="#ec9658"/><stop offset="100%" stop-color="#e5864c"/></linearGradient><marker id="wb-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="var(--vv-wb-arrow)"/></marker><marker id="wb-ah-sel" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="var(--vv-accent)"/></marker></defs>';

      for (const arr of arrows) {
        const g = arrowPath(arr, byId);
        if (!g) continue;
        const isSel = selectedIds.includes(arr.id);
        const stroke = isSel ? "var(--vv-accent)" : (arr.stroke || "var(--vv-wb-arrow)");
        const dash = arr.style === "dashed" ? ' stroke-dasharray="5 4"' : "";
        const marker = arr.head === "none" ? "" : ' marker-end="' + (isSel ? "url(#wb-ah-sel)" : "url(#wb-ah)") + '"';
        svgParts += '<path class="wb-svg-hit" data-id="' + escapeHtml(arr.id) + '" d="' + g.d + '" fill="none" stroke="transparent" stroke-width="14"/>';
        svgParts += '<path d="' + g.d + '" fill="none" stroke="' + escapeHtml(stroke) + '" stroke-width="' + (isSel ? "2.6" : "1.7") + '"' + dash + marker + "/>";
        if (arr.label) {
          svgParts += '<text x="' + g.lx + '" y="' + g.ly + '" text-anchor="middle" fill="var(--vv-muted)" font-size="11.5" font-weight="500">' + escapeHtml(arr.label) + "</text>";
        }
      }

      for (const tl of timelines) {
        const pts = Array.isArray(tl.points) && tl.points.length >= 2 ? tl.points : [{ x: tl.x ?? 80, y: (tl.y ?? 200) + 40 }, { x: (tl.x ?? 80) + (tl.w ?? 640), y: (tl.y ?? 200) + 40 }];
        const d = catmull(pts);
        const isSel = selectedIds.includes(tl.id);
        svgParts += '<path d="' + d + '" fill="none" stroke="url(#wb-grad)" stroke-width="' + (isSel ? "11" : "9") + '" stroke-linecap="round" stroke-linejoin="round" opacity="' + (isSel ? "1" : "0.94") + '"/>';
      }

      for (const p of paths) {
        if (!Array.isArray(p.points) || p.points.length < 2) continue;
        const d = catmull(p.points, 0.45);
        const isSel = selectedIds.includes(p.id);
        svgParts += '<path d="' + d + '" fill="none" stroke="' + escapeHtml(isSel ? "var(--vv-accent)" : (p.stroke || "#c25140")) + '" stroke-width="' + (p.strokeWidth ?? 3) + '" stroke-linecap="round" stroke-linejoin="round"/>';
      }

      if (dragState && dragState.kind === "pen" && dragState.points.length >= 2) {
        svgParts += '<path d="' + catmull(dragState.points, 0.45) + '" fill="none" stroke="#c25140" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
      }

      if (dragState && dragState.kind === "connect" && dragState.endPt) {
        const s = anchorPt({ id: dragState.fromId, side: dragState.fromSide }, byId, "e");
        if (s) {
          svgParts += '<path d="M ' + Math.round(s.x) + " " + Math.round(s.y) + " L " + Math.round(dragState.endPt.x) + " " + Math.round(dragState.endPt.y) + '" fill="none" stroke="var(--vv-accent)" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#wb-ah-sel)"/>';
        }
      }

      backSvg.innerHTML = svgParts;
    };

    const render = () => {
      const all = effectiveElements();
      const byId = new Map(all.map((e) => [e.id, e]));
      const boxes = all.filter((e) => e.type !== "arrow");
      emptyEl.style.display = all.length === 0 ? "flex" : "none";

      renderSvgOnly(all, byId);

      nodesLayer.innerHTML = "";
      for (const el of boxes) {
        const node = document.createElement("div");
        const isSel = selectedIds.includes(el.id);
        const isArrowSrc = arrowStart && arrowStart.id === el.id;
        let cls = "wb-node";
        if (el.type === "container") cls += " wb-container";
        else if (el.type === "claim") cls += " wb-claim";
        else if (el.type === "text") cls += " wb-text wb-text-" + (el.variant || "body");
        else if (el.type === "timeline") cls += " wb-timeline";
        else if (el.type === "path") cls += " wb-path-box";
        else if (el.type === "sticker" || el.type === "svg") cls += " wb-sticker-box";
        else if (el.shape === "pill" || el.shape === "ellipse") cls += " wb-pill " + fillTone(el.fill, el.shape);
        else cls += " wb-box " + fillTone(el.fill, el.shape);
        if (isSel || isArrowSrc) cls += " is-selected";
        node.className = cls;

        let nx = el.x ?? 0, ny = el.y ?? 0, nw = el.w ?? 188, nh = el.h ?? 96;
        if (el.type === "path" && Array.isArray(el.points) && el.points.length > 0) {
          const xs = el.points.map((p) => p.x), ys = el.points.map((p) => p.y);
          nx = Math.min(...xs) - 8;
          ny = Math.min(...ys) - 8;
          nw = Math.max(24, Math.max(...xs) - nx + 8);
          nh = Math.max(24, Math.max(...ys) - ny + 8);
        }
        node.style.left = nx + "px";
        node.style.top = ny + "px";
        node.style.width = nw + "px";
        node.style.minHeight = nh + "px";
        if (el.type === "container" || el.type === "claim" || el.type === "timeline" || el.type === "sticker" || el.type === "svg") {
          node.style.height = nh + "px";
        }
        node.dataset.id = el.id;
        if (el.type === "shape" || el.type === "text" || el.type === "container") node.title = DBL_HINT;

        const stickerSrc = stickerImgUrl(el);
        const hasFloatingSticker = el.type === "shape" && Boolean(stickerSrc || el.sticker);

        if (editingId === el.id) {
          const wrap = document.createElement("div");
          wrap.className = "wb-edit-wrap";
          const inp = document.createElement("input");
          inp.className = "wb-inline-input";
          inp.value = labelOf(el);
          let bodyInp = null;
          if (el.type === "shape" && (el.shape === "card" || el.shape === "sticky" || bodyOf(el))) {
            bodyInp = document.createElement("input");
            bodyInp.className = "wb-inline-input wb-inline-sub";
            bodyInp.value = bodyOf(el);
          }
          let done = false;
          const commit = () => {
            if (done) return;
            done = true;
            editingId = null;
            const msg = { vibevalley: "wb-label", id: el.id, text: inp.value.trim() };
            if (bodyInp) msg.body = bodyInp.value.trim();
            say(msg);
            render();
          };
          const handleKey = (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); commit(); }
            if (ev.key === "Escape") { done = true; editingId = null; render(); }
          };
          const handleBlur = () => setTimeout(() => { if (!wrap.contains(document.activeElement)) commit(); }, 0);
          inp.addEventListener("keydown", handleKey);
          inp.addEventListener("blur", handleBlur);
          wrap.appendChild(inp);
          if (bodyInp) {
            bodyInp.addEventListener("keydown", handleKey);
            bodyInp.addEventListener("blur", handleBlur);
            wrap.appendChild(bodyInp);
          }
          node.appendChild(wrap);
          queueMicrotask(() => { inp.focus(); inp.select(); });
        } else if (el.type === "timeline") {
          const pts = Array.isArray(el.points) && el.points.length >= 2 ? el.points : [{ x: nx, y: ny + nh / 2 }, { x: nx + nw, y: ny + nh / 2 }];
          const ms = el.milestones || [];
          for (let i = 0; i < ms.length; i++) {
            const m = ms[i];
            const pt = m.x !== undefined && m.y !== undefined ? { x: m.x, y: m.y } : samplePoly(pts, m.t ?? (i + 1) / (ms.length + 1));
            const pill = document.createElement("div");
            pill.className = m.kind === "minor" ? "wb-ms-minor" : "wb-ms-major";
            pill.style.left = Math.round(pt.x - nx) + "px";
            pill.style.top = Math.round(pt.y - ny) + "px";
            pill.textContent = m.label;
            node.appendChild(pill);
            if (m.caption) {
              const cap = document.createElement("div");
              cap.className = "wb-ms-caption";
              cap.style.left = Math.round(pt.x - nx) + "px";
              cap.style.top = Math.round(pt.y - ny + 18) + "px";
              cap.textContent = m.caption;
              node.appendChild(cap);
            }
          }
        } else if (el.type === "path") {
          node.innerHTML = "";
        } else if (el.type === "table") {
          let html = '<table class="wb-table">';
          if (Array.isArray(el.headers) && el.headers.length > 0) {
            html += "<thead><tr>" + el.headers.map((h) => "<th>" + escapeHtml(h) + "</th>").join("") + "</tr></thead>";
          }
          html += "<tbody>" + (el.rows || []).map((r) => "<tr>" + r.map((c) => "<td>" + escapeHtml(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>";
          node.innerHTML = html;
        } else if (el.type === "svg" && el.sanitizedSvg) {
          const img = document.createElement("img");
          img.className = "wb-svg-img";
          img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(el.sanitizedSvg);
          img.alt = labelOf(el) || el.id;
          node.appendChild(img);
        } else if (el.type === "sticker") {
          if (stickerSrc) {
            const img = document.createElement("img");
            img.className = "wb-svg-img";
            img.src = stickerSrc;
            img.alt = labelOf(el) || el.sticker || el.id;
            node.appendChild(img);
          } else if (el.sticker) {
            const emo = document.createElement("div");
            emo.className = "wb-emoji-sticker";
            emo.textContent = el.sticker;
            node.appendChild(emo);
          }
        } else if (el.type === "html") {
          node.innerHTML = '<div class="wb-embed-badge">HTML · ' + escapeHtml(labelOf(el) || el.id) + "</div>";
        } else if (el.type === "claim") {
          node.innerHTML = '<div class="wb-claim-label">' + escapeHtml(labelOf(el) || el.id) + "</div>";
        } else if (el.type === "container") {
          node.innerHTML = '<div class="wb-container-label">' + escapeHtml(labelOf(el) || el.id) + "</div>";
        } else if (el.type === "text") {
          const rawTitle = labelOf(el);
          if (el.align) node.style.textAlign = el.align;
          if (el.variant === "subtitle" && el.highlight && rawTitle.includes(el.highlight)) {
            const idx = rawTitle.indexOf(el.highlight);
            const div = document.createElement("div");
            div.className = "wb-subtitle-copy";
            div.innerHTML = escapeHtml(rawTitle.slice(0, idx)) + '<span class="wb-hl">' + escapeHtml(el.highlight) + "</span>" + escapeHtml(rawTitle.slice(idx + el.highlight.length));
            node.appendChild(div);
          } else if (el.variant === "callout") {
            const div = document.createElement("div");
            div.className = "wb-callout-row";
            if (el.icon) {
              const ic = document.createElement("span");
              ic.className = "wb-callout-icon";
              ic.textContent = el.icon;
              div.appendChild(ic);
            }
            const sp = document.createElement("span");
            sp.textContent = rawTitle;
            div.appendChild(sp);
            node.appendChild(div);
          } else {
            const span = document.createElement("div");
            span.className = el.variant === "title" ? "wb-title-copy" : el.variant === "subtitle" ? "wb-subtitle-copy" : "wb-text-copy";
            span.textContent = rawTitle;
            node.appendChild(span);
          }
        } else {
          if (hasFloatingSticker) {
            node.classList.add("has-sticker");
            if (stickerSrc) {
              const stImg = document.createElement("img");
              stImg.className = "wb-card-sticker";
              stImg.src = stickerSrc;
              stImg.alt = el.sticker || "";
              node.appendChild(stImg);
            } else if (el.sticker) {
              const stEmo = document.createElement("div");
              stEmo.className = "wb-card-emoji";
              stEmo.textContent = el.sticker;
              node.appendChild(stEmo);
            }
          }
          if (el.badge) {
            const bd = document.createElement("div");
            bd.className = "wb-badge";
            bd.textContent = el.badge;
            node.appendChild(bd);
          }
          const t = document.createElement("div");
          t.className = bodyOf(el) ? "wb-card-title" : "wb-label";
          t.textContent = labelOf(el);
          node.appendChild(t);
          const b = bodyOf(el);
          if (b) {
            const sub = document.createElement("div");
            sub.className = "wb-card-body";
            sub.textContent = b;
            node.appendChild(sub);
          }
        }

        if (isSel && editingId !== el.id && el.type !== "path") {
          for (const side of ["n", "e", "s", "w"]) {
            const port = document.createElement("div");
            port.className = "wb-port wb-port-" + side;
            port.addEventListener("pointerdown", (ev) => {
              ev.stopPropagation();
              dragState = { kind: "connect", fromId: el.id, fromSide: side, endPt: anchorPt({ id: el.id, side }, byId, side) };
              renderSvgOnly(effectiveElements(), byId);
            });
            node.appendChild(port);
          }
          if (selectedIds.length === 1 && el.type !== "timeline") {
            for (const corner of ["nw", "ne", "se", "sw"]) {
              const hdl = document.createElement("div");
              hdl.className = "wb-handle wb-handle-" + corner;
              hdl.addEventListener("pointerdown", (ev) => {
                ev.stopPropagation();
                dragState = { kind: "resize", id: el.id, corner, startX: ev.clientX, startY: ev.clientY, bx: nx, by: ny, bw: nw, bh: nh, nx, ny, nw, nh };
              });
              node.appendChild(hdl);
            }
          }
        }

        node.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          if (el.type === "shape" || el.type === "text" || el.type === "container") {
            editingId = el.id;
            render();
          }
        });

        node.addEventListener("pointerdown", (ev) => {
          if (editingId === el.id) return;
          if (tool === "pan" || spacePan || tool === "pen") return;
          ev.stopPropagation();
          if (tool === "arrow") {
            if (!arrowStart) {
              arrowStart = { id: el.id, side: "e" };
              selectedIds = [el.id];
              say({ vibevalley: "wb-select", ids: selectedIds });
              render();
            } else if (arrowStart.id !== el.id) {
              const fromId = arrowStart.id;
              arrowStart = null;
              tool = "select";
              updateDockUI();
              say({ vibevalley: "wb-arrow", fromId, toId: el.id });
              render();
            }
            return;
          }
          if (ev.shiftKey) {
            selectedIds = selectedIds.includes(el.id) ? selectedIds.filter((x) => x !== el.id) : [...selectedIds, el.id];
          } else if (!selectedIds.includes(el.id)) {
            selectedIds = [el.id];
          }
          say({ vibevalley: "wb-select", ids: selectedIds });
          const offsets = {};
          for (const sid of selectedIds) {
            if (byId.has(sid)) offsets[sid] = { dx: 0, dy: 0 };
          }
          dragState = { kind: "nodes", startX: ev.clientX, startY: ev.clientY, offsets };
          render();
        });

        nodesLayer.appendChild(node);
      }

      presenceLayer.innerHTML = "";
      for (const p of presences) {
        const badge = document.createElement("div");
        badge.className = "wb-cursor";
        badge.style.left = Math.round(p.x) + "px";
        badge.style.top = Math.round(p.y) + "px";
        const color = PRESENCE_HEX[p.color || "coral"] || "#df765b";
        badge.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1l11 4.5-4.5 1.8L5.5 12z" fill="' + color + '" stroke="#fff" stroke-width="1.2"/></svg>' +
          '<span class="wb-cursor-pill" style="background:' + color + '">' + escapeHtml(p.name) + "</span>";
        presenceLayer.appendChild(badge);
      }

      updateDockUI();
      applyTransform();
    };

    for (const btn of dockEl.querySelectorAll(".wb-dock-btn[data-tool]")) {
      btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const next = btn.getAttribute("data-tool");
        if (next === "sticker") {
          const open = stickerPop.style.display === "grid";
          stickerPop.style.display = open ? "none" : "grid";
          tool = "sticker";
          say({ vibevalley: "wb-tool", tool: "sticker" });
          updateDockUI();
          return;
        }
        stickerPop.style.display = "none";
        tool = next;
        arrowStart = null;
        say({ vibevalley: "wb-tool", tool: next });
        updateDockUI();
      });
    }

    for (const opt of stickerPop.querySelectorAll(".wb-sticker-opt")) {
      opt.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      opt.addEventListener("click", (ev) => {
        ev.stopPropagation();
        pendingSticker = opt.getAttribute("data-sticker") || "sparkles";
        stickerPop.style.display = "none";
        tool = "sticker";
        updateDockUI();
      });
    }

    document.getElementById("wb-dock-chat").addEventListener("pointerdown", (ev) => ev.stopPropagation());
    document.getElementById("wb-dock-chat").addEventListener("click", (ev) => {
      ev.stopPropagation();
      say({ vibevalley: "wb-chat" });
    });

    for (const tb of document.querySelectorAll("[data-template]")) {
      tb.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      tb.addEventListener("click", (ev) => {
        ev.stopPropagation();
        say({ vibevalley: "wb-template", template: tb.getAttribute("data-template") });
      });
    }

    viewport.addEventListener("pointerdown", (ev) => {
      stickerPop.style.display = "none";
      if (tool === "pan" || spacePan || ev.button === 1) {
        dragState = { kind: "pan", startX: ev.clientX, startY: ev.clientY, basePanX: panX, basePanY: panY };
        return;
      }
      if (tool === "pen") {
        const pt = toWorld(ev.clientX, ev.clientY);
        dragState = { kind: "pen", points: [pt] };
        return;
      }
      if (tool !== "select" && tool !== "arrow") {
        const pt = toWorld(ev.clientX, ev.clientY);
        const msg = { vibevalley: "wb-create", kind: tool, x: pt.x, y: pt.y };
        if (tool === "sticker") msg.sticker = pendingSticker;
        say(msg);
        tool = "select";
        updateDockUI();
        return;
      }
      if (!ev.shiftKey) {
        selectedIds = [];
        arrowStart = null;
        say({ vibevalley: "wb-select", ids: [] });
      }
      const pt = toWorld(ev.clientX, ev.clientY);
      dragState = { kind: "marquee", startPt: pt, endPt: pt };
      render();
    });

    window.addEventListener("pointermove", (ev) => {
      if (!dragState) return;
      if (dragState.kind === "pan") {
        panX = dragState.basePanX + (ev.clientX - dragState.startX);
        panY = dragState.basePanY + (ev.clientY - dragState.startY);
        applyTransform();
        return;
      }
      if (dragState.kind === "pen") {
        const pt = toWorld(ev.clientX, ev.clientY);
        const last = dragState.points[dragState.points.length - 1];
        if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= 3) {
          dragState.points.push(pt);
          const all = effectiveElements();
          renderSvgOnly(all, new Map(all.map((e) => [e.id, e])));
        }
        return;
      }
      if (dragState.kind === "connect") {
        dragState.endPt = toWorld(ev.clientX, ev.clientY);
        const all = effectiveElements();
        renderSvgOnly(all, new Map(all.map((e) => [e.id, e])));
        return;
      }
      if (dragState.kind === "marquee") {
        dragState.endPt = toWorld(ev.clientX, ev.clientY);
        const x1 = Math.min(dragState.startPt.x, dragState.endPt.x);
        const y1 = Math.min(dragState.startPt.y, dragState.endPt.y);
        const x2 = Math.max(dragState.startPt.x, dragState.endPt.x);
        const y2 = Math.max(dragState.startPt.y, dragState.endPt.y);
        marqueeEl.style.display = "block";
        marqueeEl.style.left = x1 + "px";
        marqueeEl.style.top = y1 + "px";
        marqueeEl.style.width = (x2 - x1) + "px";
        marqueeEl.style.height = (y2 - y1) + "px";
        return;
      }
      if (dragState.kind === "nodes") {
        const dx = Math.round((ev.clientX - dragState.startX) / zoom);
        const dy = Math.round((ev.clientY - dragState.startY) / zoom);
        for (const id of Object.keys(dragState.offsets)) {
          dragState.offsets[id] = { dx, dy };
        }
        render();
        return;
      }
      if (dragState.kind === "resize") {
        const dx = Math.round((ev.clientX - dragState.startX) / zoom);
        const dy = Math.round((ev.clientY - dragState.startY) / zoom);
        let nx = dragState.bx, ny = dragState.by, nw = dragState.bw, nh = dragState.bh;
        if (dragState.corner.includes("e")) nw = Math.max(64, dragState.bw + dx);
        if (dragState.corner.includes("s")) nh = Math.max(36, dragState.bh + dy);
        if (dragState.corner.includes("w")) {
          nw = Math.max(64, dragState.bw - dx);
          nx = dragState.bx + (dragState.bw - nw);
        }
        if (dragState.corner.includes("n")) {
          nh = Math.max(36, dragState.bh - dy);
          ny = dragState.by + (dragState.bh - nh);
        }
        dragState.nx = Math.round(nx / 4) * 4;
        dragState.ny = Math.round(ny / 4) * 4;
        dragState.nw = Math.round(nw / 4) * 4;
        dragState.nh = Math.round(nh / 4) * 4;
        render();
      }
    });

    window.addEventListener("pointerup", (ev) => {
      if (!dragState) return;
      const done = dragState;
      dragState = null;
      marqueeEl.style.display = "none";
      if (done.kind === "pen" && done.points.length >= 2) {
        say({ vibevalley: "wb-path", points: done.points });
        render();
        return;
      }
      if (done.kind === "connect") {
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetNode = under && under.closest ? under.closest("[data-id]") : null;
        const toId = targetNode && targetNode.dataset ? targetNode.dataset.id : null;
        if (toId && toId !== done.fromId) {
          say({ vibevalley: "wb-arrow", fromId: done.fromId, toId, fromSide: done.fromSide });
        }
        render();
        return;
      }
      if (done.kind === "marquee") {
        const x1 = Math.min(done.startPt.x, done.endPt.x);
        const y1 = Math.min(done.startPt.y, done.endPt.y);
        const x2 = Math.max(done.startPt.x, done.endPt.x);
        const y2 = Math.max(done.startPt.y, done.endPt.y);
        if (x2 - x1 > 6 || y2 - y1 > 6) {
          const hits = elements
            .filter((el) => el.type !== "arrow")
            .filter((el) => {
              const ex = el.x ?? 0, ey = el.y ?? 0, ew = el.w ?? 180, eh = el.h ?? 90;
              return ex + ew >= x1 && ex <= x2 && ey + eh >= y1 && ey <= y2;
            })
            .map((el) => el.id);
          if (hits.length > 0) {
            selectedIds = Array.from(new Set(hits));
            say({ vibevalley: "wb-select", ids: selectedIds });
          }
        }
        render();
        return;
      }
      if (done.kind === "nodes") {
        const moves = [];
        for (const el of elements) {
          const d = done.offsets[el.id];
          if (d && (Math.abs(d.dx) > 2 || Math.abs(d.dy) > 2)) {
            moves.push({
              id: el.id,
              x: Math.round(((el.x ?? 0) + d.dx) / 4) * 4,
              y: Math.round(((el.y ?? 0) + d.dy) / 4) * 4,
            });
          }
        }
        if (moves.length > 0) say({ vibevalley: "wb-move", moves });
        return;
      }
      if (done.kind === "resize") {
        if (done.nw !== done.bw || done.nh !== done.bh || done.nx !== done.bx || done.ny !== done.by) {
          say({ vibevalley: "wb-resize", id: done.id, x: done.nx, y: done.ny, w: done.nw, h: done.nh });
        }
      }
    });

    backSvg.addEventListener("pointerdown", (ev) => {
      const target = ev.target;
      const id = target && target.dataset ? target.dataset.id : null;
      if (!id) return;
      ev.stopPropagation();
      selectedIds = [id];
      say({ vibevalley: "wb-select", ids: selectedIds });
      render();
    });

    viewport.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        const r = viewport.getBoundingClientRect();
        const cx = ev.clientX - r.left;
        const cy = ev.clientY - r.top;
        const oldZoom = zoom;
        const factor = ev.deltaY < 0 ? 1.08 : 0.92;
        zoom = Math.max(0.25, Math.min(2.5, Math.round(zoom * factor * 100) / 100));
        const ratio = zoom / oldZoom;
        panX = cx - (cx - panX) * ratio;
        panY = cy - (cy - panY) * ratio;
        applyTransform();
        say({ vibevalley: "wb-viewport", zoom });
      } else {
        panX -= ev.deltaX;
        panY -= ev.deltaY;
        applyTransform();
      }
    }, { passive: false });

    const TOOL_KEYS = { v: "select", h: "pan", t: "text", f: "container", s: "sticky", p: "pen", r: "rect", k: "sticker", a: "arrow", l: "timeline" };
    window.addEventListener("keydown", (ev) => {
      if (editingId || (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA"))) return;
      if (ev.code === "Space") {
        if (!spacePan) { spacePan = true; updateDockUI(); }
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") {
        ev.preventDefault();
        say({ vibevalley: ev.shiftKey ? "wb-redo" : "wb-undo" });
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "d" && selectedIds.length > 0) {
        ev.preventDefault();
        say({ vibevalley: "wb-duplicate", ids: selectedIds });
        return;
      }
      if ((ev.key === "Backspace" || ev.key === "Delete") && selectedIds.length > 0) {
        ev.preventDefault();
        say({ vibevalley: "wb-delete", ids: selectedIds });
        return;
      }
      if (ev.key === "Escape") {
        stickerPop.style.display = "none";
        arrowStart = null;
        if (tool !== "select") {
          tool = "select";
          say({ vibevalley: "wb-tool", tool: "select" });
        } else if (selectedIds.length > 0) {
          selectedIds = [];
          say({ vibevalley: "wb-select", ids: [] });
        }
        render();
        return;
      }
      const mapped = TOOL_KEYS[ev.key.toLowerCase()];
      if (mapped && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        tool = mapped;
        say({ vibevalley: "wb-tool", tool: mapped });
        updateDockUI();
      }
    });
    window.addEventListener("keyup", (ev) => {
      if (ev.code === "Space" && spacePan) { spacePan = false; updateDockUI(); }
    });

    const fitView = () => {
      const boxes = elements.filter((e) => e.type !== "arrow");
      if (boxes.length === 0) {
        panX = 36; panY = 28; zoom = 1;
      } else {
        const minX = Math.min(...boxes.map((b) => b.x ?? 0));
        const minY = Math.min(...boxes.map((b) => (b.sticker || b.stickerSvg ? (b.y ?? 0) - 34 : (b.y ?? 0))));
        const maxX = Math.max(...boxes.map((b) => (b.x ?? 0) + (b.w ?? 188)));
        const maxY = Math.max(...boxes.map((b) => (b.y ?? 0) + (b.h ?? 96)));
        const cw = Math.max(240, maxX - minX + 96);
        const ch = Math.max(200, maxY - minY + 128);
        const rect = viewport.getBoundingClientRect();
        if (rect.width > 40 && rect.height > 40) {
          zoom = Math.max(0.32, Math.min(1.25, Math.round(Math.min(rect.width / cw, rect.height / ch) * 100) / 100));
          panX = Math.round((rect.width - (maxX - minX) * zoom) / 2 - minX * zoom);
          panY = Math.round(32 - minY * zoom);
        }
      }
      applyTransform();
      say({ vibevalley: "wb-viewport", zoom });
    };

    window.__wb = {
      sync: (next) => {
        if (Array.isArray(next.elements)) elements = next.elements;
        if (Array.isArray(next.presences)) presences = next.presences;
        if (Array.isArray(next.selectedIds)) selectedIds = next.selectedIds;
        if (typeof next.tool === "string") { tool = next.tool; arrowStart = null; }
        if (next.theme === "light" || next.theme === "dark") {
          document.documentElement.setAttribute("data-theme", next.theme);
          document.documentElement.style.cssText = next.themeCss || "";
        }
        if (!didInitialFit && elements.length > 0) {
          didInitialFit = true;
          requestAnimationFrame(fitView);
        }
        render();
      },
      zoomBy: (delta) => {
        zoom = Math.max(0.25, Math.min(2.5, Math.round((zoom + delta) * 100) / 100));
        applyTransform();
        say({ vibevalley: "wb-viewport", zoom });
      },
      fitView,
    };

    render();
    say({ vibevalley: "wb-ready" });
  })();`;

  return `<!doctype html>
<html lang="zh" data-theme="${initialTheme}" style="${themeVariables[initialTheme]}${typeVariables}">
<head>
<meta charset="utf-8" />
<style>
:root{--vv-wb-arrow:#b86b4d;--vv-wb-hl-bg:rgba(77,114,255,0.12);--vv-wb-hl-ink:#3655d9;--vv-wb-shadow:0 8px 22px rgba(28,25,23,0.08),0 1px 3px rgba(28,25,23,0.05)}
[data-theme="dark"]{--vv-wb-arrow:#d69072;--vv-wb-hl-bg:rgba(106,166,220,0.22);--vv-wb-hl-ink:#8fc1ef;--vv-wb-shadow:0 10px 26px rgba(0,0,0,0.45),0 1px 3px rgba(0,0,0,0.25)}
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--vv-page);color:var(--vv-ink);font-family:var(--vv-font-sans);user-select:none;-webkit-user-select:none}
#wb-viewport{position:relative;width:100%;height:100%;overflow:hidden;background-color:var(--vv-page);background-image:linear-gradient(to right,color-mix(in srgb,var(--vv-line) 55%,transparent) 1px,transparent 1px),linear-gradient(to bottom,color-mix(in srgb,var(--vv-line) 55%,transparent) 1px,transparent 1px);background-size:24px 24px;cursor:default}
#wb-viewport.is-crosshair{cursor:crosshair}
#wb-viewport.is-grab{cursor:grab}
#wb-viewport.is-grab:active{cursor:grabbing}
#wb-stage{position:absolute;left:0;top:0;transform-origin:0 0}
#wb-svg-back{position:absolute;left:0;top:0;width:4800px;height:3600px;overflow:visible;pointer-events:none}
#wb-svg-back .wb-svg-hit{pointer-events:stroke;cursor:pointer}
#wb-nodes{position:absolute;left:0;top:0}
#wb-presence{position:absolute;left:0;top:0;pointer-events:none;z-index:20}
#wb-marquee{position:absolute;display:none;border:1.5px solid var(--vv-accent);background:color-mix(in srgb,var(--vv-accent) 12%,transparent);border-radius:4px;pointer-events:none;z-index:18}
#wb-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:32px;text-align:center;color:var(--vv-muted);font-size:13px;pointer-events:none}
.wb-empty-actions{display:flex;gap:8px;pointer-events:auto}
.wb-tpl-btn{height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--vv-line);background:var(--vv-side);color:var(--vv-ink);font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.06)}
.wb-tpl-btn:hover{border-color:var(--vv-accent);color:var(--vv-accent)}
.wb-node{position:absolute;cursor:pointer;transition:box-shadow 120ms ease-out}
.wb-node.is-selected{outline:2px solid var(--vv-accent);outline-offset:3px;border-radius:14px}
.wb-box{display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;border-radius:14px;border:1px solid var(--vv-line);padding:14px 14px 12px;box-shadow:var(--vv-wb-shadow)}
.wb-box.has-sticker{padding-top:26px}
.wb-card-sticker{position:absolute;top:-26px;left:50%;transform:translateX(-50%);width:58px;height:48px;object-fit:contain;pointer-events:none;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.14))}
.wb-card-emoji{position:absolute;top:-20px;left:50%;transform:translateX(-50%);font-size:28px;line-height:1;pointer-events:none}
.wb-badge{position:absolute;top:8px;right:10px;font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;background:rgba(28,25,23,0.08);color:inherit}
.wb-pill{display:flex;align-items:center;justify-content:center;border-radius:999px;border:1px solid var(--vv-line);padding:8px 16px;box-shadow:var(--vv-wb-shadow)}
.wb-container{border-radius:14px;border:1.8px dashed var(--vv-faint);background:color-mix(in srgb,var(--vv-side) 65%,transparent);padding:12px}
.wb-claim{border-radius:14px;border:2px dashed var(--vv-wheat);background:color-mix(in srgb,var(--vv-wheat) 10%,transparent);padding:12px}
.wb-timeline{pointer-events:auto}
.wb-ms-major{position:absolute;transform:translate(-50%,-50%);padding:4px 12px;border-radius:999px;background:#df765b;color:#fff;font-size:11.5px;font-weight:700;white-space:nowrap;box-shadow:0 3px 10px rgba(223,118,91,0.34)}
.wb-ms-minor{position:absolute;transform:translate(-50%,-50%);width:22px;height:22px;border-radius:999px;background:var(--vv-page);border:1.8px solid #e58d5e;color:var(--vv-ink);font-size:10.5px;font-weight:600;display:flex;align-items:center;justify-content:center}
.wb-ms-caption{position:absolute;transform:translateX(-50%);font-size:11.5px;font-weight:600;color:var(--vv-ink);white-space:nowrap}
.wb-text{padding:2px 4px;color:var(--vv-ink)}
.wb-title-copy{font-family:Georgia,"Times New Roman","Songti SC","STSong",serif;font-size:32px;font-weight:600;line-height:1.15;letter-spacing:-0.02em;color:var(--vv-ink)}
.wb-subtitle-copy{font-size:13.5px;line-height:1.45;color:var(--vv-muted)}
.wb-hl{display:inline-block;padding:0 5px;border-radius:5px;background:var(--vv-wb-hl-bg);color:var(--vv-wb-hl-ink);font-weight:600}
.wb-callout-row{display:flex;align-items:flex-start;gap:7px;font-size:12.5px;line-height:1.4;font-weight:500;color:var(--vv-ink)}
.wb-callout-icon{font-size:15px;line-height:1.2;flex-shrink:0}
.wb-text-copy{font-size:14px;font-weight:500;line-height:1.4}
.wb-label{text-align:center;font-size:13px;font-weight:600;word-break:break-word}
.wb-card-title{font-size:13px;font-weight:700;line-height:1.3;margin-bottom:3px;word-break:break-word}
.wb-card-body{font-size:12px;line-height:1.35;opacity:0.86;word-break:break-word}
.wb-container-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--vv-muted)}
.wb-claim-label{font-size:12px;font-weight:600;color:var(--vv-wheat)}
.wb-embed-badge{font-size:12px;font-family:var(--vv-font-mono);color:var(--vv-muted);text-align:center}
.wb-svg-img{width:100%;height:100%;object-fit:contain;pointer-events:none}
.wb-emoji-sticker{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:36px}
.wb-edit-wrap{width:100%;display:flex;flex-direction:column;gap:4px}
.wb-inline-input{width:100%;border-radius:6px;border:1.5px solid var(--vv-accent);background:var(--vv-page);color:var(--vv-ink);padding:4px 6px;font-size:12.5px;font-weight:600;text-align:center;outline:none}
.wb-inline-sub{font-weight:400;font-size:11.5px}
.wb-table{width:100%;border-collapse:collapse;font-size:12px;text-align:left;background:var(--vv-page);border:1px solid var(--vv-line);border-radius:8px;overflow:hidden}
.wb-table th,.wb-table td{border-bottom:1px solid var(--vv-line);padding:5px 8px}
.wb-table th{color:var(--vv-muted);font-weight:600}
.wb-port{position:absolute;width:10px;height:10px;border-radius:999px;background:var(--vv-page);border:2px solid var(--vv-accent);opacity:0;transition:opacity 120ms ease;cursor:crosshair;z-index:12}
.wb-node.is-selected .wb-port{opacity:0.95}
.wb-port-n{top:-6px;left:50%;transform:translateX(-50%)}
.wb-port-s{bottom:-6px;left:50%;transform:translateX(-50%)}
.wb-port-w{left:-6px;top:50%;transform:translateY(-50%)}
.wb-port-e{right:-6px;top:50%;transform:translateY(-50%)}
.wb-handle{position:absolute;width:8px;height:8px;background:var(--vv-page);border:1.8px solid var(--vv-accent);border-radius:2px;z-index:13}
.wb-handle-nw{top:-5px;left:-5px;cursor:nwse-resize}
.wb-handle-ne{top:-5px;right:-5px;cursor:nesw-resize}
.wb-handle-sw{bottom:-5px;left:-5px;cursor:nesw-resize}
.wb-handle-se{bottom:-5px;right:-5px;cursor:nwse-resize}
.wb-cursor{position:absolute;display:flex;align-items:flex-start;pointer-events:none;transition:left 160ms ease-out,top 160ms ease-out}
.wb-cursor-pill{margin-left:3px;margin-top:9px;padding:3px 9px;border-radius:7px;color:#fff;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 3px 10px rgba(0,0,0,0.18)}
.tone-page{background:var(--vv-page);border-color:var(--vv-line);color:var(--vv-ink)}
.tone-side{background:var(--vv-side);border-color:var(--vv-line);color:var(--vv-ink)}
.tone-sun{background:#ffe380;border-color:#ecc346;color:#2a210f}
.tone-peach{background:#ffc183;border-color:#e79e54;color:#2b190b}
.tone-leaf{background:#e4efd8;border-color:#74a046;color:#1f2e14}
.tone-water{background:#e1eef9;border-color:#3d7cb5;color:#13293d}
.tone-lavender{background:#ebe5f8;border-color:#8c74c9;color:#241b3d}
.tone-berry{background:#f8e2de;border-color:#c25140;color:#3d1611}
[data-theme="dark"] .tone-sun{background:#403517;border-color:#8f7328;color:#fae9b2}
[data-theme="dark"] .tone-peach{background:#462c18;border-color:#9d5b2d;color:#fce1c6}
[data-theme="dark"] .tone-leaf{background:#26341c;border-color:#5b8536;color:#dcebc8}
[data-theme="dark"] .tone-water{background:#1c2d3d;border-color:#4a82b5;color:#d5e7f8}
[data-theme="dark"] .tone-lavender{background:#2b243d;border-color:#7a65b5;color:#e6dff9}
[data-theme="dark"] .tone-berry{background:#3f221e;border-color:#b55245;color:#f9dcd8}
#wb-dock{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:5px 7px;border-radius:999px;border:1px solid var(--vv-line);background:color-mix(in srgb,var(--vv-page) 94%,transparent);backdrop-filter:blur(10px);box-shadow:0 10px 28px rgba(0,0,0,0.12);z-index:30}
.wb-dock-btn{width:30px;height:30px;border:none;border-radius:999px;background:transparent;color:var(--vv-muted);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:background 100ms ease,color 100ms ease}
.wb-dock-btn svg{width:17px;height:17px}
.wb-dock-btn:hover{background:color-mix(in srgb,var(--vv-ink) 7%,transparent);color:var(--vv-ink)}
.wb-dock-btn.is-active{background:color-mix(in srgb,var(--vv-accent) 16%,transparent);color:var(--vv-accent)}
.wb-dock-sep{width:1px;height:18px;background:var(--vv-line);margin:0 4px}
#wb-dock-chat{height:28px;padding:0 11px;border-radius:999px;border:1px solid var(--vv-line);background:var(--vv-side);color:var(--vv-ink);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:border-color 120ms ease,background 120ms ease}
#wb-dock-chat:hover{border-color:var(--vv-accent);color:var(--vv-accent)}
#wb-sticker-pop{position:absolute;left:50%;bottom:66px;transform:translateX(-50%);display:none;grid-template-columns:repeat(8,34px);gap:6px;padding:10px;border-radius:14px;border:1px solid var(--vv-line);background:var(--vv-page);box-shadow:0 12px 32px rgba(0,0,0,0.16);z-index:32}
.wb-sticker-opt{width:34px;height:34px;border-radius:8px;border:1px solid transparent;background:var(--vv-side);padding:4px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.wb-sticker-opt:hover{border-color:var(--vv-accent)}
.wb-sticker-opt img{width:100%;height:100%;object-fit:contain}
</style>
</head>
<body>
<div id="wb-viewport">
  <div id="wb-empty">
    <div>${escapeXml(labels.emptyHint)}</div>
    <div class="wb-empty-actions">
      <button class="wb-tpl-btn" data-template="timeline">${escapeXml(labels.templateTimeline)}</button>
      <button class="wb-tpl-btn" data-template="architecture">${escapeXml(labels.templateArchitecture)}</button>
    </div>
  </div>
  <div id="wb-stage">
    <svg id="wb-svg-back"></svg>
    <div id="wb-nodes"></div>
    <div id="wb-marquee"></div>
    <div id="wb-presence"></div>
  </div>
  <div id="wb-sticker-pop">${stickerChoicesHtml}</div>
  <div id="wb-dock">
    ${dockButtonsHtml}
    <span class="wb-dock-sep"></span>
    <button id="wb-dock-chat" type="button">${escapeXml(labels.chatWithOrchestrator)}</button>
  </div>
</div>
<script>${runtime}</script>
</body>
</html>`;
}
