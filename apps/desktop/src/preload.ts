// The host interface for the page (@vibevalley/protocol/host), over the desktop's bridge to the main process.

import { contextBridge } from "electron";

import { connect } from "@vibevalley/bridge";
import { desktopBridge, desktopVoiceShortcut, type Host, hostKey } from "@vibevalley/protocol/host";

import { rendererLink } from "./bridge";
import { titleBar } from "./chrome";

const main = connect(desktopBridge, rendererLink());
const told = (sent: Promise<void>) => void sent.catch((e: unknown) => console.error("vibevalley:", e));

const host: Host = {
  name: "desktop",
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
};

contextBridge.exposeInMainWorld(hostKey, host);
