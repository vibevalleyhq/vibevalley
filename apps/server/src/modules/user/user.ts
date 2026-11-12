import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { Hub, Semaphore, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { type ApiError, BizCode, bizError, lookIn, missing } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import * as accountQ from "#db/user_account.sql.ts";
import * as q from "#db/user_device.sql.ts";

const wrongTries = 5;
const lockedForMs = 60_000;
const seenEveryMs = 60_000;
const passwordMin = 8;
const requestForMs = 10 * 60_000;
const requestsAtOnce = 5;
const collectEverySeconds = 2;
/** RFC 8628 `slow_down`: polling too early adds 5s permanently to that request's interval. */
const slowDownSeconds = 5;
const collectSlack = 0.8;
const idleForMs = 90 * 24 * 3600_000;
const sweepEveryMs = 24 * 3600_000;
/** Prefix recognized by secret scanners. */
const keyPrefix = "vvk_";
// Omit vowels and 0/O/1/I look-alikes to avoid accidental words and transcription slips.
const codeLetters = "BCDFGHJKLMNPQRSTVWXZ";

// OWASP scrypt floor; sign-in blocks on derivation to throttle guessing.
const cost = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const hashLength = 64;

const refuse = (reason: string): ApiError => bizError(BizCode.AuthRefused, reason);

interface Device extends T.UserDevice {
  readonly keyHash: string;
  written: number;
}

interface Request extends T.Approval {
  readonly claimHash: string;
  approved: boolean;
  every: number;
  lastCollect: number;
}

const requestCode = () => {
  const letters = Array.from(randomBytes(8), (b) => codeLetters[b % codeLetters.length] ?? "B");
  return letters.slice(0, 4).join("") + "-" + letters.slice(4).join("");
};

export interface Caller {
  readonly here: boolean;
  readonly device?: string;
  /** Remote address observed at the LAN gate; absent on loopback. */
  readonly from?: string;
}

export interface User {
  readonly status: (caller: Caller) => T.UserStatus;
  readonly rename: (name: string) => Promise<T.UserStatus>;
  /** Local callers only; refused through the LAN gate. */
  readonly setPassword: (caller: Caller, password: string) => Promise<T.UserStatus>;
  readonly login: (password: string, device: string) => Promise<T.UserLogin>;
  readonly logout: (caller: Caller) => Promise<void>;
  readonly pair: (name: string) => Promise<T.UserLogin>;
  readonly devices: () => T.UserDevice[];
  /** Updates `lastSeen` and revokes keys idle past `idleForMs`. */
  readonly byKey: (key: string) => T.UserDevice | undefined;
  readonly revoke: (id: string) => Promise<T.UserDevice[]>;
  readonly previewRevoke: (id: string) => Promise<T.Preview>;
  readonly request: (caller: Caller, name: string) => Promise<T.ApprovalCreated>;
  readonly collect: (claim: string) => Promise<T.ApprovalCollected>;
  readonly requests: () => T.Approval[];
  readonly answerRequest: (id: string, allow: boolean) => Promise<T.Approval[]>;
  /** The id of each device revoked from now on. */
  readonly revoked: (signal?: AbortSignal) => AsyncIterable<string>;
  /** Stops the daily sweep and the writes byKey left running. */
  readonly close: () => Promise<void>;
}

export interface UserDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
}

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");

/** A secret checked in constant time, so how long the check takes says nothing about how much of it was right. */
export const sameSecret =
  (want: string) =>
  (given: string): boolean =>
    given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));

export const tidyName = (given: string) =>
  Array.from(
    given
      .split(/\s+/u)
      .filter((w) => w !== "")
      .join(" "),
  )
    .slice(0, 40)
    .join("");

const derive = (password: string, salt: Buffer, length: number, costs: { readonly N: number; readonly r: number; readonly p: number }) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, length, { ...costs, maxmem: cost.maxmem }, (e, out) => (e === null ? resolve(out) : reject(e)));
  });

const hashPassword = async (password: string) => {
  const salt = randomBytes(16);
  const out = await derive(password, salt, hashLength, cost);
  return ["scrypt", String(cost.N), String(cost.r), String(cost.p), salt.toString("base64url"), out.toString("base64url")].join(":");
};

/** Reads N/r/p from the stored hash so cost upgrades do not invalidate existing passwords. */
const checkPassword = async (password: string, stored: string) => {
  const [kind, n, r, p, salt = "", want = ""] = stored.split(":");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(want, "base64url");
  const out = await derive(password, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return out.length === expected.length && timingSafeEqual(out, expected);
};

const byAdded = (a: T.UserDevice, b: T.UserDevice) => a.addedAt - b.addedAt;

export async function makeUser(deps: UserDeps): Promise<User> {
  const { db, clock } = deps;
  const log = deps.log.child("user");
  const tasks = new TaskGroup({ name: "user", onError: (task, e) => log.error(`vibevalley: user: ${task}`, e) });
  const now = () => clock.now();
  const revokes = new Hub<string>();
  // Serialize sign-ins so concurrent attempts cannot race past `wrongTries`.
  const signing = new Semaphore(1);

  const account = await accountQ.userAccount(db.sql);
  let name = account?.name ?? "";
  let passwordHash = account?.password_hash ?? undefined;
  let wrong = 0;
  let lockedUntil = 0;

  const devices = new Map<string, Device>();
  for (const row of await q.userDevices(db.sql)) {
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

  // In-memory only: restarts drop pending approvals and callers request a new code.
  const waiting = new Map<string, Request>();
  const live = () => {
    for (const [id, r] of waiting) if (r.expiresAt <= now()) waiting.delete(id);
    return Array.from(waiting.values(), ({ claimHash: _, approved: __, every: ___, lastCollect: ____, ...r }): T.Approval => r);
  };

  const shown = ({ keyHash: _, written: __, ...d }: Device): T.UserDevice => d;
  const listed = () => Array.from(devices.values(), shown).toSorted(byAdded);
  const known = (id: string) => {
    const d = devices.get(id);
    if (d === undefined) throw missing(t("server.user.noDevice", { id }), [lookIn.device]);
    return d;
  };

  const status = (caller: Caller): T.UserStatus => {
    const device = caller.device !== undefined ? devices.get(caller.device) : undefined;
    // Unauthenticated callers at the gate do not learn the user's name.
    const seen = caller.here || device !== undefined;
    return { name: seen ? name : "", password: passwordHash !== undefined, here: caller.here, ...(device !== undefined ? { device: shown(device) } : {}) };
  };

  const addDevice = async (given: string, came: T.UserDevice["came"]) => {
    const key = keyPrefix + randomBytes(32).toString("base64url");
    const tidy = tidyName(given);
    const d: Device = { id: newId(), name: tidy === "" ? t("server.user.aDevice") : tidy, came, addedAt: now(), keyHash: keyHash(key), written: 0 };
    await q.addUserDevice(db.sql, { id: d.id, name: d.name, came, key_hash: d.keyHash, added_at: d.addedAt });
    devices.set(d.id, d);
    log.info(`vibevalley: user: device "${d.name}" added (${came})`);
    return { device: d.id, key };
  };

  const revoke = async (id: string) => {
    known(id);
    await q.removeUserDevice(db.sql, { id });
    devices.delete(id);
    revokes.publish(id);
    return listed();
  };

  const idle = (d: Device) => now() - (d.lastSeen ?? d.addedAt) >= idleForMs;
  const takeBackIdle = async () => {
    for (const d of Array.from(devices.values()).filter(idle)) {
      log.info(`vibevalley: user: "${d.name}" unused for 90 days, its key taken back`);
      await revoke(d.id);
    }
  };
  tasks.run("sweep", async (signal) => {
    for (;;) {
      await takeBackIdle();
      await clock.sleep(sweepEveryMs, signal);
    }
  });

  return {
    status,
    rename: async (given) => {
      const next = tidyName(given);
      await accountQ.setUserName(db.sql, { name: next });
      name = next;
      return status({ here: true });
    },
    setPassword: async (caller, password) => {
      if (!caller.here) throw refuse(t("server.user.passwordHere"));
      if ([...password].length < passwordMin) throw refuse(t("server.user.passwordShort", { n: passwordMin }));
      const stored = await hashPassword(password);
      await accountQ.setUserPassword(db.sql, { password_hash: stored, password_set_at: now() });
      passwordHash = stored;
      wrong = 0;
      lockedUntil = 0;
      log.info("vibevalley: user: the password is set");
      return status(caller);
    },
    login: (password, device) =>
      signing.with(async () => {
        if (passwordHash === undefined) throw refuse(t("server.user.noPassword"));
        if (now() < lockedUntil) throw refuse(t("server.user.locked", { s: Math.ceil((lockedUntil - now()) / 1000) }));
        if (!(await checkPassword(password, passwordHash))) {
          wrong++;
          if (wrong >= wrongTries) {
            wrong = 0;
            lockedUntil = now() + lockedForMs;
            log.info("vibevalley: user: too many wrong passwords, sign-in is locked for a while");
          }
          throw refuse(t("server.user.wrongPassword"));
        }
        wrong = 0;
        return addDevice(device, "login");
      }),
    logout: async (caller) => {
      if (caller.device === undefined) throw refuse(t("server.user.notADevice"));
      await revoke(caller.device);
    },
    pair: (given) => addDevice(given, "paired"),
    devices: listed,
    byKey: (key) => {
      if (key === "") return undefined;
      const matches = sameSecret(keyHash(key));
      const found = Array.from(devices.values()).find((d) => matches(d.keyHash));
      if (found === undefined) return undefined;
      if (idle(found)) {
        tasks.run("revoke", () => revoke(found.id));
        return undefined;
      }
      const at = now();
      found.lastSeen = at;
      if (at - found.written >= seenEveryMs) {
        found.written = at;
        tasks.run("seen", () => q.seenUserDevice(db.sql, { last_seen: at, id: found.id }));
      }
      return shown(found);
    },
    revoke,
    request: async (caller, given) => {
      if (live().length >= requestsAtOnce) throw refuse(t("server.user.requestsBusy"));
      const tidy = tidyName(given);
      const claim = randomBytes(32).toString("base64url");
      const r: Request = {
        id: newId(),
        code: requestCode(),
        name: tidy === "" ? t("server.user.aDevice") : tidy,
        from: caller.here ? "" : (caller.from ?? ""),
        askedAt: now(),
        expiresAt: now() + requestForMs,
        claimHash: keyHash(claim),
        approved: false,
        every: collectEverySeconds,
        lastCollect: Number.NEGATIVE_INFINITY,
      };
      waiting.set(r.id, r);
      log.info(`vibevalley: user: "${r.name}" asks to sign in (${r.code})`);
      return { code: r.code, claim, expiresAt: r.expiresAt, every: collectEverySeconds };
    },
    collect: async (claim) => {
      live();
      const matches = sameSecret(keyHash(claim));
      const r = Array.from(waiting.values()).find((w) => matches(w.claimHash));
      if (r === undefined) throw refuse(t("server.user.requestGone"));
      if (!r.approved) {
        const tooSoon = now() - r.lastCollect < r.every * 1000 * collectSlack;
        r.lastCollect = now();
        if (!tooSoon) return {};
        r.every += slowDownSeconds;
        return { every: r.every };
      }
      // Persist the device only on collection so abandoned approvals leave no row behind.
      waiting.delete(r.id);
      return { login: await addDevice(r.name, "login") };
    },
    requests: live,
    answerRequest: async (id, allow) => {
      live();
      const r = waiting.get(id);
      if (r === undefined) throw refuse(t("server.user.requestGone"));
      if (allow) r.approved = true;
      else waiting.delete(id);
      log.info(`vibevalley: user: "${r.name}" (${r.code}) ${allow ? "approved" : "refused"}`);
      return live();
    },
    previewRevoke: async (id) => {
      const d = known(id);
      return { does: [t("server.user.revoke", { name: d.name })] };
    },
    revoked: async function* (signal) {
      using heard = revokes.subscribe();
      for (;;) {
        const next = await heard.next(signal);
        if (next.done === true) return;
        yield next.value;
      }
    },
    close: async () => {
      await tasks.close();
      revokes.end();
    },
  };
}
