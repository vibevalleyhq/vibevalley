import { Menu, app, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";

import { t } from "@vibevalley/i18n";
import type { TraySummary } from "@vibevalley/protocol/host";

export function menuBar(icon: string, show: () => void) {
  let tray: Tray | undefined;
  return (summary: TraySummary) => {
    tray ??= new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }));
    tray.setToolTip("VibeValley");
    if (process.platform === "darwin") tray.setTitle(summary.title);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...summary.lines.map((label) => ({ label, click: show })),
        { type: "separator" },
        { label: t("desktop.open"), click: show },
        { label: t("desktop.quit"), role: "quit" },
      ]),
    );
  };
}

export function setAppMenu() {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about", label: t("desktop.menu.about", { app: app.name }) },
              { type: "separator" },
              { role: "hide", label: t("desktop.menu.hide", { app: app.name }) },
              { role: "hideOthers", label: t("desktop.menu.hideOthers") },
              { role: "unhide", label: t("desktop.menu.unhide") },
              { type: "separator" },
              { role: "quit", label: t("desktop.menu.quit", { app: app.name }) },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: t("desktop.menu.edit"),
      submenu: [
        { role: "undo", label: t("desktop.menu.undo") },
        { role: "redo", label: t("desktop.menu.redo") },
        { type: "separator" },
        { role: "cut", label: t("desktop.menu.cut") },
        { role: "copy", label: t("desktop.menu.copy") },
        { role: "paste", label: t("desktop.menu.paste") },
        { role: "selectAll", label: t("desktop.menu.selectAll") },
      ],
    },
    {
      label: t("desktop.menu.view"),
      submenu: [
        { role: "reload", label: t("desktop.menu.reload") },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools", label: t("desktop.menu.devTools") } satisfies MenuItemConstructorOptions]),
        { type: "separator" },
        { role: "resetZoom", label: t("desktop.menu.resetZoom") },
        { role: "zoomIn", label: t("desktop.menu.zoomIn") },
        { role: "zoomOut", label: t("desktop.menu.zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: t("desktop.menu.fullScreen") },
      ],
    },
    {
      label: t("desktop.menu.window"),
      role: "window",
      submenu: [
        { role: "minimize", label: t("desktop.menu.minimize") },
        { role: "zoom", label: t("desktop.menu.zoom") },
        ...(mac
          ? ([{ type: "separator" }, { role: "front", label: t("desktop.menu.front") }] satisfies MenuItemConstructorOptions[])
          : [{ role: "close", label: t("desktop.menu.close") } satisfies MenuItemConstructorOptions]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
