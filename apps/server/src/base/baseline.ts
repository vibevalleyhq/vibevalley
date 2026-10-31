// The database's baseline (db/migrations/0001_schema.up.sql) and its hash, which a database is marked with
// (<folder>.schema): a database made from another one is set aside (db.ts). The desktop's package script reads it too, to
// say in a release whether it starts a new farm; so this file imports nothing of the server's.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const baselineFile = resolve(import.meta.dirname, "../../db/migrations/0001_schema.up.sql");
export const baselineSql = () => readFileSync(baselineFile, "utf8");
export const baselineHash = () => createHash("sha256").update(baselineSql()).digest("hex").slice(0, 16);
