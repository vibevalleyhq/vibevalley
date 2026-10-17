/**
 * Nothing in server/internal is kept alive by its tests alone: deadcode lists the functions no `main` reaches, and any of
 * them fails the check. Exempt: generated code (gen.go, whose union codecs cover every member) and the test kits (testkit,
 * golden), which only tests import. The libraries in server/pkg are meant to be used elsewhere and are not checked. Run as
 * `bun run go:deadcode`.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const server = resolve(import.meta.dirname, '..', 'server')
const EXEMPT = /^internal\/(testkit|golden)\/|^internal\/protocol\/gen\.go:/

const out = execFileSync('go', ['run', 'golang.org/x/tools/cmd/deadcode@v0.52.0', './...'], { cwd: server, encoding: 'utf8' })
const dead = out.split('\n').filter((line) => line.startsWith('internal/') && !EXEMPT.test(line))
for (const line of dead) console.error(`deadcode: server/${line}`)
if (dead.length > 0) process.exit(1)
console.log('deadcode: server/internal ok')
