import type { Db, Sql } from "#/infra/db.ts";

const sqlOf = (on: Db | Sql): Sql => ("tx" in on ? on.sql : on);

/** A trigger named name refusing the write on says (before insert on t, before update of c on t), when when holds
 * (a condition on NEW); the write fails with says. */
export async function refuse(db: Db | Sql, name: string, on: string, when = "", says = name): Promise<void> {
  const sql = sqlOf(db);
  await sql.exec(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception '${says.replaceAll("'", "''")}'; end $$`);
  await sql.exec(`create trigger ${name} ${on} for each row ${when ? `when (${when})` : ""} execute function ${name}()`);
}

/** The write refuse stopped goes through again. */
export async function allow(db: Db | Sql, name: string): Promise<void> {
  const sql = sqlOf(db);
  const on = await sql.query(`select tgrelid::regclass::text as table from pg_trigger where tgname = $1`, [name]);
  for (const row of on) await sql.exec(`drop trigger ${name} on ${String(row["table"])}`);
  await sql.exec(`drop function ${name}()`);
}
