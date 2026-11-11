import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

import { type Clock, Semaphore } from "@vibevalley/async";

import { messageOf } from "#/base/errors.ts";

import { baselineHash, baselineSql, baselineStatements } from "./baseline.ts";
import { dbDir, type ServerConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import { counter } from "./metrics.ts";

/** Every query run: what a test holds a hot path's budget to, and a reading of the farm's load. */
export const dbQueries = counter("vibevalley.db.queries");

/** Longer than this, a transaction is said in the log: everything else waited for it. */
const txLongMs = 500;

/** A row as the driver gives it: column name to value (numbers, text, booleans, null; no bigint, see 0001_schema.up.sql). */
export type Row = Readonly<Record<string, unknown>>;

/** What a generated query (db/generated) runs against: the farm's database, or the transaction under way. */
export interface Sql {
  /** The rows of one statement, its parameters as $1, $2… */
  readonly query: (text: string, params?: readonly unknown[]) => Promise<readonly Row[]>;
  /** One statement for what it changes: how many rows. */
  readonly exec: (text: string, params?: readonly unknown[]) => Promise<number>;
}

/** The database failed a statement: what it said, with the statement's first words. */
export class SqlError extends Error {
  override readonly name = "SqlError";
}

/** What the database said, from under the errors around it. */
export function causeMessage(e: unknown): string {
  let at: unknown = e;
  let said = messageOf(e);
  while (at instanceof Error && at.cause !== undefined) {
    at = at.cause;
    if (at instanceof Error && at.message) said = at.message;
  }
  return said;
}

/** The farm's database as the services use it. */
export interface Db extends AsyncDisposable {
  /** The database, or the transaction this call is inside of: a generated query is always handed db.sql. */
  readonly sql: Sql;
  /** work in one transaction: committed when it returns, rolled back when it throws (what it threw goes on). Inside
   * another one it is a savepoint of it. One connection: everything else waits for the outermost one. */
  readonly tx: <A>(work: () => Promise<A>) => Promise<A>;
  /** hook right after the outermost transaction this call is inside of commits (dropped if it rolls back); at once when
   * outside one. */
  readonly afterCommit: (hook: () => Promise<void> | void) => Promise<void>;
  readonly close: () => Promise<void>;
}

/** The one connection, as either driver gives it. */
interface Driver {
  readonly query: (text: string, params: readonly unknown[]) => Promise<{ readonly rows: readonly Row[]; readonly changed: number }>;
  readonly script: (text: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

const pgliteDriver = (db: PGlite): Driver => ({
  query: async (text, params) => {
    const r = await db.query<Row>(text, [...params]);
    return { rows: r.rows, changed: r.affectedRows ?? 0 };
  },
  script: async (text) => {
    await db.exec(text);
  },
  close: () => db.close(),
});

const pgDriver = (client: pg.Client): Driver => ({
  query: async (text, params) => {
    const r = await client.query<Row>(text, [...params]);
    return { rows: r.rows, changed: r.rowCount ?? 0 };
  },
  script: async (text) => {
    await client.query(text);
  },
  close: () => client.end(),
});

/** A transaction under way: the hooks waiting for its commit; open until it ends (a task it started that runs on after
 * it is no longer inside it). */
interface TxScope {
  open: boolean;
  readonly hooks: (() => Promise<void> | void)[];
  readonly depth: number;
}

/** The Db over one driver: the lock that makes it one connection, transactions, after-commit hooks. */
export function dbOver(driver: Driver, log: Logger, clock: Clock): Db {
  const lock = new Semaphore(1);
  const scope = new AsyncLocalStorage<TxScope>();
  let savepoints = 0;
  const inside = () => {
    const s = scope.getStore();
    return s?.open === true ? s : undefined;
  };
  const run = async (text: string, params: readonly unknown[]) => {
    dbQueries.add();
    try {
      return await driver.query(text, params);
    } catch (e) {
      throw new SqlError(`${causeMessage(e)} (in: ${text.replace(/\s+/gu, " ").slice(0, 80)})`, { cause: e });
    }
  };
  const statement = (text: string, params: readonly unknown[] = []) => (inside() ? run(text, params) : lock.with(() => run(text, params)));
  const sql: Sql = {
    query: async (text, params) => (await statement(text, params)).rows,
    exec: async (text, params) => (await statement(text, params)).changed,
  };
  const tx = async <A>(work: () => Promise<A>): Promise<A> => {
    const outer = inside();
    if (outer !== undefined) {
      const name = `sp_${++savepoints}`;
      const own: TxScope = { open: true, hooks: [], depth: outer.depth + 1 };
      await run(`savepoint ${name}`, []);
      try {
        const a = await scope.run(own, work);
        await run(`release savepoint ${name}`, []);
        outer.hooks.push(...own.hooks);
        return a;
      } catch (e) {
        await run(`rollback to savepoint ${name}`, []);
        throw e;
      } finally {
        own.open = false;
      }
    }
    const own: TxScope = { open: true, hooks: [], depth: 0 };
    const a = await lock.with(async () => {
      const started = clock.now();
      await run("begin", []);
      let a: A;
      try {
        a = await scope.run(own, work);
        own.open = false;
        await run("commit", []);
      } catch (e) {
        own.open = false;
        await run("rollback", []).catch(() => undefined);
        throw e;
      } finally {
        const took = clock.now() - started;
        if (took > txLongMs) log.warn(`a transaction held the database ${took} ms`);
      }
      return a;
    });
    // After the commit and the lock: a hook may query the database (outside any transaction), as the next writer may.
    for (const hook of own.hooks) await scope.exit(hook);
    return a;
  };
  const close = async () => {
    await lock.with(() => driver.close());
  };
  return {
    sql,
    tx,
    afterCommit: async (hook) => {
      const s = inside();
      if (s !== undefined) s.hooks.push(hook);
      else await hook();
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}

/** A folder's database made from another baseline is moved aside, whole, to <folder>.<hash>-<time>. The baseline it was made from is in <folder>.schema. */
export function setAsideStale(where: string, hash: string, now: number): string | undefined {
  const mark = where + ".schema";
  if (!existsSync(where) || !existsSync(mark)) return undefined;
  const was = readFileSync(mark, "utf8").trim();
  if (was === hash) return undefined;
  const aside = `${where}.${was || "unknown"}-${now}`;
  renameSync(where, aside);
  renameSync(mark, aside + ".schema");
  return aside;
}

/** The database could not be opened or given its schema: the farm does not start. */
export class Unopened extends Error {
  override readonly name = "Unopened";
}

/** The baseline a Postgres of the user's was made from, kept in it: that database is never moved aside or emptied here. */
const baselineTable = "vibevalley_baseline";

const made = async (driver: Driver) => {
  for (const statement of baselineStatements()) await driver.query(statement, []);
};

/** A Postgres at database.url: an empty one is given the schema; one made from another baseline is refused, not changed. */
async function external(url: string): Promise<Driver> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const driver = pgDriver(client);
  try {
    const hash = baselineHash();
    const kept = await driver.query(`select hash from ${baselineTable}`, []).catch(() => undefined);
    const kept0 = kept?.rows[0]?.["hash"];
    const was = typeof kept0 === "string" ? kept0 : undefined;
    if (was === hash) return driver;
    if (was !== undefined)
      throw new Unopened(`the database at database.url was made from another schema (${was}, this is ${hash}); point database.url at an empty database`);
    const tables = await driver.query(`select count(*)::int as n from information_schema.tables where table_schema = 'public'`, []);
    if (Number(tables.rows[0]?.["n"] ?? 0) > 0)
      throw new Unopened("the database at database.url has tables of its own; point database.url at an empty database");
    await driver.script("begin");
    try {
      await made(driver);
      await driver.query(`create table ${baselineTable} (hash text not null)`, []);
      await driver.query(`insert into ${baselineTable} values ($1)`, [hash]);
      await driver.script("commit");
    } catch (e) {
      await driver.script("rollback");
      throw e;
    }
    return driver;
  } catch (e) {
    await driver.close();
    throw e;
  }
}

/** A database in memory made once with the schema, copied for each one asked for: a new PGlite starts a whole Postgres
 * (most of a second), a copy of one loads in a tenth of that. Two asking at once may each make it; both copies serve. */
let template: Blob | undefined;
async function schemaCopy(): Promise<Blob> {
  if (template !== undefined) return template;
  const db = new PGlite();
  try {
    await db.exec(baselineSql());
    template = await db.dumpDataDir("none");
    return template;
  } catch (cause) {
    throw new Unopened("the schema could not be made in memory", { cause });
  } finally {
    await db.close();
  }
}

/** The database with the schema in place: Postgres at database.url, or else PGlite in the home (in memory for "memory").
 * One connection either way: the services write one at a time. */
export async function openDb(config: ServerConfig, log: Logger, clock: Clock): Promise<Db> {
  const url = config.database.url.reveal();
  if (url !== "") return dbOver(await external(url), log, clock);
  const where = dbDir(config);
  if (where === "memory") return dbOver(pgliteDriver(await PGlite.create({ loadDataDir: await schemaCopy() })), log, clock);
  const hash = baselineHash();
  const aside = setAsideStale(where, hash, clock.now());
  if (aside) log.warn(`the database was made from another schema; it is set aside at ${aside} and a new one is made`);
  const fresh = !existsSync(where);
  mkdirSync(where, { recursive: true });
  const driver = pgliteDriver(await PGlite.create({ dataDir: where }));
  if (fresh) {
    await driver.script("begin");
    await made(driver);
    await driver.script("commit");
  }
  writeFileSync(where + ".schema", hash + "\n");
  return dbOver(driver, log, clock);
}
