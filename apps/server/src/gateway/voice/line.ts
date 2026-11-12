import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { getRequestListener } from "@hono/node-server";

import { type Clock, Semaphore, withTimeout } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";

import { errnoOf, messageOf } from "#/base/errors.ts";
import type { Logger } from "#/infra/log.ts";
import { afterRealTime, type Time } from "#/infra/time.ts";
import { type Answer, chatCompletions } from "#/modules/orchestrator/openai.ts";

import { type CallLine } from "./agora.ts";

/** A new quick tunnel's address takes a while to answer (seen: about 25 s). */
const lineReadyMs = 60_000;
/** So calling again does not wait for a new tunnel. */
const lineLingerMs = 10 * 60_000;

const quickTunnel = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u;

/** A tunnel's public address and how to close it. */
export interface Tunnel {
  readonly url: string;
  readonly close: () => void;
}

/** Why the voice line cannot be had now; the message is the user's. */
export class LineFailed extends Error {
  override readonly name = "LineFailed";
}

/** A quick tunnel to port; given up on (signal) before it said its address, the process goes too. */
const cloudflared = (port: number, signal?: AbortSignal) =>
  new Promise<Tunnel>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new LineFailed(messageOf(e), { cause: e }));
      return;
    }
    const close = () => child.kill();
    let settled = false;
    const settle = (then: () => void) => {
      if (settled) return;
      settled = true;
      cancel();
      signal?.removeEventListener("abort", onAbort);
      then();
    };
    const failWith = (message: string) => settle(() => reject(new LineFailed(message)));
    // A real process: its deadline is real time.
    const cancel = afterRealTime(30_000, () => {
      close();
      failWith(t("server.voice.tunnel.timedOut"));
    });
    const onAbort = () =>
      settle(() => {
        close();
        reject(signal?.reason);
      });
    signal?.addEventListener("abort", onAbort, { once: true });
    // cloudflared says its address on either stream; both are read until it exits, so it never blocks on a write.
    const read = (b: Buffer) => {
      const url = quickTunnel.exec(b.toString())?.[0];
      if (url) settle(() => resolve({ url, close }));
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (e) => failWith(errnoOf(e) === "ENOENT" ? t("server.voice.tunnel.missing") : e.message));
    child.on("exit", () => failWith(t("server.voice.tunnel.exited")));
  });

/** The line refusing a keyless request counts as an answer. Asked over the real network every 2 s, for a minute at most. */
export async function tunnelAnswers(fetcher: typeof fetch, url: string, clock: Clock, signal?: AbortSignal): Promise<boolean> {
  const deadline = clock.now() + lineReadyMs;
  const every = 2_000;
  for (;;) {
    const answered = await withTimeout((s) => fetcher(url + "/llm/ready/chat/completions", { method: "POST", signal: s }), 5_000, {
      clock,
      ...(signal ? { signal } : {}),
    }).then(
      (res) => res.status === 401,
      () => false,
    );
    if (answered) return true;
    if (clock.now() + every >= deadline) return false;
    await clock.sleep(every, signal);
  }
}

interface VoiceLineEnv {
  readonly port: number;
  readonly url: string;
  readonly tunnel?: ((port: number) => Promise<Tunnel>) | undefined;
  readonly fetch: typeof fetch;
  readonly clock: Time;
  readonly log: Logger;
  readonly answerer: (model: string) => Answer | undefined;
  readonly isStopped: () => boolean;
}

export async function makeVoiceLine(env: VoiceLineEnv) {
  const { clock, log, isStopped } = env;
  // The voice line: local only, like the farm; the tunnel is the one way in from outside.
  const keys = new Map<string, string>();
  let line = false;
  let linePort = env.port;
  let lineProblem = "";
  let tunnel: Tunnel | undefined;
  /** What cancels closing the tunnel, lineLingerMs after the last call. */
  let closing: (() => void) | undefined;
  const answer = chatCompletions({ answerer: env.answerer, misheard: t("server.voice.misheard") }, { clock, log });
  const route = /^\/llm\/([\w-]+)\/chat\/completions$/u;
  // A call's own key on its own path; anything else is not there or not let in.
  const lineHandler = async (request: Request): Promise<Response> => {
    try {
      const m = route.exec(new URL(request.url).pathname);
      if (request.method !== "POST" || !m?.[1]) return new Response(null, { status: 404 });
      const key = keys.get(m[1]);
      if (!key || request.headers.get("authorization") !== "Bearer " + key) return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
      return await answer(request);
    } catch (e) {
      log.warn("vibevalley: the voice line could not answer", e);
      return new Response(null, { status: 502 });
    }
  };
  const listener = getRequestListener(lineHandler);
  // The listener answers every request itself, a failure as a 502 (lineHandler): nothing is left to wait for here.
  const server = createServer((req, res) => void listener(req, res));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(linePort, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const bound = server.address();
    if (bound !== null && typeof bound !== "string") linePort = bound.port;
    line = true;
  } catch (e) {
    lineProblem = t("server.voice.lineDown", { why: messageOf(e) });
    log.error(`vibevalley: the voice line cannot listen on 127.0.0.1:${linePort}: ${messageOf(e)}`);
  }

  const openTunnel =
    env.tunnel ??
    (async (port: number) => {
      const item = await cloudflared(port);
      if (!(await tunnelAnswers(env.fetch, item.url, clock))) log.info(`vibevalley: the voice line's tunnel ${item.url} does not answer yet; the call goes on`);
      return item;
    });
  // Opening a tunnel waits for it to answer, through this very line: one opening at a time.
  const opening = new Semaphore(1);
  const lineClosed = () => new LineFailed(t("server.voice.lineClosed"));
  const base = async () => {
    if (env.url) return env.url.replace(/\/+$/u, "");
    closing?.();
    closing = undefined;
    return opening.with(async () => {
      if (tunnel) return tunnel.url;
      const item = await openTunnel(linePort);
      if (isStopped()) {
        item.close();
        throw lineClosed();
      }
      tunnel = item;
      return item.url;
    });
  };
  /** A call's own line; throws LineFailed when there is none to be had. */
  const open = async (): Promise<CallLine> => {
    if (isStopped()) throw lineClosed();
    if (lineProblem) throw new LineFailed(lineProblem);
    if (!line) throw new LineFailed(t("server.voice.lineNotOpen"));
    const url = await base();
    if (isStopped()) throw lineClosed();
    const id = randomBytes(8).toString("hex");
    const key = randomBytes(24).toString("base64url");
    keys.set(id, key);
    return { id, key, url: url + "/llm/" + id + "/chat/completions" };
  };
  const close = (id: string) => {
    keys.delete(id);
    if (keys.size > 0 || !tunnel) return;
    closing?.();
    closing = clock.after(lineLingerMs, () => {
      closing = undefined;
      if (keys.size > 0 || !tunnel) return;
      tunnel.close();
      tunnel = undefined;
    });
  };

  return {
    open,
    close,
    lines: () => keys.size,
    /** The line and its tunnel go; an answer still streaming is cut first, as the server's close waits for every socket. */
    stop: async () => {
      keys.clear();
      closing?.();
      closing = undefined;
      tunnel?.close();
      tunnel = undefined;
      if (!line) return;
      line = false;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
