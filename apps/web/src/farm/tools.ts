// The tools the owner holds over the plots, and what a click with one means. aimTool is the
// rule: the screen shows it while pointing and follows it on a click.

import type { Issue, IssueAct, PlotView, Session } from "@vibevalley/protocol";
import { attentionLabel } from "@vibevalley/protocol/rules";
import { type Bed, isRipe } from "./world/plots";

export type Tool = "hand" | "water" | "bug" | "weed" | "harvest" | "shovel";

export const tools: readonly { readonly id: Tool; readonly label: string; readonly hint: string; readonly icon: string }[] = [
  { id: "hand", label: "手", hint: "点一块地看详情，点空地播种", icon: "icon-hand" },
  { id: "water", label: "浇水", hint: "给帮工带句话，正在干活的会中途收到", icon: "icon-water" },
  { id: "bug", label: "杀虫", hint: "活没做成（地里有虫）：让它接着修", icon: "icon-bug" },
  { id: "weed", label: "除草", hint: "没过验收的意见会长成杂草：帮工修完、下一次验收通过就拔掉", icon: "icon-weed" },
  { id: "harvest", label: "收获", hint: "熟了的地：收下成果，帮工收工", icon: "icon-harvest" },
  { id: "shovel", label: "铲除", hint: "正在干活的叫停；没在干活的请它收工", icon: "icon-shovel" },
];

/** The keys 1–6 pick the tools in this order. */
export const toolForKey = (key: string): Tool | undefined => tools[Number(key) - 1]?.id;

export type BedFxKind = "water" | "spray" | "harvest" | "shovel" | "note";

export interface Aim {
  readonly ok: boolean;
  readonly text: string;
}

/** The tool and target stay fixed for a click; execution checks the latest issue acts. */
export interface PlotAim {
  readonly bed: Bed;
  readonly tool: Tool;
  readonly session: Session | undefined;
  readonly aim: Aim;
}

/** What the page does after a click: nothing more, open the sowing form, the plot, the watering form or the harvest. */
export type ToolResult =
  | { readonly kind: "done" }
  | { readonly kind: "refused"; readonly text: string }
  | { readonly kind: "sow"; readonly station: number }
  | { readonly kind: "inspect"; readonly sessionId: string }
  | { readonly kind: "water"; readonly sessionId: string }
  | { readonly kind: "review"; readonly sessionId: string };

/** Tools select an offered issue act; the issue owns when it is offered. */
export function actForTool(tool: Tool, acts: readonly IssueAct[]): IssueAct | undefined {
  switch (tool) {
    case "water":
      return acts.includes("tell") ? "tell" : undefined;
    case "bug":
      return acts.includes("cure") ? "cure" : undefined;
    case "harvest":
      return acts.includes("complete") ? "complete" : undefined;
    case "shovel":
      return acts.includes("stop") ? "stop" : acts.includes("close") ? "close" : undefined;
    case "hand":
    case "weed":
      return undefined;
  }
}

export function aimTool(tool: Tool, bed: Bed, session: Session | undefined, plot: PlotView, level: number, issue?: Issue): Aim {
  const unlock = bed.unlockLevel;
  if (unlock !== undefined) return { ok: false, text: level >= unlock ? "开垦好的花坛" : `Lv.${unlock} 开垦这块地` };
  const crop = plot.crop;
  const act = actForTool(tool, issue?.attention.acts ?? []);
  const unavailable = issue ? `这张工单${attentionLabel[issue.attention.state]}，先打开地块看看` : "这块地的工单还没读到";
  switch (tool) {
    case "hand":
      return { ok: true, text: session ? "看看这块地" : "播种" };
    case "water":
      return session && act ? { ok: true, text: `给${session.name}浇水（带句话）` } : { ok: false, text: session ? unavailable : "还没种东西，先用手播种" };
    case "bug":
      return session && act ? { ok: true, text: "杀虫：让它接着修" } : { ok: false, text: session ? unavailable : "这块地没有虫" };
    case "weed":
      return { ok: false, text: crop === "weeds" ? "帮工修完、验收通过草就拔了" : "没有杂草" };
    case "harvest":
      return session && act
        ? { ok: true, text: isRipe(crop) ? "收获，帮工收工" : "收获：看看它改了什么" }
        : { ok: false, text: session ? unavailable : "空地没有东西可收" };
    case "shovel":
      return session && act ? { ok: true, text: act === "stop" ? "铲除：叫停" : "铲除：请它收工" } : { ok: false, text: session ? unavailable : "空地不用铲" };
  }
}

/** What a key does on the farm: show the names, put the tool down, open the menu, pick a tool. */
export type FarmKey =
  | { readonly kind: "reveal"; readonly down: boolean }
  | { readonly kind: "closeTool" }
  | { readonly kind: "openMenu" }
  | { readonly kind: "pick"; readonly tool: Tool };

/** `typing`: the focus is in a text field. An open layer handles its own Escape. */
export function farmKey(
  e: { key: string; down: boolean; meta: boolean; control: boolean; alt: boolean },
  typing: boolean,
  layersOpen: boolean,
  held: Tool,
): FarmKey | undefined {
  if (e.key === "Alt") return { kind: "reveal", down: e.down };
  if (!e.down || e.meta || e.control || e.alt || typing) return undefined;
  if (e.key === "Escape") {
    if (layersOpen) return undefined;
    return held === "hand" ? { kind: "openMenu" } : { kind: "closeTool" };
  }
  const tool = toolForKey(e.key);
  return tool ? { kind: "pick", tool } : undefined;
}

/** Whether the focus is in a field, whose keys are not the farm's. */
export const typing = () => {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
};
