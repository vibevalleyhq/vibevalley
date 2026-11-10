import { Cause, Effect, Logger } from "effect";
import type { SqlClient } from "effect/sql";

/** A trigger named name refusing the write on says (before insert on t, before update of c on t), when when holds
 * (a condition on NEW); the write fails with says. */
export const refuse = (sql: SqlClient.SqlClient, name: string, on: string, when = "", says = name) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception '${says.replaceAll("'", "''")}'; end $$`);
    yield* sql.unsafe(`create trigger ${name} ${on} for each row ${when ? `when (${when})` : ""} execute function ${name}()`);
  }).pipe(Effect.orDie);

/** The write refuse stopped goes through again. */
export const allow = (sql: SqlClient.SqlClient, name: string) =>
  Effect.gen(function* () {
    const on = yield* sql<{ readonly table: string }>`select tgrelid::regclass::text as table from pg_trigger where tgname = ${name}`;
    for (const { table } of on) yield* sql.unsafe(`drop trigger ${name} on ${table}`);
    yield* sql.unsafe(`drop function ${name}()`);
  }).pipe(Effect.orDie);

/** The lines the farm logs from here on, each with its cause; layer is given to what builds the farm. */
export function heard() {
  const lines: string[] = [];
  const logger = Logger.make(({ message, cause }) => {
    lines.push([...(Array.isArray(message) ? message : [message]).map(String), Cause.pretty(cause)].join(" "));
  });
  return {
    lines,
    /** How many lines name it. */
    count: (name: string) => lines.filter((line) => line.includes(name)).length,
    layer: Logger.layer([logger], { mergeWithExisting: true }),
  };
}
