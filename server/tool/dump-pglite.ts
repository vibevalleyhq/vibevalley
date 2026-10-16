// Dumps the TypeScript server's database (PGlite, $VIBEVALLEY_HOME/db) to JSON, for `vibevalley import` (farm/import.go):
// every table in the public schema, every row, plus where each identity sequence stands. The data folder is copied to
// a temporary one first and that copy is opened, so the farm's own database is never touched, even while its server
// runs.
//
//	node server/tool/dump-pglite.ts <ts-home> [out.json]     # default out: <ts-home>/pglite-dump.json
//
// The dump, version 1: { format: "heybro-pglite-dump", version, tables: { <name>: { columns: [{name, type}], rows } },
// sequences: { "<table>.<column>": last value handed out } }. Values: timestamptz → milliseconds since the epoch,
// jsonb → the JSON value itself, boolean → true/false, integers → numbers, text → strings, null → null. Rows are
// ordered by the primary key. It holds the connectors' secrets: it is written 0600 and never printed.

import { PGlite } from '@electric-sql/pglite'
import { cp, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface Column {
  readonly name: string
  readonly type: string
}

const [homeArg, outArg] = process.argv.slice(2)
if (!homeArg) {
  console.error('usage: node dump-pglite.ts <ts-home> [out.json]')
  process.exit(2)
}
const home = resolve(homeArg)
const dataDir = join(home, 'db')
const out = resolve(outArg ?? join(home, 'pglite-dump.json'))

try {
  await stat(join(dataDir, 'PG_VERSION'))
} catch {
  console.error(`no PGlite database at ${dataDir}`)
  process.exit(1)
}

const scratch = await mkdtemp(join(tmpdir(), 'heybro-pglite-'))
try {
  await cp(dataDir, join(scratch, 'db'), { recursive: true })
  // A copy taken while the server ran may hold its lock file; the copy is ours alone.
  await rm(join(scratch, 'db', 'postmaster.pid'), { force: true })
  const db = await PGlite.create(join(scratch, 'db'))
  const tableNames = (
    await db.query<{ name: string }>(
      `select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    )
  ).rows.map((r) => r.name)

  const tables: Record<string, { columns: Column[]; rows: Record<string, unknown>[] }> = {}
  const sequences: Record<string, number> = {}
  for (const table of tableNames) {
    const columns = (
      await db.query<Column & { identity: string }>(
        `select column_name as name, data_type as type, is_identity as identity from information_schema.columns
         where table_schema = 'public' and table_name = $1 order by ordinal_position`,
        [table],
      )
    ).rows
    const keys = (
      await db.query<{ name: string }>(
        `select a.attname as name from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = $1::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`,
        [`public.${quote(table)}`],
      )
    ).rows.map((r) => quote(r.name))
    const order = keys.length ? ` order by ${keys.join(', ')}` : ''
    const rows = (await db.query<Record<string, unknown>>(`select * from public.${quote(table)}${order}`)).rows
    tables[table] = {
      columns: columns.map(({ name, type }) => ({ name, type })),
      rows: rows.map((row) => Object.fromEntries(columns.map((c) => [c.name, plain(row[c.name])]))),
    }
    for (const c of columns.filter((c) => c.identity === 'YES')) {
      const seq = (await db.query<{ seq: string | null }>(`select pg_get_serial_sequence($1, $2) as seq`, [`public.${quote(table)}`, c.name])).rows[0]?.seq
      if (!seq) continue
      const at = (await db.query<{ last: number | string; called: boolean }>(`select last_value as last, is_called as called from ${seq}`)).rows[0]
      // Not yet called: nothing handed out, the next is last_value itself.
      if (at) sequences[`${table}.${c.name}`] = at.called ? Number(at.last) : Number(at.last) - 1
    }
  }
  await db.close()

  const dump = { format: 'heybro-pglite-dump', version: 1, source: home, dumpedAt: Date.now(), tables, sequences }
  await writeFile(out, JSON.stringify(dump), { mode: 0o600 })
  const counts = Object.entries(tables)
    .map(([name, t]) => `${name} ${t.rows.length}`)
    .join(', ')
  console.log(`dumped ${home}/db to ${out}: ${counts}`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** A value as JSON carries it: dates as milliseconds, 64-bit integers as numbers. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'bigint') return Number(value)
  return value
}
