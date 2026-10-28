import { t } from "@vibevalley/i18n";
// The tools the owner holds over the plots, and what a click with one means. aimTool is the
// rule: the screen shows it while pointing and follows it on a click.

import { farmWording } from "./words";
import { wording } from "@vibevalley/protocol/words";
import type { Issue, IssueAct, PlotView, Session } from "@vibevalley/protocol";
import { type Bed, isRipe } from "./world/plots";

export type Tool = "hand" | "water" | "bug" | "weed" | "harvest" | "shovel";

export const tools: readonly { readonly id: Tool; readonly label: string; readonly hint: string; readonly icon: string }[] = [
  { id: "hand", label: t("web.farm.tool.hand.label"), hint: t("web.farm.tool.hand.hint"), icon: "icon-hand" },
  { id: "water", label: t("web.farm.water.water"), hint: t("web.farm.tool.water.hint"), icon: "icon-water" },
  { id: "bug", label: t("web.farm.tool.bug.label"), hint: t("web.farm.tool.bug.hint"), icon: "icon-bug" },
  { id: "weed", label: t("web.farm.tool.weed.label"), hint: t("web.farm.tool.weed.hint"), icon: "icon-weed" },
  { id: "harvest", label: t("web.farm.tool.harvest.label"), hint: t("web.farm.tool.harvest.hint"), icon: "icon-harvest" },
  { id: "shovel", label: t("web.farm.tool.shovel.label"), hint: t("web.farm.tool.shovel.hint"), icon: "icon-shovel" },
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
  if (unlock !== undefined) return { ok: false, text: level >= unlock ? t("web.farm.aim.flowerbed") : t("web.farm.aim.clearAt", { level: unlock }) };
  const crop = plot.crop;
  const act = actForTool(
    tool,
    (issue?.attention.acts ?? []).map((a) => a.act),
  );
  const unavailable = issue ? farmWording().aim.unavailable(wording().attention[issue.attention.state]) : t("web.farm.aim.unread");
  switch (tool) {
    case "hand":
      return { ok: true, text: session ? t("web.farm.aim.look") : t("web.farm.aim.sow") };
    case "water":
      return session && act
        ? { ok: true, text: t("web.farm.aim.water", { name: session.name }) }
        : { ok: false, text: session ? unavailable : t("web.farm.aim.nothingYet") };
    case "bug":
      return session && act ? { ok: true, text: t("web.farm.aim.bug") } : { ok: false, text: session ? unavailable : t("web.farm.aim.noBugs") };
    case "weed":
      return { ok: false, text: crop === "weeds" ? t("web.farm.aim.weeds") : t("web.farm.aim.noWeeds") };
    case "harvest":
      return session && act
        ? { ok: true, text: isRipe(crop) ? t("web.farm.aim.harvestRipe") : t("web.farm.aim.harvestLook") }
        : { ok: false, text: session ? unavailable : t("web.farm.aim.nothingToHarvest") };
    case "shovel":
      return session && act
        ? { ok: true, text: act === "stop" ? t("web.farm.aim.shovelStop") : t("web.farm.aim.shovelDismiss") }
        : { ok: false, text: session ? unavailable : t("web.farm.aim.noShovel") };
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
