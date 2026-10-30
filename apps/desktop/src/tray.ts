// The farm at a glance in the menu bar: the page says what (Follow.tsx); a click on a line brings the window up.

import { Menu, nativeImage, Tray } from "electron";

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
