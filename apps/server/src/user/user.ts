import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { Array as Arr, Cause, Clock, Context, Effect, FiberSet, Layer, Option, Order, PubSub, Semaphore, Stream, String as Str } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import type { ApiError } from "@vibevalley/protocol/api";

import { lookIn, missing } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { scopedPubSub } from "#/base/pubsub.ts";
import { Db } from "#/infra/db.ts";
import { callbackLog } from "#/infra/log.ts";
import * as accountQ from "#db/user_account.sql.ts";
import * as q from "#db/user_device.sql.ts";

const wrongTries = 5;
const lockedForMs = 60_000;
const seenEveryMs = 60_000;
const passwordMin = 8;

// OWASP's floor for scrypt; a sign-in waits for it, which is what makes guessing slow.
const cost = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const hashLength = 64;

const refuse = (reason: string): ApiError => ({ _tag: "LanRefused", reason });

interface Device extends T.UserDevice {
  readonly keyHash: string;
  written: number;
}

/** The person a request is for: on this machine, or through the gate as one of their devices. */
export interface Caller {
  readonly here: boolean;
  readonly device?: string;
}

export class User extends Context.Service<
  User,
  {
    readonly status: (caller: Caller) => T.UserStatus;
    readonly rename: (name: string) => Effect.Effect<T.UserStatus, ApiError>;
    /** Refused through the gate: only someone at this machine sets the password. */
    readonly setPassword: (caller: Caller, password: string) => Effect.Effect<T.UserStatus, ApiError>;
    readonly login: (password: string, device: string) => Effect.Effect<T.UserLogin, ApiError>;
    readonly logout: (caller: Caller) => Effect.Effect<void, ApiError>;
    /** A device the user let in at the gate; its key, shown once. */
    readonly pair: (name: string) => Effect.Effect<T.UserLogin>;
    readonly devices: () => T.UserDevice[];
    /** The device a key is, noting that it was seen. */
    readonly byKey: (key: string) => T.UserDevice | undefined;
    readonly revoke: (id: string) => Effect.Effect<T.UserDevice[], ApiError>;
    /** What revoke would do, refused as it would be; nothing changes. */
    readonly previewRevoke: (id: string) => Effect.Effect<T.Preview, ApiError>;
    /** Each revoked device's id: what holds its connections cuts them. */
    readonly revoked: Stream.Stream<string>;
  }
>()("@vibevalley/server/user/user") {
  static readonly layer = Layer.effect(
    User,
    Effect.suspend(() => make),
  );
}

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");

/** A secret checked in constant time, so how long the check takes says nothing about how much of it was right. */
export const sameSecret =
  (want: string) =>
  (given: string): boolean =>
    given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));

/** A name as given, its runs of space made one and cut at 40 characters; "" when nothing is left. */
export const tidyName = (given: string) => Arr.join(Arr.take(Array.from(Arr.join(Arr.filter(Str.split(given, /\s+/u), Str.isNonEmpty), " ")), 40), "");

const derive = (password: string, salt: Buffer, length: number, costs: { readonly N: number; readonly r: number; readonly p: number }) =>
  Effect.callback<Buffer>((resume) => {
    scrypt(Str.normalize("NFKC")(password), salt, length, { ...costs, maxmem: cost.maxmem }, (e, out) =>
      resume(e === null ? Effect.succeed(out) : Effect.die(e)),
    );
  });

const hashPassword = (password: string) =>
  Effect.gen(function* () {
    const salt = randomBytes(16);
    const out = yield* derive(password, salt, hashLength, cost);
    return Arr.join(["scrypt", String(cost.N), String(cost.r), String(cost.p), salt.toString("base64url"), out.toString("base64url")], ":");
  });

/** A stored hash written with other costs still checks: they are read from it. */
const checkPassword = (password: string, stored: string) =>
  Effect.gen(function* () {
    const [kind, n, r, p, salt = "", want = ""] = Str.split(stored, ":");
    if (kind !== "scrypt") return false;
    const expected = Buffer.from(want, "base64url");
    const out = yield* derive(password, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return out.length === expected.length && timingSafeEqual(out, expected);
  });

const byAdded = Order.mapInput(Order.Number, (d: T.UserDevice) => d.addedAt);

const make = Effect.gen(function* () {
  const db = yield* Db;
  const logs = yield* callbackLog;
  const forkHere = yield* FiberSet.makeRuntime();
  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();
  const revokes = yield* scopedPubSub<string>();
  // Sign-ins check one at a time, so the wrong-try count cannot be raced past.
  const signing = yield* Semaphore.make(1);

  const account = yield* db.one(accountQ.userAccount());
  let name = account?.name ?? "";
  let passwordHash = account?.password_hash ?? undefined;
  let wrong = 0;
  let lockedUntil = 0;

  const devices = new Map<string, Device>();
  for (const row of yield* db.run(q.userDevices())) {
    devices.set(row.id, {
      id: row.id,
      name: row.name,
      came: row.came === "login" ? "login" : "paired",
      addedAt: row.added_at,
      keyHash: row.key_hash,
      written: row.last_seen ?? 0,
      ...(row.last_seen !== null ? { lastSeen: row.last_seen } : {}),
    });
  }

  const shown = ({ keyHash: _, written: __, ...d }: Device): T.UserDevice => d;
  const listed = () => Arr.sort(Arr.map(Array.from(devices.values()), shown), byAdded);
  const known = (id: string) => {
    const d = devices.get(id);
    return d !== undefined ? Effect.succeed(d) : Effect.fail(missing(t("server.user.noDevice", { id }), [lookIn.device]));
  };

  const status = (caller: Caller): T.UserStatus => {
    const device = caller.device !== undefined ? devices.get(caller.device) : undefined;
    // A caller at the gate with no key learns only whether it can sign in.
    const seen = caller.here || device !== undefined;
    return { name: seen ? name : "", password: passwordHash !== undefined, here: caller.here, ...(device !== undefined ? { device: shown(device) } : {}) };
  };

  const addDevice = Effect.fn("User.addDevice")(function* (given: string, came: T.DeviceCame) {
    const key = randomBytes(32).toString("base64url");
    const tidy = tidyName(given);
    const d: Device = { id: newId(), name: Str.isEmpty(tidy) ? t("server.user.aDevice") : tidy, came, addedAt: now(), keyHash: keyHash(key), written: 0 };
    yield* db.run(q.addUserDevice({ id: d.id, name: d.name, came, key_hash: d.keyHash, added_at: d.addedAt }));
    devices.set(d.id, d);
    logs.info(`vibevalley: user: device "${d.name}" added (${came})`);
    return { device: d.id, key };
  });

  const revoke = Effect.fn("User.revoke")(function* (id: string) {
    yield* known(id);
    yield* db.run(q.removeUserDevice({ id }));
    devices.delete(id);
    yield* PubSub.publish(revokes, id);
    return listed();
  });

  return User.of({
    status,
    rename: Effect.fn("User.rename")(function* (given) {
      const next = tidyName(given);
      yield* db.run(accountQ.setUserName({ name: next }));
      name = next;
      return status({ here: true });
    }),
    setPassword: Effect.fn("User.setPassword")(function* (caller, password) {
      if (!caller.here) return yield* Effect.fail(refuse(t("server.user.passwordHere")));
      if ([...password].length < passwordMin) return yield* Effect.fail(refuse(t("server.user.passwordShort", { n: passwordMin })));
      const stored = yield* hashPassword(password);
      yield* db.run(accountQ.setUserPassword({ password_hash: stored, password_set_at: now() }));
      passwordHash = stored;
      wrong = 0;
      lockedUntil = 0;
      logs.info("vibevalley: user: the password is set");
      return status(caller);
    }),
    login: Effect.fn("User.login")(function* (password, device) {
      if (passwordHash === undefined) return yield* Effect.fail(refuse(t("server.user.noPassword")));
      if (now() < lockedUntil) return yield* Effect.fail(refuse(t("server.user.locked", { s: Math.ceil((lockedUntil - now()) / 1000) })));
      if (!(yield* checkPassword(password, passwordHash))) {
        wrong++;
        if (wrong >= wrongTries) {
          wrong = 0;
          lockedUntil = now() + lockedForMs;
          logs.info("vibevalley: user: too many wrong passwords, sign-in is locked for a while");
        }
        return yield* Effect.fail(refuse(t("server.user.wrongPassword")));
      }
      wrong = 0;
      return yield* addDevice(device, "login");
    }, signing.withPermits(1)),
    logout: Effect.fn("User.logout")(function* (caller) {
      if (caller.device === undefined) return yield* Effect.fail(refuse(t("server.user.notADevice")));
      yield* revoke(caller.device);
    }),
    pair: Effect.fn("User.pair")(function* (given) {
      return yield* addDevice(given, "paired");
    }),
    devices: listed,
    byKey: (key) => {
      if (key === "") return undefined;
      const matches = sameSecret(keyHash(key));
      const hit = Arr.findFirst(Array.from(devices.values()), (d) => matches(d.keyHash));
      if (Option.isNone(hit)) return undefined;
      const found = hit.value;
      const at = now();
      found.lastSeen = at;
      if (at - found.written >= seenEveryMs) {
        found.written = at;
        forkHere(
          db.run(q.seenUserDevice({ last_seen: at, id: found.id })).pipe(Effect.catchCause((c) => Effect.logError(`vibevalley: user: ${Cause.pretty(c)}`))),
        );
      }
      return shown(found);
    },
    revoke,
    previewRevoke: Effect.fn("User.previewRevoke")(function* (id) {
      const d = yield* known(id);
      return { does: [t("server.user.revoke", { name: d.name })] };
    }),
    revoked: Stream.fromPubSub(revokes),
  });
});
