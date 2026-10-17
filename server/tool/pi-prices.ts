/**
 * pi's price list, for the Go server: internal/runtime/pi_prices.json, one row per model pi knows, [provider, id, input,
 * output, cacheRead, cacheWrite] in dollars per million tokens. The TypeScript server read these from pi's model
 * registry in process (@earendil-works/pi-coding-agent's ModelRuntime, which builds on @earendil-works/pi-ai's
 * MODELS); smith runs pi in a separate Node host and has no price list, so the Go server embeds this one. Run it again
 * when pi updates:
 *
 *   cd server/tool && pnpm install && pnpm pi-prices
 */

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// MODELS is not in pi-ai's exports map: read the generated file the package's own registry is built from, in the
// version this package depends on (run from server/tool).
const root = join(process.cwd(), 'node_modules', '@earendil-works', 'pi-ai')
const { MODELS } = (await import(pathToFileURL(join(root, 'dist', 'models.generated.js')).href)) as {
  MODELS: Record<string, Record<string, { id: string; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } }>>
}

const rows: [string, string, number, number, number, number][] = []
for (const provider of Object.keys(MODELS).sort())
  for (const model of Object.values(MODELS[provider] ?? {}).sort((a, b) => a.id.localeCompare(b.id))) {
    const c = model.cost
    if (c) rows.push([provider, model.id, c.input, c.output, c.cacheRead, c.cacheWrite])
  }

const out = resolve(import.meta.dirname, '../internal/runtime/pi_prices.json')
writeFileSync(out, `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`)
console.log(`${rows.length} prices → ${out}`)
