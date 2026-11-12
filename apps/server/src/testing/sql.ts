import type { Db, Row } from "#/infra/db.ts";

/** A test's own statements on the farm's database, written as a template: each value is a parameter ($1, $2…). */
export function sqlOf(db: Db) {
  const tag = <R extends Row = Row>(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<readonly R[]> => {
    const text = strings.reduce((all, part, i) => all + (i === 0 ? "" : `$${i}`) + part, "");
    // A test reads back the columns it named: the rows are as the driver gives them.
    return db.sql.query(text, values) as Promise<readonly R[]>;
  };
  return Object.assign(tag, {
    /** One statement as it is written, no parameters. */
    unsafe: <R extends Row = Row>(text: string, params: readonly unknown[] = []) => db.sql.query(text, params) as Promise<readonly R[]>,
  });
}
