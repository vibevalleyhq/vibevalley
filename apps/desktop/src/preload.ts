// The host interface for the page (@vibevalley/protocol/host), over the desktop's bridge to the main process.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { connect, type Link } from "@vibevalley/bridge";
import { desktopBridge, desktopVoiceShortcut, type Host, hostKey } from "@vibevalley/protocol/host";

import { bridgeChannel } from "./bridge";

const link: Link = {
  send: (m) => ipcRenderer.send(bridgeChannel, m),
  receive: (fn) => {
    const heard = (_event: IpcRendererEvent, m: unknown) => fn(m);
    ipcRenderer.on(bridgeChannel, heard);
    return () => void ipcRenderer.off(bridgeChannel, heard);
  },
};
const main = connect(desktopBridge, link);
const told = (sent: Promise<void>) => void sent.catch((e: unknown) => console.error("vibevalley:", e));

const host: Host = {
  name: "desktop",
  notify: (notice) => main.call.notify(notice),
  tray: (summary) => main.call.tray(summary),
  locale: (locale) => told(main.call.locale(locale)),
  reveal: (path) => told(main.call.reveal(path)),
  theme: (theme) => told(main.call.theme(theme)),
  // On macOS the window's title bar is hidden and its traffic lights sit over the page (main.ts trafficLights).
  ...(process.platform === "darwin" ? { titleBar: { top: 28, left: 76 } } : {}),
  voiceShortcut: { accelerator: desktopVoiceShortcut, on: (fn) => main.on("voiceShortcut", fn) },
};

contextBridge.exposeInMainWorld(hostKey, host);
