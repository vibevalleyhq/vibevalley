import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

import { NodeSink, NodeStream } from "@effect/platform-node";
import { Array as Arr, Cause, Clock, Context, Effect, FiberSet, Formatter, Layer, Option, Schema, Semaphore, Stream } from "effect";
import { HttpBody, HttpClient, HttpClientRequest, HttpMethod } from "effect/http";

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
  type UserDevice,
} from "@vibevalley/protocol";
import { type ApiError, endpoints, pathOf } from "@vibevalley/protocol/api";
import { rpcPath } from "@vibevalley/protocol/rpc";
import * as S from "@vibevalley/protocol/schema";

import { messageOf } from "#/base/errors.ts";
import { code as newCode } from "#/base/ids.ts";
import { hostName, ServerConfig } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import { callbackLog } from "#/infra/log.ts";
import { sameSecret, tidyName, User } from "#/user/user.ts";
import * as lanQ from "#db/lan.sql.ts";

/** A device's asking gets as long again for the user to answer. */
const pairingForMs = 2 * 60_000;
const wrongTries = 5;

/** The header the listener says a device by, to the loopback server; never taken from the device. */
export const deviceHeader = "x-vibevalley-lan-device";
/** Set on everything the listener hands on, keyed or not: the loopback server's sign that a request came from outside. */
export const outsideHeader = "x-vibevalley-outside";

const refuse = (reason: string): ApiError => ({ _tag: "LanRefused", reason });

/** The loopback server could not be reached, or its answer could not be streamed back to the device. */
class ForwardFailed extends Schema.TaggedError<ForwardFailed, { readonly brand: unique symbol }>()("ForwardFailed", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const forwardFailed = (cause: unknown) => ForwardFailed.make({ message: messageOf(cause), cause });

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

export class Lan extends Context.Service<
  Lan,
  {
    readonly status: () => LanStatus;
    readonly setOpen: (open: boolean) => Effect.Effect<LanStatus, ApiError>;
    readonly startPairing: () => Effect.Effect<LanStatus, ApiError>;
    readonly stopPairing: () => LanStatus;
    /** What stopPairing would do; nothing changes. */
    readonly previewStopPairing: () => Preview;
    /** The code is used up either way. */
    readonly answer: (allow: boolean) => Effect.Effect<LanStatus, ApiError>;
    readonly pair: (code: string, name: string) => Effect.Effect<LanPaired, ApiError>;
    readonly forget: (id: string) => Effect.Effect<LanStatus, ApiError>;
    /** What forget would do, refused as it would be; nothing changes. */
    readonly previewForget: (id: string) => Effect.Effect<Preview, ApiError>;
    /** The device a request through the listener came from; undefined on this machine. */
    readonly me: (device: string | undefined) => Effect.Effect<UserDevice, ApiError>;
    /** Where the loopback server listens, once it does. */
    readonly setUpstream: (address: string) => void;
  }
>()("@vibevalley/server/lan/lan") {
  static readonly layer = (options?: LanOptions) => Layer.effect(Lan, make(options));
}

/** Wi-Fi or Ethernet (en*, eth*, wlan*) before others; a private IPv4 address. */
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

/** The page's pairing route on the listener; a phone's camera opens it in the browser. */
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

/** Never handed on: the device's key stays at the listener, and only the listener says which device asks. */
const dropped = new Set(["host", "connection", "cookie", "authorization", "origin", "sec-fetch-site", deviceHeader, outsideHeader]);

export const sameOrigin = (headers: Readonly<Record<string, string | string[] | undefined>> & { readonly host?: string | undefined }) =>
  (headers.origin === undefined || headers.origin === `http://${headers.host ?? ""}`) &&
  (headers["sec-fetch-site"] === undefined || headers["sec-fetch-site"] === "same-origin" || headers["sec-fetch-site"] === "none");

/** The endpoints a device may call, the three streams and the files said in the chat; any other request is refused. */
const remote = new Set([
  ...endpoints.filter((e) => e.can.includes("remote")).map((e) => "POST " + pathOf(e.op)),
  ...[statePath, eventsPath, livePath].map((path) => "GET " + path),
]);

export const remoteMay = (method: string, path: string) =>
  remote.has(method + " " + path) || (method === "GET" && (path.startsWith(attachmentPath("")) || path.startsWith(artifactPrefix)));

const loginPath = pathOf("user.login");
const logoutPath = pathOf("user.logout");
const passwordPath = pathOf("user.password.set");

/** Let through with no key: pairing, signing in, and whether there is anything to sign in to. */
const keyless = new Set(["POST " + pathOf("lan.pair"), "POST " + loginPath, "POST " + pathOf("user.get")]);

/** A signed-in device is the user everywhere but the password, which is set only at the machine. */
const loginMay = (method: string, path: string) => !(method === "POST" && path === passwordPath);

export interface LanOptions {
  readonly address?: () => string;
  /** The host the listener binds; every interface when absent. */
  readonly host?: string;
}

const make = (options: LanOptions = {}) =>
  Effect.gen(function* () {
    const logs = yield* callbackLog;
    // What a request sets off (its forwarding, a write) belongs to this service: it ends with it and keeps its services.
    const forkHere = yield* FiberSet.makeRuntime();
    const config = yield* ServerConfig;
    const db = yield* Db;
    const users = yield* User;
    const http = yield* HttpClient.HttpClient;
    const address = options.address ?? lanAddress;
    // Read in callbacks too: the Clock the service was built with.
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();

    const lanOpen2 = yield* db.run(Effect.catchNoSuchElement(lanQ.lanOpen()));
    // No row yet is shut.
    const initialOpen = Option.match(lanOpen2, {
      onNone: () => false,
      onSome: (r) => r.open,
    });
    let listener: ListenerState = { _tag: "closed" };
    let pairing: PairingState = { _tag: "idle" };
    // Opening binds the port after its write: a shut that came in between would find no server yet and leave the one bound after it listening.
    const opening = yield* Semaphore.make(1);
    let upstream = "";
    /** What cuts each of a device's open connections; forgetting the device cuts them. */
    const conns = new Map<string, Set<() => void>>();
    const held = (device: string) => {
      const mine = conns.get(device) ?? new Set();
      conns.set(device, mine);
      return mine;
    };

    // A device revoked anywhere (here, or by user.device.delete) loses what it has open at once.
    yield* Effect.forkScoped(
      Stream.runForEach(users.revoked, (id) =>
        Effect.sync(() => {
          for (const cut of conns.get(id) ?? []) cut();
          conns.delete(id);
        }),
      ),
    );
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

    const refuseHttp = (res: ServerResponse, status: number, reason: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(Formatter.formatJson({ _tag: "LanRefused", reason }));
    };

    /** The request handed to the loopback server as it came, the device said; undefined for a method it cannot carry. */
    const send = (req: IncomingMessage, device: string) => {
      const method = req.method;
      if (!HttpMethod.isHttpMethod(method)) return undefined;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !dropped.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      headers[outsideHeader] = "1";
      if (device) headers[deviceHeader] = device;
      const body =
        method === "GET" || method === "HEAD"
          ? HttpBody.empty
          : HttpBody.stream(NodeStream.fromReadable({ evaluate: () => req, onError: forwardFailed }), req.headers["content-type"]);
      return http.execute(HttpClientRequest.make(method)(`http://${upstream}${req.url ?? "/"}`, { headers, body })).pipe(Effect.mapError(forwardFailed));
    };

    // HttpOnly, so a script on the page never reads it; Secure when a TLS proxy in front says the device came over https.
    const keyCookie = (req: IncomingMessage, key: string, maxAge: number) =>
      `${deviceKeyCookie}=${encodeURIComponent(key)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict` +
      (req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "");

    /** Signing in or out, answered whole: the key a sign-in gets goes into the cookie as well, and signing out clears it. */
    const signedAnswer = (req: IncomingMessage, res: ServerResponse, device: string, cookieOf: (status: number, body: string) => string | undefined) =>
      Effect.gen(function* () {
        const sent = send(req, device);
        if (sent === undefined) return refuseHttp(res, 405, t("server.lan.notRemote"));
        const answer = yield* sent;
        const body = yield* answer.text.pipe(Effect.mapError(forwardFailed));
        const cookie = cookieOf(answer.status, body);
        res.writeHead(answer.status, { ...answer.headers, ...(cookie !== undefined ? { "set-cookie": cookie } : {}) });
        res.end(body);
      });

    const decodeLogin = Schema.decodeOption(Schema.fromJsonString(S.UserLogin));
    const signIn = (req: IncomingMessage, res: ServerResponse, device: string) =>
      signedAnswer(req, res, device, (status, body) =>
        status === 200 ? Option.getOrUndefined(Option.map(decodeLogin(body), (got) => keyCookie(req, got.key, 10 * 365 * 24 * 3600))) : undefined,
      );
    const signOut = (req: IncomingMessage, res: ServerResponse, device: string) =>
      signedAnswer(req, res, device, (status) => (status < 300 ? keyCookie(req, "", 0) : undefined));

    /** Handed to the loopback server as it came, the device said; the answer streams back. */
    const forward = (req: IncomingMessage, res: ServerResponse, device: string) =>
      Effect.gen(function* () {
        const sent = send(req, device);
        if (sent === undefined) return refuseHttp(res, 405, t("server.lan.notRemote"));
        const answer = yield* sent;
        res.writeHead(answer.status, answer.headers);
        yield* Stream.run(answer.stream, NodeSink.fromWritable({ evaluate: () => res, onError: forwardFailed })).pipe(
          // A HEAD, a 204 or a 304 has no body to stream.
          Effect.catchTag("HttpClientError", (e) => (e.reason._tag === "EmptyBodyError" ? Effect.sync(() => void res.end()) : Effect.fail(forwardFailed(e)))),
          // Cut off (the device forgotten, the client gone): the answer under way ends with it, or a stream would stay open.
          Effect.onInterrupt(() => Effect.sync(() => void res.destroy())),
        );
      });

    /** One request on the listener, on the service's fibers: the client leaving, or its device being forgotten, interrupts
     * it, and what was under way ends there. */
    const guard = (req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? "/", "http://lan").pathname;
      const handled = Effect.gen(function* () {
        if (!upstream) return refuseHttp(res, 503, t("server.lan.notUp"));
        if (path.startsWith("/api/v1/") && !sameOrigin(req.headers)) return refuseHttp(res, 403, t("server.lan.notRemote"));
        if (keyless.has(req.method + " " + path)) {
          const d = deviceOf(req)?.id ?? "";
          return yield* path === loginPath ? signIn(req, res, d) : forward(req, res, d);
        }
        if (!path.startsWith("/api/v1/")) {
          if ((req.method === "GET" || req.method === "HEAD") && path !== "/mcp" && !path.startsWith("/mcp/")) return yield* forward(req, res, "");
          res.writeHead(404, { "content-type": "text/plain" });
          return void res.end("404 page not found\n");
        }
        const device = deviceOf(req);
        if (device === undefined) return refuseHttp(res, 401, t("server.lan.unpaired"));
        const may = device.came === "login" ? loginMay : remoteMay;
        if (!may(req.method ?? "GET", path)) return refuseHttp(res, 403, t("server.lan.notRemote"));
        const d = device.id;
        // Not held with the device's connections: signing out revokes the device, and that cuts what is held.
        if (path === logoutPath) return yield* signOut(req, res, d);
        const mine = held(d);
        return yield* Effect.withFiber((fiber) => {
          const cut = () => fiber.interruptUnsafe();
          mine.add(cut);
          return Effect.ensuring(
            forward(req, res, d),
            Effect.sync(() => mine.delete(cut)),
          );
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (Cause.hasInterruptsOnly(cause)) res.end();
            else if (!res.headersSent) refuseHttp(res, 502, t("server.lan.badGateway"));
            else res.end();
          }),
        ),
      );
      const fiber = forkHere(handled);
      res.on("close", () => fiber.interruptUnsafe());
    };

    /** The page's WebSocket from a paired device. forgetting the device or shutting ends it. */
    const tunnel = (req: IncomingMessage, client: Socket, head: Buffer) => {
      const refuse = (status: string) => void client.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
      if (!upstream) return refuse("503 Service Unavailable");
      if (new URL(req.url ?? "/", "http://lan").pathname !== rpcPath) return refuse("404 Not Found");
      const d = deviceOf(req)?.id;
      if (!d) return refuse("401 Unauthorized");
      // Forwarding removes the browser origin: only this listener can check it.
      if (!sameOrigin(req.headers)) return refuse("403 Forbidden");
      const [host, port] = [upstream.slice(0, upstream.lastIndexOf(":")), Number(upstream.slice(upstream.lastIndexOf(":") + 1))];
      const lines = [`GET ${req.url ?? rpcPath} HTTP/1.1`, `host: ${upstream}`, "connection: Upgrade", `${outsideHeader}: 1`, `${deviceHeader}: ${d}`];
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !dropped.has(k)) for (const one of [v].flat()) lines.push(`${k}: ${one}`);
      const mine = held(d);
      const up = connect(port, host, () => {
        up.write(lines.join("\r\n") + "\r\n\r\n");
        if (head.length > 0) up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      const end = () => {
        mine.delete(end);
        client.destroy();
        up.destroy();
      };
      mine.add(end);
      for (const side of [client, up]) {
        side.on("error", end);
        side.on("close", end);
      }
    };

    // A port taken is said in the status; the farm runs on.
    const listen = Effect.callback<void>((resume) => {
      if (listener._tag === "listening") return resume(Effect.void);
      const s = createServer(guard);
      s.on("upgrade", tunnel);
      s.once("error", (e) => {
        listener = { _tag: "failed", problem: t("server.lan.cannotOpen", { why: e.message }) };
        logs.error(`vibevalley: lan access cannot listen on port ${config.lan.port}:`, e.message);
        resume(Effect.void);
      });
      s.listen(config.lan.port, options.host, () => {
        const a = s.address();
        const boundPort = a === null || typeof a === "string" ? config.lan.port : a.port;
        listener = { _tag: "listening", server: s, port: boundPort };
        logs.info(`vibevalley: lan access is open on port ${boundPort}`);
        resume(Effect.void);
      });
    });

    const shut = Effect.suspend(() => {
      dropPairing();
      const current = listener._tag === "listening" ? listener.server : undefined;
      listener = { _tag: "closed" };
      if (!current) return Effect.void;
      // An upgraded socket is no longer the server's to close.
      for (const mine of conns.values()) for (const cut of mine) cut();
      current.closeAllConnections();
      return Effect.callback<void>((resume) => void current.close(() => resume(Effect.void))).pipe(
        Effect.andThen(Effect.sync(() => logs.info("vibevalley: lan access is shut"))),
      );
    });

    const status = (): LanStatus => {
      const open = listener._tag !== "closed";
      const problem = listener._tag === "failed" ? listener.problem : "";
      const s: LanStatus = { open, hostName: hostName(), devices: [], problem };
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
      s.devices = Arr.filter(users.devices(), (d) => d.came === "paired");
      return s;
    };

    if (initialOpen) yield* listen;
    yield* Effect.addFinalizer(() => shut);

    const addDevice = Effect.fn("Lan.addDevice")(function* (name: string) {
      const added = yield* users.pair(name);
      return { ...added, hostName: hostName() };
    });

    return Lan.of({
      status,
      setOpen: Effect.fn("Lan.setOpen")(function* (want) {
        yield* db.run(lanQ.setLanOpen({ open: want }));
        if (want) yield* listen;
        else yield* shut;
        return status();
      }, opening.withPermits(1)),
      startPairing: Effect.fn("Lan.startPairing")(function* () {
        if (listener._tag !== "listening") return yield* Effect.fail(refuse(t("server.lan.notOpen")));
        if (!url()) return yield* Effect.fail(refuse(t("server.lan.noAddress")));
        dropPairing();
        pairing = { _tag: "awaitingCode", code: newCode(10), expires: now() + pairingForMs, wrong: 0 };
        return status();
      }),
      stopPairing: () => {
        dropPairing();
        return status();
      },
      answer: Effect.fn("Lan.answer")(function* (allow) {
        const p = livePairing();
        if (!p || p._tag !== "awaitingApproval") return yield* Effect.fail(refuse(t("server.lan.noneAsking")));
        const answer = p.answer;
        pairing = { _tag: "idle" };
        answer?.(allow);
        return status();
      }),
      pair: Effect.fn("Lan.pair")(function* (code, given) {
        const tidy = tidyName(given);
        const name = tidy === "" ? t("server.user.aDevice") : tidy;
        const p = livePairing();
        if (listener._tag === "closed") return yield* Effect.fail(refuse(t("server.lan.closedThere")));
        if (!p) return yield* Effect.fail(refuse(t("server.lan.codeExpired")));
        if (!sameSecret(p.code)(code.trim().toUpperCase())) {
          if (p._tag === "awaitingCode") {
            p.wrong++;
            if (p.wrong >= wrongTries) dropPairing();
          }
          return yield* Effect.fail(refuse(t("server.lan.wrongCode")));
        }
        if (p._tag === "awaitingApproval") return yield* Effect.fail(refuse(t("server.lan.anotherAsking")));
        const approval: Extract<PairingState, { readonly _tag: "awaitingApproval" }> = {
          _tag: "awaitingApproval",
          code: p.code,
          asking: name,
          expires: now() + pairingForMs,
        };
        pairing = approval;
        logs.info(`vibevalley: lan access: "${name}" questions to pair`);
        const allow = yield* Effect.callback<boolean>((resume) => {
          approval.answer = (a) => resume(Effect.succeed(a));
          // Cut short (the time ran out, or the request went away): unless the user has answered or a new pairing
          // replaced it.
          return Effect.sync(() => {
            if (pairing === approval) pairing = { _tag: "idle" };
          });
        }).pipe(Effect.timeoutOption(pairingForMs), Effect.map(Option.getOrElse(() => "late" as const)));
        if (allow === "late") {
          if (pairing === approval) pairing = { _tag: "idle" };
          return yield* Effect.fail(refuse(t("server.lan.userLate")));
        }
        if (!allow) return yield* Effect.fail(refuse(t("server.lan.denied")));
        return yield* addDevice(name);
      }),
      previewStopPairing: () => {
        const p = livePairing();
        if (!p) return { does: [t("server.lan.noCode")] };
        return {
          does: [t("server.lan.dropCode", { code: p.code }), ...(p._tag === "awaitingApproval" ? [t("server.lan.dropAsking", { name: p.asking })] : [])],
        };
      },
      forget: Effect.fn("Lan.forget")(function* (id) {
        yield* users.revoke(id);
        return status();
      }),
      previewForget: Effect.fn("Lan.previewForget")(function* (id) {
        const preview = yield* users.previewRevoke(id);
        const open = conns.get(id)?.size ?? 0;
        return { does: [...preview.does, ...(open > 0 ? [t("server.lan.cut", { n: open })] : [])] };
      }),
      me: Effect.fn("Lan.me")(function* (device) {
        const d = device ? users.device(device) : undefined;
        if (!d) return yield* Effect.fail(refuse(t("server.lan.local")));
        return d;
      }),
      setUpstream: (a) => {
        upstream = a;
      },
    });
  });
