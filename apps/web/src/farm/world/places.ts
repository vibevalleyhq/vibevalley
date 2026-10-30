// What a click in the yard opens. The ids match the LDtk Prop and Area `spot` fields;
// a place opens a farm panel, a workbench page, or the chat (the phone unfolded to 田头).

import { t } from "@vibevalley/i18n";

export type FarmPanel = "shop" | "warehouse" | "graphs" | "log" | "orchestrator" | "taskBoard";

export const farmPanels: readonly FarmPanel[] = ["shop", "warehouse", "graphs", "log", "orchestrator", "taskBoard"];

export interface YardPlace {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly panel?: FarmPanel;
  /** A workbench page; the web page has only some of them yet (src/main.tsx). */
  readonly route?: string;
  readonly chat?: boolean;
}

export const yardPlaces: readonly YardPlace[] = [
  { id: "shop", label: t("web.farm.panel.shop"), hint: t("web.farm.yard.shop.hint"), panel: "shop" },
  { id: "warehouse", label: t("web.farm.panel.warehouse"), hint: t("web.farm.yard.warehouse.hint"), panel: "warehouse" },
  { id: "tasks", label: t("web.farm.panel.graphs"), hint: t("web.farm.yard.tasks.hint"), panel: "graphs" },
  { id: "log", label: t("web.farm.panel.log"), hint: t("web.farm.yard.log.hint"), panel: "log" },
  { id: "taskBoard", label: t("web.farm.yard.taskBoard.label"), hint: t("web.farm.yard.taskBoard.hint"), panel: "taskBoard" },
  { id: "agents", label: t("web.farm.menu.agents"), hint: t("web.farm.yard.agents.hint"), route: "/agents" },
  // Changing its look is the HUD's face (换管家的样子); the orchestrator in the yard is someone to talk to.
  { id: "manager", label: t("web.farm.orchestrator"), hint: t("web.farm.yard.manager.hint"), chat: true },
  { id: "runtimes", label: t("web.farm.yard.runtimes.label"), hint: t("web.farm.yard.runtimes.hint"), route: "/runtimes" },
  { id: "skills", label: t("web.farm.yard.skills.label"), hint: t("web.farm.yard.skills.hint"), route: "/settings/skills" },
];

export const yardPlace = (id: string) => yardPlaces.find((p) => p.id === id);

/** The workbench pages the web page has (src/main.tsx); a place whose page is not among them opens nothing yet. */
export const webRoutes: readonly string[] = ["/issues", "/chat"];
