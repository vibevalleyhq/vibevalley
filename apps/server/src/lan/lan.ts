import { t } from "@vibevalley/i18n";
// Lan access (连接到本机). The main server listens on loopback alone; lan access is a second listener
// on every interface, shut until the owner opens it. Through it go the endpoints marked remote and the state and side-event
// streams, never /mcp, and only with a paired device's key (a Bearer header, or the cookie a paired browser keeps):
// sessions run commands on this machine without asking. The page itself goes through to anyone, as it holds nothing of
// the farm's; a browser pairs on its /pair, the link the owner's QR code says. Opening
// it, pairing and forgetting devices are this machine's alone. The database keeps only each key's SHA-256. The listener
// speaks plain HTTP: a key can be overheard on the network it is open on. What it lets through it hands to the loopback
// server, saying which device asks.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  attachmentPath,
  eventsPath,
  type LanDevice,
  lanKeyCookie,
  type LanPaired,
  type LanStatus,
  livePath,
  type Preview,
  statePath,
} from "@vibevalley/protocol";
import { type ApiError, endpoints, pathOf } from "@vibevalley/protocol/api";
import { rpcPath } from "@vibevalley/protocol/rpc";
import { Clock, Context, Effect, FiberSet, Layer, Option, Semaphore } from "effect";
import { Settings } from "../base/config.ts";
import { Db } from "../base/db.ts";
import { code as newCode, newId } from "../base/ids.ts";
import { missing, lookIn } from "../errors.ts";
import { callbackLog } from "../base/log.ts";
import * as lanQ from "../../db/generated/lan.sql.ts";
import * as q from "../../db/generated/lan_device.sql.ts";

/** A device's asking gets as long again for the owner to answer. */
const pairingForMs = 2 * 60_000;
const wrongTries = 5;
const seenEveryMs = 60_000;

/** The header the listener says a device by, to the loopback server; never taken from the device. */
export const deviceHeader = "x-vibevalley-lan-device";

const refuse = (reason: string): ApiError => ({ _tag: "LanRefused", reason });

interface Device extends LanDevice {
  readonly keyHash: string;
  written: number;
}

interface Pairing {
  readonly code: string;
  expires: number;
  asking: string;
  answer?: (allow: boolean) => void;
  wrong: number;
}

export interface LanShape {
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
  readonly me: (device: string | undefined) => Effect.Effect<LanDevice, ApiError>;
  /** Where the loopback server listens, once it does. */
  readonly setUpstream: (address: string) => void;
}

export class Lan extends Context.Service<Lan, LanShape>()("vibevalley/Lan") {}

const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const hostName = () => hostname().replace(/\.local$/, "") || "vibevalley";

/** Wi-Fi or Ethernet (en*, eth*, wlan*) before others; a private IPv4 address. */
export function lanAddress(): string {
  let best = "";
  let rank = 3;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    const r = ["en", "eth", "wlan", "wl"].some((p) => name.startsWith(p)) ? 1 : 2;
    if (r >= rank) continue;
    const found = (addrs ?? []).find((a) => a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
    if (found) {
      best = found.address;
      rank = r;
    }
  }
  return best;
}

const deviceName = (name: string) => [...name.split(/\s+/).filter(Boolean).join(" ")].slice(0, 40).join("") || t("server.lan.aDevice");

/** The page's pairing route on the listener; a phone's camera opens it in the browser. */
export const pairLink = (url: string, code: string) => url + "/pair?c=" + encodeURIComponent(code);

const keyOf = (req: IncomingMessage) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === lanKeyCookie) return decodeURIComponent(value.join("="));
  }
  return "";
};

/** Never handed on: the device's key stays at the listener, and only the listener says which device asks. */
const dropped = new Set(["host", "connection", "cookie", "authorization", deviceHeader]);

/** The endpoints a device may call, the three streams and the files said in the chat; any other request is refused. */
const remote = new Set([
  ...endpoints.filter((e) => e.can.includes("remote")).map((e) => "POST " + pathOf(e.op)),
  ...[statePath, eventsPath, livePath].map((path) => "GET " + path),
]);

export const remoteMay = (method: string, path: string) => remote.has(method + " " + path) || (method === "GET" && path.startsWith(attachmentPath("")));

export interface LanOptions {
  readonly address?: () => string;
  /** The host the listener binds; every interface when absent. */
  readonly host?: string;
}

export const make = (options: LanOptions = {}) =>
  Effect.gen(function* () {
    const logs = yield* callbackLog;
    // Writes set off by a request belong to this service: they end with it and keep its services.
    const runHere = yield* FiberSet.makeRuntimePromise<never>();
    const config = yield* Settings;
    const { run: db } = yield* Db;
    const address = options.address ?? lanAddress;
    // Read in callbacks too: the Clock the service was built with.
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();

    const devices = new Map<string, Device>();
    for (const row of yield* db(q.lanDevices())) {
      devices.set(row.id, {
        id: row.id,
        name: row.name,
        pairedAt: row.paired_at,
        keyHash: row.key_hash,
        written: row.last_seen ?? 0,
        ...(row.last_seen !== null ? { lastSeen: row.last_seen } : {}),
      });
    }
    // No row yet is shut.
    let open = Option.match(yield* db(Effect.catchNoSuchElement(lanQ.lanOpen())), {
      onNone: () => false,
      onSome: (r) => r.open,
    });
    let server: Server | undefined;
    let port = 0;
    let problem = "";
    let pairing: Pairing | undefined;
    // Opening binds the port after its write: a shut that came in between would find no server yet and leave the one
    // bound after it listening. One open or shut at a time.
    const opening = yield* Semaphore.make(1);
    let upstream = "";
    /** Forgetting a device ends them. */
    const conns = new Map<string, Set<AbortController>>();

    // forget and its dry run judge by this.
    const known = (id: string) => {
      const d = devices.get(id);
      return d ? Effect.succeed(d) : Effect.fail(missing(t("server.lan.noDevice", { id }), [lookIn.device]));
    };
    const dropPairing = () => {
      pairing?.answer?.(false);
      pairing = undefined;
    };
    const livePairing = () => {
      if (pairing && now() >= pairing.expires) dropPairing();
      return pairing;
    };
    const url = () => {
      if (!server) return "";
      const host = address();
      return host ? `http://${host}:${port}` : "";
    };

    const deviceOf = (req: IncomingMessage) => {
      const key = keyOf(req);
      if (!key) return "";
      const h = hash(key);
      const found = [...devices.values()].find((d) => same(d.keyHash, h));
      if (!found) return "";
      const at = now();
      found.lastSeen = at;
      if (at - found.written >= seenEveryMs) {
        found.written = at;
        void runHere(db(q.seenLanDevice({ last_seen: at, id: found.id }))).catch((e) => logs.error("vibevalley: lan access:", e));
      }
      return found.id;
    };

    const refuseHttp = (res: ServerResponse, status: number, reason: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ _tag: "LanRefused", reason }));
    };

    /** Handed to the loopback server as it came, the device said; the answer streams back. */
    const forward = async (req: IncomingMessage, res: ServerResponse, device: string, signal: AbortSignal) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !dropped.has(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      if (device) headers.set(deviceHeader, device);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
      const answer = await fetch(`http://${upstream}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
        ...(body ? { body, duplex: "half" } : {}),
        signal,
      });
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      if (!answer.body) return void res.end();
      await pipeline(Readable.fromWeb(answer.body as NodeReadableStream<Uint8Array>), res, { signal });
    };

    const guard = (req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? "/", "http://lan").pathname;
      const done = new AbortController();
      res.on("close", () => done.abort());
      const go = async () => {
        if (!upstream) return refuseHttp(res, 503, t("server.lan.notUp"));
        if (req.method === "POST" && path === pathOf("lan.pair")) return forward(req, res, "", done.signal);
        if (!path.startsWith("/api/v1/")) {
          if ((req.method === "GET" || req.method === "HEAD") && path !== "/mcp" && !path.startsWith("/mcp/")) return forward(req, res, "", done.signal);
          res.writeHead(404, { "content-type": "text/plain" });
          return void res.end("404 page not found\n");
        }
        const d = deviceOf(req);
        if (!d) return refuseHttp(res, 401, t("server.lan.unpaired"));
        if (!remoteMay(req.method ?? "GET", path)) return refuseHttp(res, 403, t("server.lan.notRemote"));
        const mine = conns.get(d) ?? new Set();
        conns.set(d, mine);
        mine.add(done);
        try {
          await forward(req, res, d, done.signal);
        } finally {
          mine.delete(done);
        }
      };
      go().catch(() => {
        if (!res.headersSent) refuseHttp(res, 502, t("server.lan.badGateway"));
        else res.end();
      });
    };

    /** The page's WebSocket from a paired device: the upgrade goes to the loopback server as it came, saying which
     * device asks, and bytes go both ways until either side closes; forgetting the device or shutting ends it. */
    const tunnel = (req: IncomingMessage, client: Socket, head: Buffer) => {
      const refuse = (status: string) => void client.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
      if (!upstream) return refuse("503 Service Unavailable");
      if (new URL(req.url ?? "/", "http://lan").pathname !== rpcPath) return refuse("404 Not Found");
      const d = deviceOf(req);
      if (!d) return refuse("401 Unauthorized");
      // Not left to the loopback server, which takes the device header as checked: only the farm's page, as there.
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host ?? ""}`) return refuse("403 Forbidden");
      const [host, port] = [upstream.slice(0, upstream.lastIndexOf(":")), Number(upstream.slice(upstream.lastIndexOf(":") + 1))];
      const lines = [`GET ${req.url ?? rpcPath} HTTP/1.1`, `host: ${upstream}`, "connection: Upgrade", `${deviceHeader}: ${d}`];
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !dropped.has(k)) for (const one of [v].flat()) lines.push(`${k}: ${one}`);
      const done = new AbortController();
      const mine = conns.get(d) ?? new Set();
      conns.set(d, mine);
      mine.add(done);
      const up = connect(port, host, () => {
        up.write(lines.join("\r\n") + "\r\n\r\n");
        if (head.length > 0) up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      const end = () => {
        mine.delete(done);
        client.destroy();
        up.destroy();
      };
      done.signal.addEventListener("abort", end);
      for (const side of [client, up]) {
        side.on("error", end);
        side.on("close", end);
      }
    };

    // A port taken is said in the status; the farm runs on.
    const listen = () =>
      new Promise<void>((resolve) => {
        if (server) return resolve();
        const s = createServer(guard);
        s.on("upgrade", tunnel);
        s.once("error", (e) => {
          problem = t("server.lan.cannotOpen", { why: e.message });
          logs.error(`vibevalley: lan access cannot listen on port ${config.lan.port}:`, e.message);
          resolve();
        });
        s.listen(config.lan.port, options.host, () => {
          problem = "";
          server = s;
          const a = s.address();
          port = a && typeof a === "object" ? a.port : config.lan.port;
          logs.info(`vibevalley: lan access is open on port ${port}`);
          resolve();
        });
      });

    const shut = async () => {
      dropPairing();
      const current = server;
      server = undefined;
      if (!current) return;
      // An upgraded socket is no longer the server's to close.
      for (const mine of conns.values()) for (const c of mine) c.abort();
      current.closeAllConnections();
      await new Promise<void>((resolve) => current.close(() => resolve()));
      logs.info("vibevalley: lan access is shut");
    };

    const status = (): LanStatus => {
      const s: LanStatus = { open, hostName: hostName(), devices: [] };
      if (problem) s.problem = problem;
      const addr = url();
      if (open && server) {
        if (!addr) s.problem = t("server.lan.noAddress");
        else s.url = addr;
      }
      const p = livePairing();
      if (p && addr) s.pairing = { code: p.code, link: pairLink(addr, p.code), expiresAt: p.expires, ...(p.asking ? { asking: p.asking } : {}) };
      s.devices = [...devices.values()].map(({ keyHash: _, written: __, ...d }) => d).sort((a, b) => a.pairedAt - b.pairedAt);
      return s;
    };

    if (open) yield* Effect.promise(listen);
    yield* Effect.addFinalizer(() => Effect.promise(() => shut()));

    const addDevice = Effect.fn("Lan.addDevice")(function* (name: string) {
      const key = randomBytes(32).toString("base64url");
      const d: Device = { id: newId(), name, pairedAt: now(), keyHash: hash(key), written: 0 };
      yield* db(q.addLanDevice({ id: d.id, name: d.name, key_hash: d.keyHash, paired_at: d.pairedAt }));
      devices.set(d.id, d);
      logs.info(`vibevalley: lan access: "${name}" paired`);
      return { device: d.id, key, hostName: hostName() };
    });

    return Lan.of({
      status,
      setOpen: Effect.fn("Lan.setOpen")(function* (want) {
        yield* db(lanQ.setLanOpen({ open: want }));
        open = want;
        if (want) yield* Effect.promise(listen);
        else {
          problem = "";
          yield* Effect.promise(() => shut());
        }
        return status();
      }, opening.withPermits(1)),
      startPairing: () =>
        Effect.suspend(() => {
          if (!open || !server) return Effect.fail(refuse(t("server.lan.notOpen")));
          if (!url()) return Effect.fail(refuse(t("server.lan.noAddress")));
          dropPairing();
          pairing = { code: newCode(10), expires: now() + pairingForMs, asking: "", wrong: 0 };
          return Effect.succeed(status());
        }),
      stopPairing: () => {
        dropPairing();
        return status();
      },
      answer: (allow) =>
        Effect.suspend(() => {
          const p = livePairing();
          if (!p || !p.asking) return Effect.fail(refuse(t("server.lan.noneAsking")));
          const answer = p.answer;
          pairing = undefined;
          answer?.(allow);
          return Effect.succeed(status());
        }),
      pair: Effect.fn("Lan.pair")(function* (code, given) {
        const name = deviceName(given);
        const p = livePairing();
        if (!open) return yield* Effect.fail(refuse(t("server.lan.closedThere")));
        if (!p) return yield* Effect.fail(refuse(t("server.lan.codeExpired")));
        if (!same(code.trim().toUpperCase(), p.code)) {
          p.wrong++;
          if (p.wrong >= wrongTries) dropPairing();
          return yield* Effect.fail(refuse(t("server.lan.wrongCode")));
        }
        if (p.asking) return yield* Effect.fail(refuse(t("server.lan.anotherAsking")));
        p.asking = name;
        p.expires = now() + pairingForMs;
        logs.info(`vibevalley: lan access: "${name}" questions to pair`);
        const allow = yield* Effect.callback<boolean>((resume) => {
          p.answer = (a) => resume(Effect.succeed(a));
          // Cut short (the time ran out, or the request went away): unless the owner has answered or a new pairing
          // replaced it.
          return Effect.sync(() => {
            if (pairing === p) pairing = undefined;
          });
        }).pipe(Effect.timeoutOption(pairingForMs), Effect.map(Option.getOrElse(() => "late" as const)));
        if (allow === "late") {
          if (pairing === p) pairing = undefined;
          return yield* Effect.fail(refuse(t("server.lan.ownerLate")));
        }
        if (!allow) return yield* Effect.fail(refuse(t("server.lan.denied")));
        return yield* addDevice(name);
      }),
      previewStopPairing: () => {
        const p = livePairing();
        if (!p) return { does: [t("server.lan.noCode")] };
        return { does: [t("server.lan.dropCode", { code: p.code }), ...(p.asking ? [t("server.lan.dropAsking", { name: p.asking })] : [])] };
      },
      forget: Effect.fn("Lan.forget")(function* (id) {
        yield* known(id);
        yield* db(q.removeLanDevice({ id }));
        devices.delete(id);
        for (const c of conns.get(id) ?? []) c.abort();
        conns.delete(id);
        return status();
      }),
      previewForget: (id) =>
        Effect.map(known(id), (d) => {
          const open = conns.get(id)?.size ?? 0;
          return { does: [t("server.lan.forget", { name: d.name }), ...(open > 0 ? [t("server.lan.cut", { n: open })] : [])] };
        }),
      me: (device) => {
        const d = device ? devices.get(device) : undefined;
        if (!d) return Effect.fail(refuse(t("server.lan.local")));
        const { keyHash: _, written: __, ...shown } = d;
        return Effect.succeed(shown);
      },
      setUpstream: (a) => {
        upstream = a;
      },
    });
  });

export const layer = (options?: LanOptions) => Layer.effect(Lan, make(options));
