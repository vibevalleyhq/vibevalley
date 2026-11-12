import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";

import { Semaphore, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import {
  artifactPrefix,
  attachmentPath,
  deviceKeyCookie,
  eventsPath,
  type LanPaired,
  type LanStatus,
  livePath,
  type Preview,
  statePath,
} from "@vibevalley/protocol";
import { apiSuccessEnvelope, bizCodeMeta, endpoints, pathOf } from "@vibevalley/protocol/api";
import { subscriptionPath } from "@vibevalley/protocol/rpc";
import * as S from "@vibevalley/protocol/schema";

import { type ApiError, BizCode, type BizErrorCode, bizError } from "#/base/errors.ts";
import { code as newCode } from "#/base/ids.ts";
import { hostName, serverAddress, type ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import { sameSecret, tidyName, type User } from "#/modules/user/user.ts";
import * as lanQ from "#db/lan.sql.ts";

const pairingForMs = 2 * 60_000;
const wrongTries = 5;

/** Identifies the authenticated LAN device to the loopback server; never accepted from incoming requests. */
export const deviceHeader = "x-vibevalley-lan-device";
/** Marks every forwarded request so the loopback server distinguishes LAN traffic from local loopback callers. */
export const outsideHeader = "x-vibevalley-outside";
/** Peer address seen by the LAN listener; never accepted from incoming requests. */
export const fromHeader = "x-vibevalley-from";

const refuse = (reason: string): ApiError => bizError(BizCode.LanForbidden, reason);

type ListenerState =
  | { readonly _tag: "closed" }
  | { readonly _tag: "listening"; readonly server: Server; readonly port: number }
  | { readonly _tag: "failed"; readonly problem: string };

type PairingState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "awaitingCode"; readonly code: string; readonly expires: number; wrong: number }
  | {
      readonly _tag: "awaitingApproval";
      readonly code: string;
      readonly asking: string;
      readonly expires: number;
      answer?: (allow: boolean) => void;
    };

export interface Lan {
  readonly status: () => LanStatus;
  readonly setOpen: (open: boolean) => Promise<LanStatus>;
  readonly startPairing: () => Promise<LanStatus>;
  readonly stopPairing: () => LanStatus;
  readonly previewStopPairing: () => Preview;
  readonly answer: (allow: boolean) => Promise<LanStatus>;
  readonly pair: (code: string, name: string) => Promise<LanPaired>;
  readonly setUpstream: (address: string) => void;
  /** The listener shuts, and what it had open with it. */
  readonly close: () => Promise<void>;
}

export interface LanDeps {
  readonly config: ServerConfig;
  readonly db: Db;
  readonly user: User;
  readonly clock: Time;
  readonly log: Logger;
  readonly fetch?: typeof fetch;
}

function lanAddress(): string {
  let best = "";
  let rank = 3;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    const r = ["en", "eth", "wlan", "wl"].some((p) => name.startsWith(p)) ? 1 : 2;
    if (r >= rank) continue;
    const found = (addrs ?? []).find((a) => a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(a.address));
    if (found) {
      best = found.address;
      rank = r;
    }
  }
  return best;
}

const pairLink = (url: string, code: string) => url + "/pair?c=" + encodeURIComponent(code);

const keyOf = (req: IncomingMessage) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ") === true) return auth.slice("Bearer ".length);
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === deviceKeyCookie) return decodeURIComponent(value.join("="));
  }
  return "";
};

/** Trusts X-Forwarded-For only when the immediate peer is a local TLS proxy on loopback. */
const clientOf = (req: IncomingMessage) => {
  const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/u, "");
  const forwarded = req.headers["x-forwarded-for"];
  const first = ((typeof forwarded === "string" ? forwarded : "").split(",")[0] ?? "").trim();
  return (peer === "127.0.0.1" || peer === "::1") && first !== "" ? first : peer;
};

/** Stripped so credentials stay at the listener and callers cannot spoof internal headers. */
const dropped = new Set(["host", "connection", "cookie", "authorization", "origin", "sec-fetch-site", deviceHeader, outsideHeader, fromHeader]);

export const sameOrigin = (headers: Readonly<Record<string, string | string[] | undefined>> & { readonly host?: string | undefined }) =>
  (headers.origin === undefined || headers.origin === `http://${headers.host ?? ""}`) &&
  (headers["sec-fetch-site"] === undefined || headers["sec-fetch-site"] === "same-origin" || headers["sec-fetch-site"] === "none");

const remote = new Set([
  ...endpoints.filter((e) => e.can.includes("remote")).map((e) => "POST " + pathOf(e.op)),
  ...[statePath, eventsPath, livePath].map((path) => "GET " + path),
]);

export const remoteMay = (method: string, path: string) =>
  remote.has(method + " " + path) ||
  (method === "GET" && (path.startsWith(attachmentPath("")) || path.startsWith(artifactPrefix) || path.startsWith(subscriptionPath + "/")));

const loginPath = pathOf("user.login");
const logoutPath = pathOf("user.logout");
const passwordPath = pathOf("user.password.set");

const keyless = new Set([
  "POST " + pathOf("lan.pair"),
  "POST " + loginPath,
  "POST " + pathOf("user.get"),
  "POST " + pathOf("user.approval.create"),
  "POST " + pathOf("user.approval.collect"),
]);

/** Password changes require loopback access even for signed-in devices. */
const loginMay = (method: string, path: string) => !(method === "POST" && path === passwordPath);

export interface LanOptions {
  readonly address?: () => string;
  readonly host?: string;
}

const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** Hop-by-hop: they are the upstream connection's, not the answer's. */
const hopByHop = new Set(["connection", "keep-alive", "transfer-encoding"]);

/** A node request's body as a Web stream, read as the upstream takes it. */
const bodyOf = (req: IncomingMessage): ReadableStream<Uint8Array> => {
  const it = req[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      pull: async (c) => {
        const r = await it.next();
        if (r.done === true) return c.close();
        const chunk: unknown = r.value;
        c.enqueue(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk)));
      },
      cancel: async () => {
        await it.return?.();
      },
    },
    { highWaterMark: 0 },
  );
};

const LoginAnswer = S.jsonString(apiSuccessEnvelope(S.UserLogin));
export async function makeLan(deps: LanDeps, options: LanOptions = {}): Promise<Lan> {
  const { config, db, user: users } = deps;
  const log = deps.log.child("lan");
  const http = deps.fetch ?? fetch;
  const address = options.address ?? lanAddress;
  const now = () => deps.clock.now();
  const tasks = new TaskGroup({ name: "lan", onError: (name, e) => log.warn(`${name} failed`, e) });

  let listener: ListenerState = { _tag: "closed" };
  let pairing: PairingState = { _tag: "idle" };
  // Serialize open/shut so a concurrent shut cannot miss an in-flight port bind and leave it listening.
  const opening = new Semaphore(1);
  let upstream = config.port > 0 ? serverAddress(config) : "";
  /** What cuts each of a device's open connections; forgetting the device cuts them. */
  const conns = new Map<string, Set<() => void>>();
  const held = (device: string) => {
    const mine = conns.get(device) ?? new Set();
    conns.set(device, mine);
    return mine;
  };

  // A device revoked anywhere (here, or by user.device.delete) loses what it has open at once.
  tasks.run("revoked", async (signal) => {
    for await (const id of users.revoked(signal)) {
      for (const cut of conns.get(id) ?? []) cut();
      conns.delete(id);
    }
  });
  const dropPairing = () => {
    if (pairing._tag === "awaitingApproval") pairing.answer?.(false);
    pairing = { _tag: "idle" };
  };
  const livePairing = (): Exclude<PairingState, { readonly _tag: "idle" }> | undefined => {
    if (pairing._tag === "idle") return undefined;
    if (now() >= pairing.expires) {
      dropPairing();
      return undefined;
    }
    return pairing;
  };
  const url = () => {
    if (listener._tag !== "listening") return "";
    const host = address();
    return host ? `http://${host}:${listener.port}` : "";
  };

  const deviceOf = (req: IncomingMessage) => users.byKey(keyOf(req));

  const refuseHttp = (res: ServerResponse, bizCode: BizErrorCode, message: string) => {
    res.writeHead(bizCodeMeta[bizCode].status, { "content-type": "application/json" });
    res.end(JSON.stringify({ bizCode, message }));
  };

  const send = (req: IncomingMessage, device: string, signal: AbortSignal): Promise<Response> | undefined => {
    const method = req.method;
    if (method === undefined || !methods.has(method)) return undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !dropped.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
    headers[outsideHeader] = "1";
    headers[fromHeader] = clientOf(req);
    if (device) headers[deviceHeader] = device;
    // Node's fetch takes duplex for a streamed body.
    const init: RequestInit & { duplex?: "half" } = { method, headers, signal, redirect: "manual" };
    if (method !== "GET" && method !== "HEAD") {
      init.body = bodyOf(req);
      init.duplex = "half";
    }
    return http(`http://${upstream}${req.url ?? "/"}`, init);
  };

  /** The upstream's headers as node writes them; set-cookie stays a list. */
  const headersOf = (answer: Response): Record<string, string | string[]> => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of answer.headers) if (!hopByHop.has(k) && k !== "set-cookie") out[k] = v;
    const cookies = answer.headers.getSetCookie();
    if (cookies.length > 0) out["set-cookie"] = cookies;
    return out;
  };

  // HttpOnly hides the key from page scripts; add Secure when a front TLS proxy reports https.
  const keyCookie = (req: IncomingMessage, key: string, maxAge: number) =>
    `${deviceKeyCookie}=${encodeURIComponent(key)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict` +
    (req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "");

  const signedAnswer = async (
    req: IncomingMessage,
    res: ServerResponse,
    device: string,
    signal: AbortSignal,
    cookieOf: (status: number, body: string) => string | undefined,
  ) => {
    const sent = send(req, device, signal);
    if (sent === undefined) return refuseHttp(res, BizCode.MethodNotAllowed, t("server.lan.notRemote"));
    const answer = await sent;
    const body = await answer.text();
    const cookie = cookieOf(answer.status, body);
    const headers = headersOf(answer);
    delete headers["content-length"];
    res.writeHead(answer.status, { ...headers, ...(cookie !== undefined ? { "set-cookie": cookie } : {}) });
    res.end(body);
  };

  const signIn = (req: IncomingMessage, res: ServerResponse, device: string, signal: AbortSignal) =>
    signedAnswer(req, res, device, signal, (status, body) => {
      if (status !== 200) return undefined;
      const got = LoginAnswer.safeParse(body);
      return got.success ? keyCookie(req, got.data.data.key, 10 * 365 * 24 * 3600) : undefined;
    });
  const signOut = (req: IncomingMessage, res: ServerResponse, device: string, signal: AbortSignal) =>
    signedAnswer(req, res, device, signal, (status) => (status < 300 ? keyCookie(req, "", 0) : undefined));

  const forward = async (req: IncomingMessage, res: ServerResponse, device: string, signal: AbortSignal) => {
    const sent = send(req, device, signal);
    if (sent === undefined) return refuseHttp(res, BizCode.MethodNotAllowed, t("server.lan.notRemote"));
    const answer = await sent;
    res.writeHead(answer.status, headersOf(answer));
    res.flushHeaders();
    if (answer.body === null) return void res.end();
    const reader = answer.body.getReader();
    // Destroy the response on abort so revoked devices or disconnected clients do not leave streams open.
    const cut = () => void res.destroy();
    signal.addEventListener("abort", cut, { once: true });
    try {
      for (let r = await reader.read(); r.done !== true; r = await reader.read()) {
        if (!res.write(r.value)) await new Promise<void>((resolve) => res.once("drain", resolve).once("close", resolve));
      }
      res.end();
    } finally {
      signal.removeEventListener("abort", cut);
      reader.releaseLock();
    }
  };

  /** One request on the listener, on the service's tasks: the client leaving, or its device being forgotten, aborts it,
   * and what was under way ends there. */
  const guard = (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://lan").pathname;
    const handled = async (signal: AbortSignal) => {
      if (!upstream) return refuseHttp(res, BizCode.LanUnavailable, t("server.lan.notUp"));
      if (path.startsWith("/api/v1/") && !sameOrigin(req.headers)) return refuseHttp(res, BizCode.LanForbidden, t("server.lan.notRemote"));
      if (keyless.has(req.method + " " + path)) {
        const d = deviceOf(req)?.id ?? "";
        return path === loginPath ? signIn(req, res, d, signal) : forward(req, res, d, signal);
      }
      if (!path.startsWith("/api/v1/")) {
        if ((req.method === "GET" || req.method === "HEAD") && path !== "/mcp" && !path.startsWith("/mcp/")) return forward(req, res, "", signal);
        res.writeHead(404, { "content-type": "text/plain" });
        return void res.end("404 page not found\n");
      }
      const device = deviceOf(req);
      if (device === undefined) return refuseHttp(res, BizCode.Unauthorized, t("server.lan.unpaired"));
      const may = device.came === "login" ? loginMay : remoteMay;
      if (!may(req.method ?? "GET", path)) return refuseHttp(res, BizCode.LanForbidden, t("server.lan.notRemote"));
      const d = device.id;
      // Skip tracking in conns: signOut revokes the device, which would abort its own response before clearing the cookie.
      if (path === logoutPath) return signOut(req, res, d, signal);
      const mine = held(d);
      const local = new AbortController();
      const cut = () => local.abort();
      mine.add(cut);
      signal.addEventListener("abort", cut, { once: true });
      try {
        return await forward(req, res, d, local.signal);
      } finally {
        mine.delete(cut);
        signal.removeEventListener("abort", cut);
      }
    };
    const task = tasks.run("request", async (signal) => {
      try {
        await handled(signal);
      } catch (e) {
        if (signal.aborted || res.destroyed) res.end();
        else if (!res.headersSent) {
          log.warn(`lan: forwarding ${req.method ?? ""} ${path} failed`, e);
          refuseHttp(res, BizCode.BadGateway, t("server.lan.badGateway"));
        } else res.end();
      }
    });
    res.on("close", () => void task.abort());
  };

  // Nothing on the listener is a WebSocket: the subscriptions are event streams, and the voice lines are the farm's own.
  const upgrade = (_req: IncomingMessage, client: Duplex) => {
    client.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
  };

  const listen = () =>
    new Promise<void>((resolve) => {
      if (listener._tag === "listening") return resolve();
      const s = createServer(guard);
      s.on("upgrade", upgrade);
      s.once("error", (e) => {
        listener = { _tag: "failed", problem: t("server.lan.cannotOpen", { why: e.message }) };
        log.error(`vibevalley: lan access cannot listen on port ${config.lan.port}:`, e.message);
        resolve();
      });
      s.listen(config.lan.port, options.host, () => {
        const a = s.address();
        const boundPort = a === null || typeof a === "string" ? config.lan.port : a.port;
        listener = { _tag: "listening", server: s, port: boundPort };
        log.info(`vibevalley: lan access is open on port ${boundPort}`);
        resolve();
      });
    });

  const shut = async () => {
    dropPairing();
    const current = listener._tag === "listening" ? listener.server : undefined;
    listener = { _tag: "closed" };
    if (!current) return;
    for (const mine of conns.values()) for (const cut of mine) cut();
    const closed = new Promise<void>((resolve) => current.close(() => resolve()));
    current.closeAllConnections();
    await closed;
    log.info("vibevalley: lan access is shut");
  };

  const status = (): LanStatus => {
    const open = listener._tag !== "closed";
    const problem = listener._tag === "failed" ? listener.problem : "";
    const s: LanStatus = { open, hostName: hostName(), problem };
    const addr = url();
    if (listener._tag === "listening") {
      if (!addr) s.problem = t("server.lan.noAddress");
      else s.url = addr;
    }
    const p = livePairing();
    if (p && addr)
      s.pairing = {
        code: p.code,
        link: pairLink(addr, p.code),
        expiresAt: p.expires,
        ...(p._tag === "awaitingApproval" ? { asking: p.asking } : {}),
      };
    return s;
  };

  // The listener opens again if it was open when the farm stopped.
  if ((await lanQ.lanOpen(db.sql))?.open === true) await listen();

  const addDevice = async (name: string) => {
    const added = await users.pair(name);
    return { ...added, hostName: hostName() };
  };

  return {
    status,
    setOpen: (want) =>
      opening.with(async () => {
        await lanQ.setLanOpen(db.sql, { open: want });
        if (want) await listen();
        else await shut();
        return status();
      }),
    startPairing: async () => {
      if (listener._tag !== "listening") throw refuse(t("server.lan.notOpen"));
      if (!url()) throw refuse(t("server.lan.noAddress"));
      dropPairing();
      pairing = { _tag: "awaitingCode", code: newCode(10), expires: now() + pairingForMs, wrong: 0 };
      return status();
    },
    stopPairing: () => {
      dropPairing();
      return status();
    },
    answer: async (allow) => {
      const p = livePairing();
      if (!p || p._tag !== "awaitingApproval") throw refuse(t("server.lan.noneAsking"));
      const answer = p.answer;
      pairing = { _tag: "idle" };
      answer?.(allow);
      return status();
    },
    pair: async (code, given) => {
      const tidy = tidyName(given);
      const name = tidy === "" ? t("server.user.aDevice") : tidy;
      const p = livePairing();
      if (listener._tag === "closed") throw refuse(t("server.lan.closedThere"));
      if (!p) throw refuse(t("server.lan.codeExpired"));
      if (!sameSecret(p.code)(code.trim().toUpperCase())) {
        if (p._tag === "awaitingCode") {
          p.wrong++;
          if (p.wrong >= wrongTries) dropPairing();
        }
        throw refuse(t("server.lan.wrongCode"));
      }
      if (p._tag === "awaitingApproval") throw refuse(t("server.lan.anotherAsking"));
      const approval: Extract<PairingState, { readonly _tag: "awaitingApproval" }> = {
        _tag: "awaitingApproval",
        code: p.code,
        asking: name,
        expires: now() + pairingForMs,
      };
      pairing = approval;
      log.info(`vibevalley: lan access: "${name}" questions to pair`);
      const decided = Promise.withResolvers<boolean | "late">();
      approval.answer = (a) => decided.resolve(a);
      const cancel = deps.clock.after(pairingForMs, () => decided.resolve("late"));
      let allow: boolean | "late";
      try {
        allow = await decided.promise;
      } finally {
        cancel();
      }
      if (allow === "late") {
        if (pairing === approval) pairing = { _tag: "idle" };
        throw refuse(t("server.lan.userLate"));
      }
      if (!allow) throw refuse(t("server.lan.denied"));
      return addDevice(name);
    },
    previewStopPairing: () => {
      const p = livePairing();
      if (!p) return { does: [t("server.lan.noCode")] };
      return {
        does: [t("server.lan.dropCode", { code: p.code }), ...(p._tag === "awaitingApproval" ? [t("server.lan.dropAsking", { name: p.asking })] : [])],
      };
    },
    setUpstream: (a) => {
      upstream = a;
    },
    close: async () => {
      await opening.with(shut);
      await tasks.close();
    },
  };
}
