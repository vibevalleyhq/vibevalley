// What a click in the yard opens. The ids match the LDtk Prop and Area `spot` fields;
// a place opens a farm panel or a workbench page.

export type FarmPanel = "shop" | "warehouse" | "graphs" | "log" | "manager" | "taskBoard";

export const farmPanels: readonly FarmPanel[] = ["shop", "warehouse", "graphs", "log", "manager", "taskBoard"];

export interface YardPlace {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly panel?: FarmPanel;
  /** A workbench page; the web page has only some of them yet (src/main.tsx). */
  readonly route?: string;
}

export const yardPlaces: readonly YardPlace[] = [
  { id: "shop", label: "商店", hint: "种子、装饰、开垦新地", panel: "shop" },
  { id: "warehouse", label: "仓库", hint: "收进来的成果", panel: "warehouse" },
  { id: "tasks", label: "任务与成就", hint: "新手任务、开垦、成就墙", panel: "graphs" },
  { id: "log", label: "农场日志", hint: "说过的话和收成，按时间倒着排", panel: "log" },
  { id: "taskBoard", label: "种植计划", hint: "一件长活拆成几步，交给几个帮工", panel: "taskBoard" },
  { id: "agents", label: "帮工名册", hint: "每个帮工用哪台农机、带什么人设和技能、长什么样", route: "/agents" },
  { id: "manager", label: "管家", hint: "换管家的样子", panel: "manager" },
  { id: "runtimes", label: "工坊 · 农具", hint: "每台农机是一种 runtime：装没装、用量", route: "/runtimes" },
  { id: "skills", label: "书屋 · 技能书", hint: "帮工能带的技能", route: "/settings/skills" },
];

export const yardPlace = (id: string) => yardPlaces.find((p) => p.id === id);

/** The workbench pages the web page has (src/main.tsx); a place whose page is not among them opens nothing yet. */
export const webRoutes: readonly string[] = ["/issues", "/chat"];
