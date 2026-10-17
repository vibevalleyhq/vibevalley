/**
 * Relative Markdown links in the maintained docs resolve to a file in the repository, and so does a source path in
 * `inline code` in the current docs (not the Notes, which are history). Run as part of `bun run docs:verify`; anything
 * broken exits 1. External links (http, mailto) are not fetched; `#fragment`s are not checked; links inside code blocks
 * and `inline code` are examples.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, globSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** The maintained Markdown: root files, docs, Agent Notes, skills and every package's README. */
const SOURCES = ['README.md', 'AGENTS.md', 'docs/**/*.md', '.agents/**/*.md', 'server/README.md', 'app/README.md', 'site/README.md']

const LINK = /\]\(([^)\s]+)\)/g

/** A path with a folder and a source file's extension; files in the owner's home (`manager/manager.jsonl`) have none of these. */
const CODE_PATH = /`((?:\.\.?\/)*[\w-][\w.-]*\/[\w./-]+\.(?:go|dart|ts|tsx|astro|sql|json|yaml|sh|py|gz))`/g

/** Tracked and new files: a path may be written from the repository root or from inside a package (`internal/core/core.go`). */
const repoFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n')
const inRepo = (path: string) => repoFiles.some((f) => (f === path || f.endsWith(`/${path}`)) && existsSync(resolve(root, f)))

const files = [...new Set(SOURCES.flatMap((pattern) => globSync(pattern, { cwd: root })))].sort()
const broken: string[] = []
for (const file of files) {
  let fenced = false
  for (const [i, line] of readFileSync(resolve(root, file), 'utf8').split('\n').entries()) {
    if (line.startsWith('```')) fenced = !fenced
    if (fenced) continue
    // Links inside `inline code` are examples, not links.
    for (const match of line.replace(/`[^`]*`/g, '').matchAll(LINK)) {
      const target = match[1] ?? ''
      if (/^[a-z]+:/.test(target) || target.startsWith('#')) continue
      const path = decodeURIComponent(target.split('#')[0] ?? '')
      const full = resolve(dirname(resolve(root, file)), path)
      if (!existsSync(full)) broken.push(`${file}:${i + 1}: ${target}`)
      // macOS and Windows find a file whatever the case; Linux and git do not. agents.md is not AGENTS.md.
      else if (realpathSync.native(full) !== realpathSync(full)) broken.push(`${file}:${i + 1}: ${target} (the file is ${realpathSync.native(full)})`)
    }
    if (file.startsWith('.agents/')) continue
    for (const match of line.matchAll(CODE_PATH)) {
      const path = match[1] ?? ''
      if (!inRepo(path.replace(/^(\.\.?\/)+/, '')) && !existsSync(resolve(dirname(resolve(root, file)), path))) broken.push(`${file}:${i + 1}: \`${path}\` is not in the repository`)
    }
  }
}
for (const b of broken) console.error(`doc links: broken ${b}`)
if (broken.length > 0) process.exit(1)
console.log(`doc links: ${files.length} files ok`)
