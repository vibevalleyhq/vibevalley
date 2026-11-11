import { existsSync, mkdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";

import { PgClient } from "@effect/sql-pg";
import { PgliteClient } from "@effect/sql-pglite";
import { PGlite } from "@electric-sql/pglite";
import { type Cause, Clock, Context, Duration, Effect, Layer, Metric, Option, Redacted, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

import { messageOf } from "#/base/errors.ts";

import { baselineHash, baselineSql, baselineStatements } from "./baseline.ts";
import { dbDir, ServerConfig } from "./config.ts";

/** Every query run: what a test holds a hot path's budget to, and a reading of the farm's load. */
export const dbQueries = Metric.counter("vibevalley.db.queries", { description: "Queries run on the database", incremental: true });

/** Longer than this, a transaction is said in the log: everything else waited for it. */
const txLongMs = 500;

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
class Unopened extends Schema.TaggedError<Unopened, { readonly brand: unique symbol }>()("Unopened", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** The baseline a Postgres of the user's was made from, kept in it: that database is never moved aside or emptied here. */
const baselineTable = "vibevalley_baseline";

const made = (sql: SqlClient.SqlClient) => Effect.forEach(baselineStatements(), (statement) => sql.unsafe(statement), { discard: true });

/** A Postgres at database.url: an empty one is given the schema; one made from another baseline is refused, not changed. */
const external = (url: Redacted.Redacted) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const hash = baselineHash();
      const kept = yield* sql<{ readonly hash: string }>`select hash from ${sql(baselineTable)}`.pipe(Effect.catchTag("SqlError", () => Effect.undefined));
      const was = kept?.[0]?.hash;
      if (was === hash) return;
      if (was !== undefined)
        return yield* Unopened.make({
          message: `the database at database.url was made from another schema (${was}, this is ${hash}); point database.url at an empty database`,
        });
      const tables = yield* sql<{ readonly n: number }>`select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
      if ((tables[0]?.n ?? 0) > 0)
        return yield* Unopened.make({ message: "the database at database.url has tables of its own; point database.url at an empty database" });
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* made(sql);
          yield* sql`create table ${sql(baselineTable)} (hash text not null)`;
          yield* sql`insert into ${sql(baselineTable)} values (${hash})`;
        }),
      );
    }),
  ).pipe(Layer.provideMerge(PgClient.layer({ url, maxConnections: 1 })));

/** A database in memory made once with the schema, copied for each one asked for: a new PGlite starts a whole Postgres
 * (most of a second), a copy of one loads in a tenth of that. Two asking at once may each make it; both copies serve. */
let template: Blob | undefined;
const schemaCopy = Effect.suspend(() =>
  template !== undefined
    ? Effect.succeed(template)
    : Effect.gen(function* () {
        const made = yield* Effect.acquireRelease(
          Effect.sync(() => new PGlite()),
          (pg) => Effect.promise(() => pg.close()),
        );
        const unmade = (cause: unknown) => Unopened.make({ message: "the schema could not be made in memory", cause });
        yield* Effect.tryPromise({ try: () => made.exec(baselineSql()), catch: unmade });
        const dump = yield* Effect.tryPromise({ try: () => made.dumpDataDir("none"), catch: unmade });
        template = dump;
        return dump;
      }).pipe(Effect.scoped),
);

/** The database as an SqlClient, with the schema in place: Postgres at database.url, or else PGlite in the home (in
 * memory for "memory"). One connection either way: the services write one at a time. */
export const Database = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (Redacted.value(config.database.url) !== "") return external(config.database.url);
    const where = dbDir(config);
    if (where === "memory") {
      const copy = yield* schemaCopy;
      return PgliteClient.layer({ loadDataDir: copy });
    }
    const hash = baselineHash();
    const now = yield* Clock.currentTimeMillis;
    const aside = setAsideStale(where, hash, now);
    if (aside) yield* Effect.logWarning(`vibevalley: the database was made from another schema; it is set aside at ${aside} and a new one is made`);
    const fresh = !existsSync(where);
    mkdirSync(where, { recursive: true });
    const ready = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (fresh) yield* sql.withTransaction(made(sql));
        writeFileSync(where + ".schema", hash + "\n");
      }),
    );
    return ready.pipe(Layer.provideMerge(PgliteClient.layer({ dataDir: where })));
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

class TxCommit extends Context.Service<TxCommit, (effect: Effect.Effect<void>) => void>()("@vibevalley/server/infra/db/TxCommit") {}

/** The farm's database as the services use it: a generated query (db/generated) run against it. */
export class Db extends Context.Service<
  Db,
  {
    readonly run: <A, E>(query: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A>;
    readonly attempt: <A, E>(query: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A, E>;
    /** The one row, or undefined when there is none. Only no row is none: a query that fails is still a defect. */
    readonly one: <A, E>(query: Effect.Effect<A, E | Cause.NoSuchElementError, SqlClient.SqlClient>) => Effect.Effect<A | undefined>;
    /** Runs `effect` uninterruptibly right after the outermost surrounding transaction commits (or immediately when outside a transaction); dropped on rollback. */
    readonly afterCommit: (effect: Effect.Effect<void>) => Effect.Effect<void>;
    /** work in one transaction; the database's own failure is a defect, work's other failures stay. */
    readonly inTx: <A, E>(work: Effect.Effect<A, E>) => Effect.Effect<A, Exclude<E, { _tag: "SqlError" }>>;
    /** work in one transaction, its queries' failures (via `db.attempt`) and the commit's kept: what a caller tells as a refusal. */
    readonly attemptTx: <A, E>(work: Effect.Effect<A, E>) => Effect.Effect<A, E | SqlError.SqlError>;
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
      const commitTail = <A, E, R>(tx: Effect.Effect<A, E, R>, hooks: readonly Effect.Effect<void>[]) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const a = yield* restore(tx);
            if (hooks.length > 0) yield* Effect.forEach(hooks, (hook) => hook, { discard: true });
            return a;
          }),
        );
      const withHooks = <A, E, R, E2, R2>(
        runTx: (work: Effect.Effect<A, E, Exclude<R, TxCommit>>) => Effect.Effect<A, E2, R2>,
        work: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E2, R2> =>
        Effect.gen(function* () {
          const outer = yield* Effect.serviceOption(TxCommit);
          const hooks: Effect.Effect<void>[] = [];
          if (Option.isSome(outer)) {
            const a = yield* runTx(Effect.provideService(work, TxCommit, (effect) => void hooks.push(effect)));
            for (const hook of hooks) outer.value(hook);
            return a;
          }
          return yield* commitTail(runTx(Effect.provideService(work, TxCommit, (effect) => void hooks.push(effect))), hooks);
        });
      return Db.of({
        run,
        attempt,
        one: Effect.fnUntraced(function* <A, E>(query: Effect.Effect<A, E | Cause.NoSuchElementError, SqlClient.SqlClient>): Effect.fn.Return<A | undefined> {
          const outcome = yield* run(Effect.catchNoSuchElement(query));
          return Option.getOrUndefined(outcome);
        }),
        afterCommit: Effect.fnUntraced(function* (effect: Effect.Effect<void>): Effect.fn.Return<void> {
          const queue = yield* Effect.serviceOption(TxCommit);
          if (Option.isSome(queue)) queue.value(effect);
          else yield* effect;
        }),
        inTx: Effect.fnUntraced(function* <A, E>(work: Effect.Effect<A, E>): Effect.fn.Return<A, Exclude<E, { _tag: "SqlError" }>> {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- catchTag takes SqlError out of E; TypeScript cannot work that out for a generic E
          return yield* withHooks((w) => held(sql.withTransaction(w)), work).pipe(Effect.catchTag("SqlError", Effect.die)) as Effect.Effect<
            A,
            Exclude<E, { _tag: "SqlError" }>
          >;
        }),
        attemptTx: Effect.fnUntraced(function* <A, E>(work: Effect.Effect<A, E>): Effect.fn.Return<A, E | SqlError.SqlError> {
          return yield* withHooks((w) => held(sql.withTransaction(w)), work);
        }),
      });
    }),
  );
}
