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
  /** Only these directories, when the word is fine elsewhere. */
  readonly dirs?: readonly string[]
  /** Files where the same words name something else (another service's API). */
  readonly except?: RegExp
}

const RULES: readonly Rule[] = [
  {
    name: 'playbook or plan for a task',
    pattern: /[Pp]laybook|\b[a-z_]*[Pp]lan(s|ner|ners|ning|ned)?\b|\b[A-Z][A-Za-z]*Plan(?![te])[A-Za-z]*\b/,
    says: 'a task (Task, task.*, task_split …), split for breaking one into steps, step for one of its steps',
    // A compaction's plan of what to fold, and oar's own usage.Plan: other meanings of the word.
    except: /^server\/internal\/(agent\/brain\/(compaction|.*_test)\.go|runtime\/runtime\.go)$/,
  },
  {
    name: 'a task graph\'s task under its old name',
    pattern: /\b(StepState|StepAction|StepEdit|StepActRequest|StepFieldChange|IssueStep|SessionTask|ReadySteps|CanEditStep|step_action|task_step)\b|\/steps\/\{/,
    says: 'a task graph is TaskGraph (graph.*, GraphState, IssueGraph, SessionGraph); each of its nodes is a Task (TaskState, TaskAction, TaskEdit, IssueTask, task_edit, task_action)',
  },
  {
    name: 'an API path without its version',
    pattern: /["'`]\/api\/(?!v1\/)/,
    says: 'every route is under /api/v1',
    // EverOS's own API, which the memory source speaks: its versions are its own.
    except: /^server\/internal\/memory\/everos(_test)?\.go$/,
  },
  {
    name: 'the word ticket',
    pattern: /[Tt]ickets?/,
    says: 'issues and the issue board; a voice call\'s credential is a grant (AgoraGrant)',
  },
  {
    name: 'ticket in the client',
    pattern: /\b(TicketState|TicketsPage|TicketCard|TicketDetail|TicketBoard|CloseTicket|ticketState|ticketTitle|ticketPlanned|ticketIs|ticketColor|ticketSession)\b/,
    says: 'the client says issue: IssueTag, IssuesPage, IssueCard, IssueDetail, IssueBoard, CloseIssue, issueTag, issueTitle, issueInTask, issueIs, issueTagColor, issueSession',
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
  {
    name: 'an issue template under the seed name',
    pattern: /\b(ProjectSeeds|SeedKind|SeedBlank|Seed|SeedCatalog|seedCatalog|projectSeedsProvider)\b|project\.seeds|\/seeds\b|seed_catalog/,
    says: 'ProjectTemplates, TemplateKind, TemplateBlank, IssueTemplate, TemplateCatalog, project.templates; seed is only the seed data (seeds.json, SeedAgents)',
  },
  {
    name: '连接到本机 under the gate name',
    pattern: /internal\/gate\b|\/api\/v1\/gate\b|\/settings\/gate\b|workbench\/gate\b|\bgate_device\b|\bGate(Status|Update|StartPairing|StopPairing|AnswerPairing|DeleteDevice|Pair|Me|Page|Api|Open)\b|\.Gate\b|\bgate\.Service\b|yard gate/,
    says: 'lan: internal/lan, lan.Service, Workspace.Lan, lan.* routes under /api/v1/lan, the lan and lan_device tables, LanPage at /settings/lan; the village\'s gate is only the picture',
  },
  {
    name: 'a project\'s max sessions under the slots name',
    pattern: /\bSlots\(\)|ProjectSummary\.slots|summary\.slots|island\.slots|['"]slots['"]/,
    says: 'MaxSessions (json maxSessions): it is project.max_sessions',
  },
  {
    name: 'the lan host\'s name under the farm name',
    pattern: /\b(lanFarmName|remote\.farm|using\.farm|last\.farm|paired\.farm|known\.farm)\b|Farm: lan/,
    says: 'hostName (LanStatus.hostName, LanPaired.hostName, RemoteFarm.hostName): the computer\'s hostname',
  },
  {
    name: 'a business name in farm words',
    pattern: /\b(onFarm|OnFarm|notOnFarm|NotOnFarm|farmURL|FarmURL|farmRules|farmNow|putFarm|MemoryAuthorFarm)\b|MemoryAuthor\.farm\b/,
    says: 'presentSessions, Present, Absent, MCPURL, workplaceRules, situationNow, putSystem, MemoryAuthorSystem; farm words are for the skin',
    // The client's onFarm is the skin it is on.
    dirs: ['server/internal', 'server/cmd', 'app/lib/workbench'],
  },
]

const files = DIRS.flatMap((dir) => globSync(`${dir}/**/*.{go,dart}`, { cwd: root })).sort()
const hits: string[] = []
for (const file of files) {
  const lines = readFileSync(resolve(root, file), 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    for (const rule of RULES) {
      if (rule.dirs && !rule.dirs.some((dir) => file.startsWith(dir + '/'))) continue
      if (rule.except?.test(file)) continue
      if (rule.pattern.test(line)) hits.push(`${file}:${i + 1}: ${rule.name} — ${rule.says}`)
    }
  }
}
for (const hit of hits) console.error(`stale names: ${hit}`)
if (hits.length > 0) process.exit(1)
console.log(`stale names: ${files.length} files ok`)
