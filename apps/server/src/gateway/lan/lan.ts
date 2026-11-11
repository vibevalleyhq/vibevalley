import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

import { NodeSink, NodeStream } from "@effect/platform-node";
import { Cause, Clock, Context, Effect, FiberSet, Formatter, Layer, Option, Schema, Semaphore, Stream, String as Str } from "effect";
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
} from "@vibevalley/protocol";
import { apiSuccessEnvelope, bizCodeMeta, endpoints, pathOf } from "@vibevalley/protocol/api";
import { rpcPath } from "@vibevalley/protocol/rpc";
import * as S from "@vibevalley/protocol/schema";

import { type ApiError, BizCode, type BizErrorCode, bizError, messageOf } from "#/base/errors.ts";
import { code as newCode } from "#/base/ids.ts";
import { hostName, serverAddress, ServerConfig } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import { callbackLog } from "#/infra/log.ts";
import { sameSecret, tidyName, User } from "#/modules/user/user.ts";
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
    readonly previewStopPairing: () => Preview;
    readonly answer: (allow: boolean) => Effect.Effect<LanStatus, ApiError>;
    readonly pair: (code: string, name: string) => Effect.Effect<LanPaired, ApiError>;
    readonly setUpstream: (address: string) => void;
  }
>()("@vibevalley/server/gateway/lan/lan") {
  static readonly layer = (options?: LanOptions) => Layer.effect(Lan, make(options));
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
  const peer = Str.replace(/^::ffff:/u, "")(req.socket.remoteAddress ?? "");
  const forwarded = req.headers["x-forwarded-for"];
  const first = Str.trim(Str.split(typeof forwarded === "string" ? forwarded : "", ",")[0] ?? "");
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
  remote.has(method + " " + path) || (method === "GET" && (path.startsWith(attachmentPath("")) || path.startsWith(artifactPrefix)));

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

const make = (options: LanOptions = {}) =>
  Effect.gen(function* () {
    const logs = yield* callbackLog;
    const forkHere = yield* FiberSet.makeRuntime();
    const config = yield* ServerConfig;
    const db = yield* Db;
    const users = yield* User;
    const http = yield* HttpClient.HttpClient;
    const address = options.address ?? lanAddress;
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();

    const lanOpen2 = yield* db.run(Effect.catchNoSuchElement(lanQ.lanOpen()));
    const initialOpen = Option.match(lanOpen2, {
      onNone: () => false,
      onSome: (r) => r.open,
    });
    let listener: ListenerState = { _tag: "closed" };
    let pairing: PairingState = { _tag: "idle" };
    // Serialize open/shut so a concurrent shut cannot miss an in-flight port bind and leave it listening.
    const opening = yield* Semaphore.make(1);
    let upstream = config.port > 0 ? serverAddress(config) : "";
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

    const refuseHttp = (res: ServerResponse, bizCode: BizErrorCode, message: string) => {
      res.writeHead(bizCodeMeta[bizCode].status, { "content-type": "application/json" });
      res.end(Formatter.formatJson({ bizCode, message }));
    };

    const send = (req: IncomingMessage, device: string) => {
      const method = req.method;
      if (!HttpMethod.isHttpMethod(method)) return undefined;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !dropped.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      headers[outsideHeader] = "1";
      headers[fromHeader] = clientOf(req);
      if (device) headers[deviceHeader] = device;
      const body =
        method === "GET" || method === "HEAD"
          ? HttpBody.empty
          : HttpBody.stream(NodeStream.fromReadable({ evaluate: () => req, onError: forwardFailed }), req.headers["content-type"]);
      return http.execute(HttpClientRequest.make(method)(`http://${upstream}${req.url ?? "/"}`, { headers, body })).pipe(Effect.mapError(forwardFailed));
    };

    // HttpOnly hides the key from page scripts; add Secure when a front TLS proxy reports https.
    const keyCookie = (req: IncomingMessage, key: string, maxAge: number) =>
      `${deviceKeyCookie}=${encodeURIComponent(key)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict` +
      (req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "");

    const signedAnswer = (req: IncomingMessage, res: ServerResponse, device: string, cookieOf: (status: number, body: string) => string | undefined) =>
      Effect.gen(function* () {
        const sent = send(req, device);
        if (sent === undefined) return refuseHttp(res, BizCode.MethodNotAllowed, t("server.lan.notRemote"));
        const answer = yield* sent;
        const body = yield* answer.text.pipe(Effect.mapError(forwardFailed));
        const cookie = cookieOf(answer.status, body);
        res.writeHead(answer.status, { ...answer.headers, ...(cookie !== undefined ? { "set-cookie": cookie } : {}) });
        res.end(body);
      });

    const decodeLogin = Schema.decodeOption(Schema.fromJsonString(apiSuccessEnvelope(S.UserLogin)));
    const signIn = (req: IncomingMessage, res: ServerResponse, device: string) =>
      signedAnswer(req, res, device, (status, body) =>
        status === 200 ? Option.getOrUndefined(Option.map(decodeLogin(body), (got) => keyCookie(req, got.data.key, 10 * 365 * 24 * 3600))) : undefined,
      );
    const signOut = (req: IncomingMessage, res: ServerResponse, device: string) =>
      signedAnswer(req, res, device, (status) => (status < 300 ? keyCookie(req, "", 0) : undefined));

    const forward = (req: IncomingMessage, res: ServerResponse, device: string) =>
      Effect.gen(function* () {
        const sent = send(req, device);
        if (sent === undefined) return refuseHttp(res, BizCode.MethodNotAllowed, t("server.lan.notRemote"));
        const answer = yield* sent;
        res.writeHead(answer.status, answer.headers);
        yield* Stream.run(answer.stream, NodeSink.fromWritable({ evaluate: () => res, onError: forwardFailed })).pipe(
          Effect.catchTag("HttpClientError", (e) => (e.reason._tag === "EmptyBodyError" ? Effect.sync(() => void res.end()) : Effect.fail(forwardFailed(e)))),
          // Destroy the response on interrupt so revoked devices or disconnected clients do not leave streams open.
          Effect.onInterrupt(() => Effect.sync(() => void res.destroy())),
        );
      });

    /** One request on the listener, on the service's fibers: the client leaving, or its device being forgotten, interrupts
     * it, and what was under way ends there. */
    const guard = (req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? "/", "http://lan").pathname;
      const handled = Effect.gen(function* () {
        if (!upstream) return refuseHttp(res, BizCode.LanUnavailable, t("server.lan.notUp"));
        if (path.startsWith("/api/v1/") && !sameOrigin(req.headers)) return refuseHttp(res, BizCode.LanForbidden, t("server.lan.notRemote"));
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
        if (device === undefined) return refuseHttp(res, BizCode.Unauthorized, t("server.lan.unpaired"));
        const may = device.came === "login" ? loginMay : remoteMay;
        if (!may(req.method ?? "GET", path)) return refuseHttp(res, BizCode.LanForbidden, t("server.lan.notRemote"));
        const d = device.id;
        // Skip tracking in conns: signOut revokes the device, which would interrupt its own response before clearing the cookie.
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
            else if (!res.headersSent) refuseHttp(res, BizCode.BadGateway, t("server.lan.badGateway"));
            else res.end();
          }),
        ),
      );
      const fiber = forkHere(handled);
      res.on("close", () => fiber.interruptUnsafe());
    };

    const tunnel = (req: IncomingMessage, client: Socket, head: Buffer) => {
      const refuse = (status: string) => void client.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
      if (!upstream) return refuse("503 Service Unavailable");
      if (new URL(req.url ?? "/", "http://lan").pathname !== rpcPath) return refuse("404 Not Found");
      const d = deviceOf(req)?.id;
      if (!d) return refuse("401 Unauthorized");
      // Forwarding strips Origin, so check it here before upgrading.
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
      // Upgraded WebSocket sockets are detached from http.Server and must be destroyed explicitly.
      for (const mine of conns.values()) for (const cut of mine) cut();
      current.closeAllConnections();
      return Effect.callback<void>((resume) => void current.close(() => resume(Effect.void))).pipe(
        Effect.andThen(Effect.sync(() => logs.info("vibevalley: lan access is shut"))),
      );
    });

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
        if (listener._tag !== "listening") return yield* refuse(t("server.lan.notOpen"));
        if (!url()) return yield* refuse(t("server.lan.noAddress"));
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
        if (!p || p._tag !== "awaitingApproval") return yield* refuse(t("server.lan.noneAsking"));
        const answer = p.answer;
        pairing = { _tag: "idle" };
        answer?.(allow);
        return status();
      }),
      pair: Effect.fn("Lan.pair")(function* (code, given) {
        const tidy = tidyName(given);
        const name = tidy === "" ? t("server.user.aDevice") : tidy;
        const p = livePairing();
        if (listener._tag === "closed") return yield* refuse(t("server.lan.closedThere"));
        if (!p) return yield* refuse(t("server.lan.codeExpired"));
        if (!sameSecret(p.code)(code.trim().toUpperCase())) {
          if (p._tag === "awaitingCode") {
            p.wrong++;
            if (p.wrong >= wrongTries) dropPairing();
          }
          return yield* refuse(t("server.lan.wrongCode"));
        }
        if (p._tag === "awaitingApproval") return yield* refuse(t("server.lan.anotherAsking"));
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
          return Effect.sync(() => {
            if (pairing === approval) pairing = { _tag: "idle" };
          });
        }).pipe(
          Effect.timeoutOption(pairingForMs),
          Effect.map((o) => Option.getOrElse(o, () => "late" as const)),
        );
        if (allow === "late") {
          if (pairing === approval) pairing = { _tag: "idle" };
          return yield* refuse(t("server.lan.userLate"));
        }
        if (!allow) return yield* refuse(t("server.lan.denied"));
        return yield* addDevice(name);
      }),
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
    });
  });
