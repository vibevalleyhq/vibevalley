// Canonical scenarios are source-owned, never inferred from a submitted receipt.
export interface Scene {
  id: string;
  entry: "site" | "stories" | "viewer";
  route: string;
  width: number;
  popup?: "select" | "menu" | "tooltip" | undefined;
  viewerState?: "rest" | "input" | "hover";
  link?: "primary" | "secondary";
  linkState?: "hover" | "active" | "focus";
  hour?: "morning" | "day" | "evening" | "night";
  reducedMotion?: "reduce" | "no-preference";
}

const scenes: Scene[] = [];
for (const [name, route] of [
  ["zh", "/"],
  ["en", "/en/"],
  ["404", "/404.html"],
])
  for (const width of [1440, 390]) {
    if (name === undefined || route === undefined) throw new Error("Incomplete site scene");
    scenes.push({ id: `site-${name}-${width}`, entry: "site", route, width });
  }
for (const [name, story] of [
  ["button-states", "组件/工作台/Button:States"],
  ["button-tones", "组件/工作台/Button:Tones"],
  ["button-icons", "组件/工作台/Button:With icon"],
  ["field-states", "组件/工作台/Field:States"],
  ["field-text", "组件/工作台/Field:Text"],
  ["field-long-text", "组件/工作台/Field:Long text"],
  ["field-popup", "组件/工作台/Field:Select"],
  ["menu-popup", "组件/工作台/MoreMenu:A place's other actions"],
  ["menu-above", "组件/工作台/MoreMenu:Opening upwards, from a toolbar"],
  ["tooltip", "组件/工作台/Tip:Hover"],
  ["segmented-states", "组件/工作台/Segmented:States"],
  ["segmented-disabled", "组件/工作台/Segmented:Playground"],
  ["tabs-states", "组件/工作台/Tabs:States"],
  ["tag-states", "组件/工作台/Tag:States"],
  ["tag-tones", "组件/工作台/Tag:Tones"],
  ["dot-tones", "组件/工作台/Tag:Dot tones"],
  ["attachment-kinds", "组件/工作台/AttachmentTile:Kinds"],
  ["checkbox-states", "组件/工作台/Checkbox:States"],
  ["chips-values", "组件/工作台/Chips:Key and value"],
  ["chips-words", "组件/工作台/Chips:Words"],
  ["icon-button-states", "组件/工作台/IconButton:States"],
  ["icon-button-kinds", "组件/工作台/IconButton:Kinds"],
  ["agent-faces", "组件/工作台/Face:Agents"],
  ["form-receipts", "组件/工作台/Form:Receipts"],
  ["icon-catalog", "设计体系/图标:All"],
  ["key-marks", "组件/工作台/KeyField:Marks"],
  ["layout-card", "组件/工作台/layout:Card"],
  ["layout-toggle", "组件/工作台/layout:Toggle states"],
  ["layout-controls", "组件/工作台/layout:Controls"],
  ["layout-list", "组件/工作台/layout:List card"],
  ["layout-rows", "组件/工作台/layout:Row states"],
  ["layout-empty", "组件/工作台/layout:Empty with a next step"],
  ["markdown-message", "组件/工作台/Markdown:Message"],
  ["data-table", "组件/工作台/DataTable:Local"],
  ["agent-cards", "组件/帮工/档案卡:States"],
  ["memory-states", "组件/记性/一条记性:States"],
  ["messages-rich", "界面/频道/消息:Rich"],
  ["messages-reports", "界面/频道/消息:Reports"],
  ["issue-board", "界面/工单/看板:Board"],
  ["issue-answer", "界面/工单/工单页:答案"],
  ["runtime-details", "界面/农机/详情:能用"],
  ["runtime-usage", "界面/农机/详情:快用完"],
  ["pixel-marks", "组件/像素/icons:Marked"],
  ["pixel-sprites", "组件/像素/icons:Sprites"],
])
  for (const theme of story?.startsWith("组件/像素/") === true ? ["light"] : ["light", "dark"])
    for (const width of [400, 800]) {
      if (name === undefined || story === undefined) throw new Error("Incomplete story scene");
      scenes.push({
        id: `${name}-${theme}-${width}`,
        entry: "stories",
        route: `/?${new URLSearchParams({ s: story, theme, w: String(width) })}`,
        width: 1680,
        popup: name === "field-popup" ? "select" : name.startsWith("menu-") ? "menu" : name === "tooltip" ? "tooltip" : undefined,
      });
    }
for (const theme of ["light", "dark"])
  for (const width of [390, 900])
    scenes.push({
      id: `layout-split-${theme}-${width}`,
      entry: "stories",
      route: `/?${new URLSearchParams({ s: "交互/列表和详情:Pick a row", theme, w: width === 390 ? "400" : "800" })}`,
      width,
    });
for (const theme of ["light", "dark"])
  for (const width of [1440, 900, 390])
    for (const viewerState of width === 390 ? (["rest"] as const) : (["rest", "input", "hover"] as const))
      scenes.push({
        id: `viewer-${theme}-${width}-${viewerState}`,
        entry: "viewer",
        route: `/?${new URLSearchParams({ s: "Viewer/Controls:Inputs", theme, w: "400" })}`,
        width,
        viewerState,
      });
for (const link of ["primary", "secondary"] as const)
  for (const linkState of ["hover", "active", "focus"] as const)
    scenes.push({ id: `site-link-${link}-${linkState}`, entry: "site", route: "/", width: 1440, link, linkState });

for (const [language, route] of [
  ["zh", "/"],
  ["en", "/en/"],
] as const)
  for (const width of [1440, 390])
    for (const reducedMotion of ["reduce", "no-preference"] as const)
      for (const hour of ["morning", "day", "evening", "night"] as const)
        scenes.push({ id: `site-hour-${language}-${width}-${reducedMotion}-${hour}`, entry: "site", route, width, hour, reducedMotion });

export const staticScenes: readonly Scene[] = scenes;
export const liveAreas = [
  "workbench-issues",
  "workbench-channel",
  "workbench-agents",
  "workbench-runtimes",
  "workbench-connectors",
  "workbench-artifacts",
  "workbench-memory",
  "workbench-orchestrator",
  "workbench-repositories",
  "workbench-settings",
  "workbench-inbox",
  "workbench-knowledge",
  "workbench-pairing",
  "farm-overlays",
  "tree-overlays",
] as const;
export const liveScenarios = liveAreas.flatMap((area) => ["light", "dark"].flatMap((theme) => [1440, 390].map((width) => `${area}-${theme}-${width}`)));
export const hostScenarios = ["desktop-host", "mobile-host"] as const;
export const behaviorScenarios = ["site-production", "site-prerender", "site-motion", "web-components", "web-integration"] as const;
