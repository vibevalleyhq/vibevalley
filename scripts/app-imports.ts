/**
 * The client's layers, and the one rule that keeps them layers: an import goes down, never up or sideways. Ranks are
 * the order in `app/lib`; `workbench` and `farm` are the two skins, `village` draws the farm for them, `phone` is the phone
 * inside the farm, `app` only composes and `shell` is the frame around everything.
 *
 * A vendor's SDK stays in the one folder that adapts it (VENDOR): the rest of the client sees our own types.
 *
 * Two kits draw the two skins: `ui/pixel` the farm's, `ui/pro` the workbench's (KITS says who may use which); what both
 * share is in `ui/` itself. `shared` and `chat` hold state and rules for both skins, so they use neither kit.
 *
 * Run by `bun run flutter:check`; a bad edge names the file, the line, and both ends.
 */

import { globSync, readFileSync } from 'node:fs'
import { dirname, normalize, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../app')
const RANK: Record<string, number> = {
  gen: 0,
  sprites: 0,
  audio: 0,
  rules: 1,
  voice: 1,
  ui: 2,
  data: 3,
  host: 4,
  game: 4,
  shared: 5,
  chat: 6,
  phone: 7,
  debug: 7,
  village: 8,
  title: 9,
  workbench: 9,
  farm: 9,
  shell: 10,
  app: 11,
}

// Agora is one way to make a call: only lib/voice talks to its SDK.
const VENDOR: Record<string, string> = {
  agora_rtc_engine: 'lib/voice/',
}

// Which layers may import each kit. ui/pixel and ui/pro themselves are kits; plain ui/ is shared and uses neither.
const KITS: Record<'pixel' | 'pro', string[]> = {
  pixel: ['farm', 'village', 'title', 'phone', 'debug', 'shell', 'app', 'ui/pixel'],
  pro: ['workbench', 'shell', 'app', 'ui/pro'],
}

interface Edge {
  from: string
  to: string
  file: string
  line: number
}

const files = globSync('lib/**/*.dart', { cwd: root })
const edges: Edge[] = []
const strays: string[] = []
const importLine = /import\s+'([^']+)'/g
const kitBreaks: string[] = []
const ownerOf = (file: string) => (file.startsWith('lib/ui/pixel/') ? 'ui/pixel' : file.startsWith('lib/ui/pro/') ? 'ui/pro' : file.split('/')[1])
for (const file of files) {
  const layer = file.split('/')[1]
  if (!(layer in RANK)) continue
  const owner = ownerOf(file)
  const lines = readFileSync(resolve(root, file), 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    for (const match of line.matchAll(importLine)) {
      const spec = match[1]
      const vendor = spec.startsWith('package:') ? spec.slice('package:'.length).split('/')[0] : ''
      if (vendor in VENDOR && !file.startsWith(VENDOR[vendor])) {
        strays.push(`app-imports: ${file}:${i + 1}: ${vendor} only belongs in ${VENDOR[vendor]}`)
      }
      let path: string
      if (spec.startsWith('package:vibevalley/')) path = spec.slice('package:vibevalley/'.length)
      else if (spec.startsWith('.')) path = relative(resolve(root, 'lib'), normalize(resolve(root, dirname(file), spec)))
      else continue
      const target = path.split('/')[0]
      const kit = path.startsWith('ui/pixel/') ? 'pixel' : path.startsWith('ui/pro/') ? 'pro' : null
      if (kit && !KITS[kit].includes(owner)) {
        kitBreaks.push(`app-imports: ${file}:${i + 1}: ${owner} may not use the ${kit} kit (ui/${kit}); only ${KITS[kit].join(', ')} may`)
      }
      if (!(target in RANK) || target === layer) continue
      if (RANK[target] >= RANK[layer]) edges.push({ from: layer, to: target, file, line: i + 1 })
    }
  }
}

for (const e of edges) {
  console.error(`app-imports: ${e.file}:${e.line}: ${e.from} -> ${e.to} goes up the layers (${e.to} must sit below ${e.from})`)
}
for (const s of strays) console.error(s)
for (const k of kitBreaks) console.error(k)
if (edges.length > 0 || strays.length > 0 || kitBreaks.length > 0) process.exit(1)
console.log(`app-imports: ${files.length} files ok`)
