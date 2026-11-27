import { type NotePresence, userId } from "@vibevalley/protocol";

import { tone } from "../../design/tone";

/** One live collaborator highlight rendered inside a sandboxed preview WebView without relaxing CSP. */
export interface PresenceHighlightItem {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly selector?: string;
  readonly status?: string;
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
}

export interface PresenceHighlightCommand {
  readonly vibevalley: "presence-highlight";
  readonly items: readonly PresenceHighlightItem[];
}

const presenceTokenByName: Readonly<Record<string, string>> = {
  coral: "accent",
  teal: "leaf",
  blue: "water",
  water: "water",
  wheat: "wheat",
  leaf: "leaf",
  berry: "berry",
  lavender: "accent",
};

function resolveHighlightColor(raw: string | undefined): string {
  if (!raw) return tone("water");
  if (/^#[0-9a-f]{3,8}$/iu.test(raw)) return raw;
  const mapped = presenceTokenByName[raw.toLowerCase()];
  return tone(mapped ?? "water");
}

export function presenceHighlightCommand(peers: readonly NotePresence[], opts?: { readonly path?: string | undefined }): PresenceHighlightCommand {
  const items: PresenceHighlightItem[] = [];
  for (const p of peers) {
    if (p.id === userId) continue;
    if (opts?.path !== undefined && p.path !== undefined && p.path !== opts.path) continue;
    const hasSelector = typeof p.selector === "string" && p.selector.length > 0;
    const hasPoint = typeof p.x === "number" && typeof p.y === "number";
    if (!hasSelector && !hasPoint) continue;
    items.push({
      id: p.id,
      name: p.name,
      color: resolveHighlightColor(p.color),
      ...(hasSelector ? { selector: p.selector } : {}),
      ...(p.status !== undefined ? { status: p.status } : {}),
      ...(typeof p.x === "number" ? { x: p.x } : {}),
      ...(typeof p.y === "number" ? { y: p.y } : {}),
      ...(typeof p.w === "number" ? { w: p.w } : {}),
      ...(typeof p.h === "number" ? { h: p.h } : {}),
    });
  }
  return { vibevalley: "presence-highlight", items };
}
