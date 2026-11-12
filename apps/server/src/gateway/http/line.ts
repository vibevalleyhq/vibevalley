import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { WebSocket, WebSocketServer } from "ws";

import { TaskGroup } from "@vibevalley/async";
import { mossLinePath, visionLinePath } from "@vibevalley/protocol";

import { messageOf } from "#/base/errors.ts";
import type { Voice } from "#/gateway/voice/voice.ts";
import type { Logger } from "#/infra/log.ts";

import { fromTheFarm } from "./rpc.ts";

/** A node request's headers as a Web Headers. */
const headersOf = (req: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) for (const one of [v].flat()) headers.append(k, one);
  return headers;
};

const refuse = (socket: Duplex, status: string, body = "") => {
  socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

export interface VoiceLines {
  /** The server's upgrade listener: the two voice lines, nothing else. */
  readonly upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Every line open is cut, and waited for. */
  readonly close: () => Promise<void>;
}

/** The page's realtime voice lines (WebSockets). Both protocols freeze their own provider binding before upgrading the
 * user's page; a line runs until either side ends it, or the server closes. */
export function voiceLines(deps: { readonly voice: Voice; readonly log: Logger }): VoiceLines {
  const tasks = new TaskGroup({ name: "http/voice-line", onError: (name, e) => deps.log.warn(`${name} failed`, e) });
  const prepares: Record<string, () => ReturnType<Voice["mossLine"]>> = {
    [mossLinePath]: () => deps.voice.mossLine(),
    [visionLinePath]: () => deps.voice.visionLine(),
  };
  // Loaded only when a line is first asked for.
  let server: Promise<WebSocketServer> | undefined;
  const wss = () => (server ??= import("ws").then(({ WebSocketServer }) => new WebSocketServer({ noServer: true })));

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://farm").pathname;
    const prepare = prepares[path];
    if (prepare === undefined) return refuse(socket, "404 Not Found");
    if (!fromTheFarm(headersOf(req))) return refuse(socket, "403 Forbidden", "not the farm's page");
    tasks.run("voice line", async (signal) => {
      let line;
      try {
        line = await prepare();
      } catch (e) {
        return refuse(socket, "409 Conflict", messageOf(e));
      }
      const s = await wss();
      const ws = await new Promise<WebSocket>((resolve) => s.handleUpgrade(req, socket, head, resolve));
      const cut = () => ws.terminate();
      signal.addEventListener("abort", cut, { once: true });
      try {
        await line.run(ws);
      } finally {
        signal.removeEventListener("abort", cut);
      }
    });
  };

  return {
    upgrade,
    close: async () => {
      await tasks.close();
      if (server !== undefined) (await server).close();
    },
  };
}
