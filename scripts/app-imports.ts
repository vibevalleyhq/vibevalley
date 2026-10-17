/**
 * The client's layers, and the one rule that keeps them layers: an import goes down, never up or sideways. Ranks are
 * the order in `app/lib`; `desk` and `farm` are the two skins, `village` draws the farm for them, `phone` is the phone
 * inside the farm, `app` only composes and `shell` is the frame around everything.
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
  desk: 9,
  farm: 9,
  shell: 10,
  app: 11,
}

interface Edge {
  from: string
  to: string
  file: string
  line: number
}

const files = globSync('lib/**/*.dart', { cwd: root })
const edges: Edge[] = []
const importLine = /import\s+'([^']+)'/g
for (const file of files) {
  const layer = file.split('/')[1]
  if (!(layer in RANK)) continue
  const lines = readFileSync(resolve(root, file), 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    for (const match of line.matchAll(importLine)) {
      const spec = match[1]
      let target: string
      if (spec.startsWith('package:vibevalley/')) target = spec.slice('package:vibevalley/'.length).split('/')[0]
      else if (spec.startsWith('.')) {
        const path = normalize(resolve(root, dirname(file), spec))
        target = relative(resolve(root, 'lib'), path).split('/')[0]
      } else continue
      if (!(target in RANK) || target === layer) continue
      if (RANK[target] >= RANK[layer]) edges.push({ from: layer, to: target, file, line: i + 1 })
    }
  }
}

for (const e of edges) {
  console.error(`app-imports: ${e.file}:${e.line}: ${e.from} -> ${e.to} goes up the layers (${e.to} must sit below ${e.from})`)
}
if (edges.length > 0) process.exit(1)
console.log(`app-imports: ${files.length} files ok`)
