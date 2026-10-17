/**
 * Names the code has moved past, looked for where they must not come back: the server's packages and command, and the
 * client's code and tests. Run as part of `bun run docs:verify`; a hit names the file, the line, and what to say instead.
 *
 * A name belongs here when renaming it was a decision (a note says why), not when the old word still means something:
 * `t.Helper`, the farm's helpers on screen and the game's harvest are not stale.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const DIRS = ['server/internal', 'server/cmd', 'app/lib', 'app/test']

interface Rule {
  /** What the hit is. */
  readonly name: string
  readonly pattern: RegExp
  /** What to write instead. */
  readonly says: string
  /** Only these directories, when the word is fine elsewhere (a project named tickets). */
  readonly dirs?: readonly string[]
}

const RULES: readonly Rule[] = [
  {
    name: 'an API path without its version',
    pattern: /["'`]\/api\/(?!v1\/)/,
    says: 'every route is under /api/v1',
  },
  {
    name: 'the word ticket',
    pattern: /\btickets?\b/,
    says: 'issues and the issue board',
    dirs: ['app/lib', 'app/test'],
  },
  {
    name: 'ticket in the client',
    pattern: /\b(TicketState|TicketsPage|TicketCard|TicketDetail|TicketBoard|CloseTicket|ticketState|ticketTitle|ticketPlanned|ticketIs|ticketColor|ticketSession)\b/,
    says: 'the client says issue: IssueTag, IssuesPage, IssueCard, IssueDetail, IssueBoard, CloseIssue, issueTag, issueTitle, issuePlanned, issueIs, issueTagColor, issueSession',
  },
  {
    name: 'a ticket path or route',
    pattern: /(desk\/tickets|rules\/tickets\.dart|["'`]\/tickets)/,
    says: 'desk/issues, rules/issues.dart, /issues',
  },
  {
    name: 'the state provider under its farm name',
    pattern: /\b(farmProvider|farmApiProvider|FarmApi)\b/,
    says: 'stateProvider and Api',
  },
  {
    name: 'a farm MCP tool',
    pattern: /\b(farm_say|farm_read|farm_inbox|farm_who)\b/,
    says: 'channel_say, channel_read, channel_inbox, session_list',
  },
  {
    name: 'an old protocol name',
    pattern: /\b(FarmState|SiteFrame|SiteEvent|AgentProfile|WorkStep|CanMerge|Foreman|Worker)\b/,
    says: 'CoreState, StateFrame, SideEvent, Agent, Activity, canHarvest, Manager, Session',
  },
  {
    name: 'an old home file or its mover',
    pattern: /\b(workers\.json|MoveSessionFiles|moveActivities|moveHeads|splitAllResults)\b/,
    says: 'sessions.json, events/, and the one-time import (see the one-way migration note)',
  },
  {
    name: 'a removed endpoint',
    pattern: /\b(worker\.activities|progress\.carry|server\.end)\b/,
    says: 'nothing: the endpoint is gone',
  },
]

const files = DIRS.flatMap((dir) => globSync(`${dir}/**/*.{go,dart}`, { cwd: root })).sort()
const hits: string[] = []
for (const file of files) {
  const lines = readFileSync(resolve(root, file), 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    for (const rule of RULES) {
      if (rule.dirs && !rule.dirs.some((dir) => file.startsWith(dir + '/'))) continue
      if (rule.pattern.test(line)) hits.push(`${file}:${i + 1}: ${rule.name} — ${rule.says}`)
    }
  }
}
for (const hit of hits) console.error(`stale names: ${hit}`)
if (hits.length > 0) process.exit(1)
console.log(`stale names: ${files.length} files ok`)
