// The host interface for the page (@vibevalley/host), over IPC to the main process.

import { contextBridge, ipcRenderer } from "electron";
import { type Host, hostKey } from "@vibevalley/host";

/** The main process registers it (main.ts voiceShortcut). */
const voiceShortcut = "Alt+Shift+Space";

const host: Host = {
  name: "desktop",
  notify: (notice) => ipcRenderer.invoke("host:notify", { title: notice.title, body: notice.body }),
  tray: (summary) => ipcRenderer.invoke("host:tray", { title: summary.title, lines: [...summary.lines] }),
  rtc: null,
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
