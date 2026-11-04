// A write a test makes fail, as a full disk would: a trigger that raises. SQLite takes back everything a failed
// transaction wrote, a count of the tries too, so a test that waits for a try listens for it in the log instead
// (heard): the work that goes on without the write says the trigger's name there (log.ts's bestEffort).

import { Cause, Effect, Logger } from "effect";
import type { SqlClient } from "effect/sql";

/** A trigger named name refusing the write on says (before insert on t, before update of c on t), when when holds. */
export const refuse = (sql: SqlClient.SqlClient, name: string, on: string, when = "") =>
  sql.unsafe(`create trigger ${name} ${on} for each row ${when ? `when ${when}` : ""} begin select raise(abort, '${name}'); end`).pipe(Effect.orDie);

export const allow = (sql: SqlClient.SqlClient, name: string) => sql.unsafe(`drop trigger ${name}`).pipe(Effect.orDie);

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
