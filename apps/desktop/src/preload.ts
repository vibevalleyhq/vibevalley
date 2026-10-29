// The host interface for the page (@vibevalley/protocol/host), over IPC to the main process.

import { contextBridge, ipcRenderer } from "electron";
import { type Host, hostKey } from "@vibevalley/protocol/host";

/** The main process registers it (main.ts voiceShortcut). */
const voiceShortcut = "Alt+Shift+Space";

const host: Host = {
  name: "desktop",
  notify: (notice) => ipcRenderer.invoke("host:notify", { title: notice.title, body: notice.body }),
  tray: (summary) => ipcRenderer.invoke("host:tray", { title: summary.title, lines: [...summary.lines] }),
  locale: (locale) => void ipcRenderer.invoke("host:locale", locale),
  reveal: (path) => void ipcRenderer.invoke("host:reveal", path),
  theme: (theme) => void ipcRenderer.invoke("host:theme", theme),
  // On macOS the window's title bar is hidden and its traffic lights sit over the page (main.ts trafficLights).
  ...(process.platform === "darwin" ? { titleBar: { top: 28, left: 76 } } : {}),
  voiceShortcut: {
    accelerator: voiceShortcut,
    on: (fn) => {
      const listener = () => fn();
      ipcRenderer.on("host:voice-shortcut", listener);
      return () => void ipcRenderer.off("host:voice-shortcut", listener);
    },
  },
};

contextBridge.exposeInMainWorld(hostKey, host);
