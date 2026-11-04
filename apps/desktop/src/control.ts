// The desktop app's command line asks it here (`vibevalley app …`, apps/server src/cli/app.ts): a socket in the farm's
// home, so the command line finds it the way it finds the farm's server (server.json beside it). Only the owner can
// open it (0600); a connection is answered with desktopControl, one JSON message a line.

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";

import { type Handlers, serve } from "@vibevalley/bridge";
import { socketLink } from "@vibevalley/bridge/socket";
import { controlSocketOf } from "@vibevalley/home";
import { desktopControl } from "@vibevalley/protocol/host";

/** Listens until the returned function is called; a socket left by a run that did not close it is taken over. A home
 * that cannot hold one (the server will say why it cannot start there) leaves the app without it, said in the log. */
export function serveControl(home: string, handlers: Handlers<typeof desktopControl>): () => void {
  const path = controlSocketOf(home);
  try {
    mkdirSync(home, { recursive: true });
    rmSync(path, { force: true });
  } catch (e) {
    console.error("vibevalley: no socket for the command line in the farm's home; `vibevalley app` will not reach this app:", e);
    return () => undefined;
  }
  const server = createServer((socket) => {
    const served = serve(desktopControl, socketLink(socket), handlers);
    socket.on("close", () => served.close());
    socket.on("error", () => socket.destroy());
  });
  server.on("error", (e) => console.error("vibevalley: the command line's socket could not be opened; `vibevalley app` will not reach this app:", e));
  server.listen(path, () => chmodSync(path, 0o600));
  return () => {
    server.close();
    rmSync(path, { force: true });
  };
}
