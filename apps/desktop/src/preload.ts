import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

import { connect, type Link } from "@vibevalley/bridge";
import { desktopBridge, desktopVoiceShortcut, type Host, hostKey } from "@vibevalley/protocol/host";

import { titleBar } from "./boundary";

const channel = "vibevalley:bridge";

const rendererLink = (): Link => ({
  send: (m) => ipcRenderer.send(channel, m),
  receive: (fn) => {
    const heard = (_event: IpcRendererEvent, m: unknown) => fn(m);
    ipcRenderer.on(channel, heard);
    return () => void ipcRenderer.off(channel, heard);
  },
});

const main = connect(desktopBridge, rendererLink());
const told = (sent: Promise<void>) => void sent.catch((e: unknown) => console.error("vibevalley:", e));

const host: Host = {
  name: "desktop",
  opening: (update) => main.call.opening(update),
  notify: (notice) => main.call.notify(notice),
  tray: (summary) => main.call.tray(summary),
  locale: (locale) => told(main.call.locale(locale)),
  reveal: (path) => told(main.call.reveal(path)),
  theme: (theme) => told(main.call.theme(theme)),
  ...(process.platform === "darwin" ? { titleBar } : {}),
  voiceShortcut: { accelerator: desktopVoiceShortcut, on: (fn) => main.on("voiceShortcut", fn) },
  update: {
    watch: (fn) => {
      told(main.call.updateState().then(fn));
      return main.on("update", fn);
    },
    check: () => main.call.updateCheck(),
    install: () => main.call.updateInstall(),
  },
  // The app run from the repository answers that it has none; the page then shows nothing of it.
  commandLine: {
    state: () => main.call.cliState(),
    install: () => main.call.cliInstall(),
    remove: () => main.call.cliRemove(),
  },
};

contextBridge.exposeInMainWorld(hostKey, host);
