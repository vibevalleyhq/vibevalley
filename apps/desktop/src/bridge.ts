import { type IpcMainEvent, type IpcRendererEvent, ipcMain, ipcRenderer, type WebContents } from "electron";

import type { Link } from "@vibevalley/bridge";

const channel = "vibevalley:bridge";

export const rendererLink = (): Link => ({
  send: (m) => ipcRenderer.send(channel, m),
  receive: (fn) => {
    const heard = (_event: IpcRendererEvent, m: unknown) => fn(m);
    ipcRenderer.on(channel, heard);
    return () => void ipcRenderer.off(channel, heard);
  },
});

/** Only the page in page() is heard: what another sender says is not. */
export const mainLink = (page: () => WebContents | undefined): Link => ({
  send: (m) => page()?.send(channel, m),
  receive: (fn) => {
    const heard = (event: IpcMainEvent, m: unknown) => {
      if (event.sender === page()) fn(m);
    };
    ipcMain.on(channel, heard);
    return () => void ipcMain.off(channel, heard);
  },
});
