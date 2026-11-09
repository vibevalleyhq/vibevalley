import { existsSync, mkdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SqliteClient } from "@effect/sql-sqlite-node";
import { type Cause, Clock, Context, Duration, Effect, Layer, Metric, Option } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

import { messageOf } from "#/base/errors.ts";

import { baselineHash, baselineStatements } from "./baseline.ts";
import { dbDir, ServerConfig } from "./config.ts";

/** Every query run: what a test holds a hot path's budget to, and a reading of the farm's load. */
export const dbQueries = Metric.counter("vibevalley.db.queries", { description: "Queries run on the database", incremental: true });

/** Longer than this, a transaction is said in the log: everything else waited for it. */
const txLongMs = 500;

/** The database's file in its folder. */
export const dbFile = "vibevalley.db";

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

/** The database as an SqlClient, with the schema in place and foreign keys on. */
export const Database = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const where = dbDir(config);
    const memory = where === "memory";
    const hash = baselineHash();
    let fresh = memory;
    if (!memory) {
      const now = yield* Clock.currentTimeMillis;
      const aside = setAsideStale(where, hash, now);
      if (aside) yield* Effect.logWarning(`vibevalley: the database was made from another schema; it is set aside at ${aside} and a new one is made`);
      fresh = !existsSync(join(where, dbFile));
      mkdirSync(where, { recursive: true });
    }
    const ready = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Off by default in SQLite, and only settable outside a transaction.
        yield* sql.unsafe("PRAGMA foreign_keys = ON");
        if (fresh) yield* sql.withTransaction(Effect.forEach(baselineStatements(), (statement) => sql.unsafe(statement), { discard: true }));
        if (!memory) writeFileSync(where + ".schema", hash + "\n");
      }),
    );
    return ready.pipe(Layer.provideMerge(SqliteClient.layer({ filename: memory ? ":memory:" : join(where, dbFile), disableWAL: memory })));
  }),
).pipe(Layer.orDie);

/** What the database said, from under the SqlError around it. */
export function causeMessage(e: unknown): string {
  let at: unknown = e;
  let said = messageOf(e);
  while (at instanceof Error && at.cause !== undefined) {
    at = at.cause;
    if (at instanceof Error && at.message) said = at.message;
  }
  return said;
}

/** The farm's database as the services use it: a generated query (db/generated) run against it. */
export class Db extends Context.Service<
  Db,
  {
    readonly run: <A, E>(query: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A>;
    readonly attempt: <A, E>(query: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A, E>;
    /** The one row, or undefined when there is none. Only no row is none: a query that fails is still a defect. */
    readonly one: <A, E>(query: Effect.Effect<A, E | Cause.NoSuchElementError, SqlClient.SqlClient>) => Effect.Effect<A | undefined>;
    /** work in one transaction; the database's own failure is a defect, work's other failures stay. */
    readonly inTx: <A, E>(work: Effect.Effect<A, E>) => Effect.Effect<A, Exclude<E, { _tag: "SqlError" }>>;
    /** work in one transaction, its queries' failures and the commit's kept: what a caller tells as a refusal. */
    readonly attemptTx: <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A, E | SqlError.SqlError>;
  }
>()("@vibevalley/server/infra/db") {
  static readonly layer = Layer.effect(
    Db,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Every query passes through these: a span each would bury the traces, and the caller's span already says what it was for.
      const attempt = Effect.fnUntraced(function* <A, E>(query: Effect.Effect<A, E, SqlClient.SqlClient>): Effect.fn.Return<A, E> {
        yield* Metric.update(dbQueries, 1);
        return yield* Effect.provideService(query, SqlClient.SqlClient, sql);
      });
      const run = Effect.fnUntraced(function* <A, E>(query: Effect.Effect<A, E, SqlClient.SqlClient>): Effect.fn.Return<A> {
        return yield* Effect.orDie(attempt(query));
      });
      // One connection: a transaction holds every other query until it ends.
      const held = <A, E, R>(tx: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const [took, a] = yield* Effect.timed(tx);
          if (Duration.toMillis(took) > txLongMs) yield* Effect.logWarning(`vibevalley: a transaction held the database ${Duration.format(took)}`);
          return a;
        });
      return Db.of({
        run,
        attempt,
        one: Effect.fnUntraced(function* <A, E>(query: Effect.Effect<A, E | Cause.NoSuchElementError, SqlClient.SqlClient>): Effect.fn.Return<A | undefined> {
          const outcome = yield* run(Effect.catchNoSuchElement(query));
          return Option.getOrUndefined(outcome);
        }),
        inTx: Effect.fnUntraced(function* <A, E>(work: Effect.Effect<A, E>): Effect.fn.Return<A, Exclude<E, { _tag: "SqlError" }>> {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- catchTag takes SqlError out of E; TypeScript cannot work that out for a generic E
          return yield* held(sql.withTransaction(work)).pipe(Effect.catchTag("SqlError", Effect.die)) as Effect.Effect<A, Exclude<E, { _tag: "SqlError" }>>;
        }),
        attemptTx: Effect.fnUntraced(function* <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>): Effect.fn.Return<A, E | SqlError.SqlError> {
          return yield* sql.withTransaction(work).pipe(held, attempt);
        }),
      });
    }),
  );
}
