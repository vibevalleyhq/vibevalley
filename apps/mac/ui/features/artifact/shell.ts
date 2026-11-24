import { type ArtifactPresence, userId } from "@vibevalley/protocol";

/** The workbench theme the page is shown in: the frame cannot read the workbench's own setting. */
export type ShellTheme = "light" | "dark";

/** One live collaborator highlight rendered inside a sandboxed prototype WebView without relaxing CSP. */
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

const presencePalette: Readonly<Record<string, string>> = {
  coral: "#d9774f",
  teal: "#2f9d8f",
  blue: "#4f86d9",
  water: "#4f86d9",
  wheat: "#c79a2e",
  leaf: "#45bf8c",
  berry: "#d9534f",
  lavender: "#8a5cc4",
};

function resolveHighlightColor(raw: string | undefined): string {
  if (!raw) return "#4f86d9";
  if (/^#[0-9a-f]{3,8}$/iu.test(raw)) return raw;
  return presencePalette[raw.toLowerCase()] ?? "#4f86d9";
}

export function presenceHighlightCommand(peers: readonly ArtifactPresence[], opts?: { readonly path?: string | undefined }): PresenceHighlightCommand {
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
