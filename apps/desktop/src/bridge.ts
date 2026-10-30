// The desktop's bridge (@vibevalley/protocol/host's desktopBridge) goes over one channel both ways: the preload's calls,
// and main's answers and pushes to the window's page.

import { type IpcMainEvent, type IpcRendererEvent, ipcMain, ipcRenderer, type WebContents } from "electron";

import type { Link } from "@vibevalley/bridge";

const channel = "vibevalley:bridge";

/** The preload's end. */
export const rendererLink = (): Link => ({
  send: (m) => ipcRenderer.send(channel, m),
  receive: (fn) => {
    const heard = (_event: IpcRendererEvent, m: unknown) => fn(m);
    ipcRenderer.on(channel, heard);
    return () => void ipcRenderer.off(channel, heard);
  },
});

/** Main's end, to the page in page(): what another sender says is not heard. */
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
