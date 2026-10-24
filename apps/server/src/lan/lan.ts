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
import { hostname, networkInterfaces } from "node:os";
import { Readable } from "node:stream";
import { eventsPath, type LanDevice, lanKeyCookie, type LanPaired, type LanStatus, livePath, type Preview, statePath } from "@vibevalley/protocol";
import { type ApiError, endpoints, LanRefused } from "@vibevalley/protocol/api";
import { Context, Effect, FiberSet, Layer, Option, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { Settings } from "../base/config.ts";
import { code as newCode, newId } from "../base/ids.ts";
import { missing, lookIn } from "../errors.ts";
import { callbackLog } from "../base/log.ts";
import * as lanQ from "../../db/generated/lan.sql.ts";
import * as q from "../../db/generated/lan_device.sql.ts";
import { Db } from "../base/db.ts";

/** A device's asking gets as long again for the owner to answer. */
const pairingForMs = 2 * 60_000;
const wrongTries = 5;
const seenEveryMs = 60_000;

/** The header the listener says a device by, to the loopback server; never taken from the device. */
export const deviceHeader = "x-vibevalley-lan-device";

const refuse = (reason: string): ApiError => new LanRefused({ reason });

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

const deviceName = (name: string) => [...name.split(/\s+/).filter(Boolean).join(" ")].slice(0, 40).join("") || "一台设备";

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

/** The endpoints a device may call, and the three streams; a request no pattern matches is refused. */
const remote = [
  ...endpoints.filter((e) => e.can.includes("remote")).map((e) => ({ method: e.method, path: e.path })),
  ...[statePath, eventsPath, livePath].map((path) => ({ method: "GET", path })),
].map((r) => ({ method: r.method, pattern: new RegExp("^" + r.path.replace(/\{\w+\}/g, "[^/]+") + "$") }));

export const remoteMay = (method: string, path: string) => remote.some((r) => r.method === method && r.pattern.test(path));

export interface LanOptions {
  readonly address?: () => string;
  readonly now?: () => number;
  /** The host the listener binds; every interface when absent. */
  readonly host?: string;
}

export const make = Effect.fnUntraced(function* (options: LanOptions = {}) {
  const logs = yield* callbackLog;
  // Writes set off by a request belong to this service: they end with it and keep its services.
  const runHere = yield* FiberSet.makeRuntimePromise<never>();
  const config = yield* Settings;
  const sql = yield* SqlClient.SqlClient;
  const { run: db } = yield* Db;
  const address = options.address ?? lanAddress;
  const now = options.now ?? Date.now;

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
  let open = Option.match(yield* Effect.option(Effect.provideService(lanQ.lanOpen(), SqlClient.SqlClient, sql)), {
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
    return d ? Effect.succeed(d) : Effect.fail(missing(`没有 ${id} 这台设备`, [lookIn.device]));
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
    } as RequestInit);
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    if (!answer.body) return void res.end();
    for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
    res.end();
  };

  const guard = (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://lan").pathname;
    const done = new AbortController();
    res.on("close", () => done.abort());
    const go = async () => {
      if (!upstream) return refuseHttp(res, 503, "VibeValley 还没起来");
      if (req.method === "POST" && path === "/api/v1/lan/pair") return forward(req, res, "", done.signal);
      if (!path.startsWith("/api/v1/")) {
        if ((req.method === "GET" || req.method === "HEAD") && path !== "/mcp" && !path.startsWith("/mcp/")) return forward(req, res, "", done.signal);
        res.writeHead(404, { "content-type": "text/plain" });
        return void res.end("404 page not found\n");
      }
      const d = deviceOf(req);
      if (!d) return refuseHttp(res, 401, "这台设备没配对，或者已经被主人移除了：回那台电脑上扫码配对");
      if (!remoteMay(req.method ?? "GET", path)) return refuseHttp(res, 403, "连进来的设备不能做这个：只能在跑着 VibeValley 的那台电脑上做");
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
      if (!res.headersSent) refuseHttp(res, 502, "转不过去");
      else res.end();
    });
  };

  // A port taken is said in the status; the farm runs on.
  const listen = () =>
    new Promise<void>((resolve) => {
      if (server) return resolve();
      const s = createServer(guard);
      s.once("error", (e) => {
        problem = "连接开不起来：" + e.message;
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

  const shut = () => {
    dropPairing();
    if (server) {
      server.closeAllConnections();
      server.close();
      logs.info("vibevalley: lan access is shut");
    }
    server = undefined;
  };

  const status = (): LanStatus => {
    const s: LanStatus = { open, hostName: hostName(), devices: [] };
    if (problem) s.problem = problem;
    const addr = url();
    if (open && server) {
      if (!addr) s.problem = "找不到这台电脑在局域网里的地址：连上 Wi-Fi 或网线再试";
      else s.url = addr;
    }
    const p = livePairing();
    if (p && addr) s.pairing = { code: p.code, link: pairLink(addr, p.code), expiresAt: p.expires, ...(p.asking ? { asking: p.asking } : {}) };
    s.devices = [...devices.values()].map(({ keyHash: _, written: __, ...d }) => d).sort((a, b) => a.pairedAt - b.pairedAt);
    return s;
  };

  if (open) yield* Effect.promise(listen);
  yield* Effect.addFinalizer(() => Effect.sync(shut));

  const addDevice = Effect.fnUntraced(function* (name: string) {
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
        shut();
      }
      return status();
    }, opening.withPermits(1)),
    startPairing: () =>
      Effect.suspend(() => {
        if (!open || !server) return Effect.fail(refuse("还没允许连接：先打开它"));
        if (!url()) return Effect.fail(refuse("找不到这台电脑在局域网里的地址：连上 Wi-Fi 或网线再试"));
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
        if (!p || !p.asking) return Effect.fail(refuse("没有设备在等你点头"));
        const answer = p.answer;
        pairing = undefined;
        answer?.(allow);
        return Effect.succeed(status());
      }),
    pair: Effect.fn("Lan.pair")(function* (code, given) {
      const name = deviceName(given);
      const p = livePairing();
      if (!open) return yield* Effect.fail(refuse("那台电脑没允许连接：回那台电脑的「连接到本机」打开它"));
      if (!p) return yield* Effect.fail(refuse("配对码过期了：回那台电脑上换一个码"));
      if (!same(code.trim().toUpperCase(), p.code)) {
        p.wrong++;
        if (p.wrong >= wrongTries) dropPairing();
        return yield* Effect.fail(refuse("配对码不对"));
      }
      if (p.asking) return yield* Effect.fail(refuse("另一台设备正在等主人点头：等一会儿再试"));
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
        return yield* Effect.fail(refuse("主人没来得及点头，配对码过期了：回那台电脑上换一个码"));
      }
      if (!allow) return yield* Effect.fail(refuse("主人没让这台设备进来"));
      return yield* addDevice(name);
    }),
    previewStopPairing: () => {
      const p = livePairing();
      if (!p) return { does: ["没有在配对的码：什么都不会动"] };
      return { does: [`收起配对码 ${p.code}`, ...(p.asking ? [`正在等你点头的「${p.asking}」连不进来`] : [])] };
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
        return { does: [`忘掉设备「${d.name}」：它的钥匙作废，要再连得重新配对`, ...(open > 0 ? [`断开它连着的 ${open} 条连接`] : [])] };
      }),
    me: (device) => {
      const d = device ? devices.get(device) : undefined;
      if (!d) return Effect.fail(refuse("这里就是跑着 VibeValley 的本机，不是连进来的设备"));
      const { keyHash: _, written: __, ...shown } = d;
      return Effect.succeed(shown);
    },
    setUpstream: (a) => {
      upstream = a;
    },
  });
});

export const layer = (options?: LanOptions) => Layer.effect(Lan, make(options));
