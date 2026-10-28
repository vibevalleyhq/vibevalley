/**
 * Names the code has moved past, looked for where they must not come back: the server's code, the page's and the
 * shapes'. Run as part of `vp run docs:verify`; a hit names the file, the line, and what to say instead.
 *
 * A name belongs here when renaming it was a decision (a note says why), not when the old word still means something:
 * `t.Helper`, the farm's helpers on screen and the game's harvest are not stale; an issue's state in farm words is.
 */

import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const DIRS = ["apps/server/src", "apps/web/src", "apps/web/test", "packages/protocol/src"];

interface Rule {
  /** What the hit is. */
  readonly name: string;
  readonly pattern: RegExp;
  /** What to write instead. */
  readonly says: string;
  /** Only these directories, when the word is fine elsewhere. */
  readonly dirs?: readonly string[];
  /** Files where the same words name something else (another service's API). */
  readonly except?: RegExp;
}

const RULES: readonly Rule[] = [
  {
    name: "a cron under its old name",
    pattern: /[Rr]ecurrences?/,
    says: "a timed trigger is a Cron (Crons, CronWhen, cron.*, cron_create …); the page calls it 定时任务",
  },
  {
    name: "playbook or plan for a task",
    pattern: /[Pp]laybook|\b[a-z_]*[Pp]lan(s|ner|ners|ning|ned)?\b|\b[A-Z][A-Za-z]*Plan(?![te])[A-Za-z]*\b/,
    says: "a task (Task, task.*, task_split …), split for breaking one into steps, step for one of its steps",
    // A compaction's plan of what to fold, and oar's own usage.Plan: other meanings of the word.
    except: /^apps\/server\/src\/(agent\/brain\/(compaction|agent|.*\.test)\.ts|runtime\/runtime\.ts)$/,
  },
  {
    name: "a task graph's task under its old name",
    pattern:
      /\b(StepState|StepAction|StepEdit|StepActRequest|StepFieldChange|IssueStep|SessionTask|ReadySteps|CanEditStep|step_action|task_step)\b|\/steps\/\{/,
    says: "a task graph is TaskGraph (graph.*, GraphState, IssueGraph, SessionGraph); each of its nodes is a Task (TaskState, TaskAction, TaskEdit, IssueTask, graph_task_update, graph_task_act)",
  },
  {
    name: "an API path without its version",
    pattern: /["'`]\/api\/(?!v1\/)/,
    says: "every route is under /api/v1",
    // EverOS's own API, which the memory source speaks: its versions are its own.
    except: /^apps\/server\/src\/memory\/(everos|outside|source-lifetime)(\.test)?\.ts$/,
  },
  {
    name: "the word ticket",
    pattern: /[Tt]ickets?/,
    says: "issues and the issue board; a voice call's credential is a grant (AgoraGrant)",
  },
  {
    name: "ticket in the client",
    pattern:
      /\b(TicketState|TicketsPage|TicketCard|TicketDetail|TicketBoard|CloseTicket|ticketState|ticketTitle|ticketPlanned|ticketIs|ticketColor|ticketSession)\b/,
    says: "the client says issue: IssueTag, IssuesPage, IssueCard, IssueDetail, IssueBoard, CloseIssue, issueTag, issueTitle, issueInTask, issueIs, issueTagColor, issueSession",
  },
  {
    name: "a ticket path or route",
    pattern: /(desk\/tickets|rules\/tickets\.dart|["'`]\/tickets)/,
    says: "desk/issues, rules/issues.dart, /issues",
  },
  {
    name: "the state provider under its farm name",
    pattern: /\b(farmProvider|farmApiProvider|FarmApi)\b/,
    says: "stateProvider and Api",
  },
  {
    name: "a farm MCP tool",
    pattern: /\b(farm_say|farm_read|farm_inbox|farm_who)\b/,
    says: "channel_message_send, channel_message_list, channel_unread_list, session_list",
  },
  {
    name: "an agent tool under its name before it was its endpoint's",
    pattern:
      /\b(channel_say|channel_read|read_chat|channel_inbox|channel_settings|open_channel|list_crons|cancel_cron|issue_status|graph_action|task_action|task_edit|task_add|task_update|task_graph|memory_add|doc_read|doc_append|doc_update|wants_owner|all_projects|base_rev)\b/,
    says: "a tool is named by its endpoint (tool/schemas.ts toolName): channel_message_send, channel_message_list, channel_unread_list, channel_update, channel_create, cron_list, cron_delete, issue_status_update, graph_act, graph_task_act, graph_task_update, memory_create, doc_get, doc_block_create, doc_block_update; an agent's own todo is todo_add, todo_update, todo_list; fields as the endpoint's (wantsOwner, project, baseRev)",
    // Nowledge Mem's own tools, which the memory source calls.
    except: /^apps\/server\/src\/memory\/(nowledge|outside)(\.test)?\.ts$/,
  },
  {
    name: "an old protocol name",
    // The browser's Worker (new Worker, a value typed : Worker) is not the old name.
    pattern: /\b(FarmState|SiteFrame|SiteEvent|AgentProfile|WorkStep|CanMerge|Foreman|(?<!new |: )Worker)\b/,
    says: "CoreState, StateFrame, SideEvent, Agent, Activity, canHarvest, Manager, Session; a Web Worker stays (new Worker)",
  },
  {
    name: "an old home file or its mover",
    pattern: /\b(workers\.json|MoveSessionFiles|moveActivities|moveHeads|splitAllResults)\b/,
    says: "session table, events/; old files are not imported",
  },
  {
    name: "a removed endpoint",
    pattern: /\b(worker\.activities|progress\.carry|server\.end)\b/,
    says: "nothing: the endpoint is gone",
  },
  {
    name: "an issue template under the seed name",
    pattern: /\b(ProjectSeeds|SeedKind|SeedBlank|Seed|SeedCatalog|seedCatalog|projectSeedsProvider)\b|project\.seeds|(?<!\.)\/seeds\b|seed_catalog/,
    says: "ProjectTemplates, TemplateKind, TemplateBlank, IssueTemplate, TemplateCatalog, project.templates; seed is only the seed data (seeds.json, SeedAgents)",
  },
  {
    name: "连接到本机 under the gate name",
    pattern:
      /internal\/gate\b|\/api\/v1\/gate\b|\/settings\/gate\b|workbench\/gate\b|\bgate_device\b|\bGate(Status|Update|StartPairing|StopPairing|AnswerPairing|DeleteDevice|Pair|Me|Page|Api|Open)\b|\.Gate\b|\bgate\.Service\b|yard gate/,
    says: "lan: internal/lan, lan.Service, Workspace.Lan, lan.* routes under /api/v1/lan, the lan and lan_device tables, LanPage at /settings/lan; the village's gate is only the picture",
  },
  {
    name: "a project's max sessions under the slots name",
    pattern: /\bSlots\(\)|ProjectSummary\.slots|summary\.slots|island\.slots|['"]slots['"]/,
    says: "MaxSessions (json maxSessions): it is project.max_sessions",
  },
  {
    name: "the lan host's name under the farm name",
    pattern: /\b(lanFarmName|remote\.farm|using\.farm|last\.farm|paired\.farm|known\.farm)\b|Farm: lan/,
    says: "hostName (LanStatus.hostName, LanPaired.hostName, RemoteServer.hostName): the computer's hostname",
  },
  {
    name: "the server the app talks to under the farm name",
    pattern: /\b(RemoteFarm|FarmChoice|FarmConnection|farmConnection|loadFarmChoice|saveFarmChoice)\b|vibevalley\.farm\b(?!\.)|farm_choice\.dart/,
    says: "RemoteServer, ServerChoice, ServerConnection, serverConnection, the vibevalley.server key, data/server_choice.dart",
  },
  {
    name: "an issue's cron under the schedule name",
    pattern:
      /\b(Schedules|ScheduleShape|ScheduleRequest|ScheduleWhen\w*|ScheduleBy|scheduleProblem|listSchedules|FactSchedule|FactUnschedule)\b|\bschedules?\.\w|"(un)?schedule"/,
    says: "Cron, Crons, CronRequest, CronWhen, cron.*; Effect's Schedule is another thing",
  },
  {
    name: "a helper's question under the ask name",
    pattern: /\b(Ask|Asks|openAsks|asksOf|setIssueAsks|SetIssueAsks|OwnerAsk|badgeAsks)\b|\.asks\b/,
    says: "Question, questions, openQuestions, questionsOf; the inbox kind ask and the verb ask stay",
    // The marker a helper writing English may put before a question (要问主人：).
    except: /^apps\/server\/src\/session\/rules\.ts$/,
  },
  {
    name: "the read model under the core name",
    pattern: /\b(CoreState|emptyCoreState)\b/,
    says: "WorkspaceState, emptyWorkspaceState; Core is the service that holds it",
  },
  {
    name: "an issue's attention under the standing name",
    pattern: /\b(Standing|StandingValues|IssueStanding|standingLabel|standingOf|standingIn|standingTone|standingWantsOwner)\b|\.standing\b/,
    says: "Attention, IssueAttention, attentionLabel, attentionOf, attentionIn; an achievement's standing (AchievementStanding) stays",
    // The achievements panel's standings are an achievement's tier.
    except: /^apps\/web\/src\/farm\/panels\/Achievements\.tsx$/,
  },
  {
    name: "an issue's refinement under the draft name",
    pattern:
      /\b(IssueDraft|IssueDraftRequest|IssueDrafting|issueDraftingOf|draftBrief|parseDraft|draftDescription|clearDraft|beforeDraft|isDrafted|canDraft)\b|issue\.draft\b|"\/api\/v1\/issues\/\{id\}\/draft"/,
    says: "IssueRefinement, IssueRefineRequest, IssueRefining, refinementBrief, parseRefinement, issue.refine; a plan's draft and a form's draft stay",
  },
  {
    name: "an issue's review under the acceptance name",
    pattern: /\b(Acceptance|AcceptanceValues|IssueAcceptRequest|acceptedAt|setAcceptance)\b|issue\.accept\b/,
    says: "Review, ReviewValues, IssueReviewRequest, reviewedAt, issue.review; a plan step's acceptance (an acceptance test) stays",
  },
  {
    name: "the orchestrator under the manager name",
    pattern: /\b(Manager|Manager[A-Z]\w*|manager[A-Z]\w*|\w+Manager\w*)\b/,
    says: "Orchestrator, defaultOrchestrator, OrchestratorShape, forOrchestrator; the farm's art and map keep their manager names (manager-face, Manager)",
    // The village map's entity is Manager (public/village.ldtk).
    except: /^apps\/web\/src\/farm\/world\/(level|world)\.ts$/,
  },
  {
    name: "the orchestrator under the assistant name",
    pattern: /\b(Assistant(?!Message)[A-Z]\w*|assistant(?!Message)[A-Z]\w*|\w+Assistant(?!Message)\w*)\b/,
    says: 'Orchestrator, defaultOrchestrator, OrchestratorShape, forOrchestrator; a model\'s message role stays assistant (AssistantMessage, role: "assistant")',
  },
  {
    name: "an issue's state in farm words",
    pattern: /收获|收成|缺肥|种植计划|活熟了|\bPhaseRipe\b|_tag (?:===|!==|:) "ripe"|"graph-ripe"|act: "harvest"|\bHarvest(?:Deps|Review)\b|\bharvesting\(/,
    says: "the issue's own words (docs/subsystems/issue.md 状态和用语): 完成 (complete) and what it delivered (合进了主分支…), 改动, 问题 (等你回答), 计划; phase done, graph ready; farm words are for the farm's skin",
    // The farm's skin (with the pixel pieces the skins share) and the game say it their way.
    except: /^apps\/(web\/src\/(farm|ui\/pixel)\/|web\/test\/farm-|server\/src\/game\/)/,
  },
  {
    name: "a word list for an issue's or a session's state outside the protocol's rules",
    pattern:
      /(?<!Partial<)Record<(Outcome|StuckReason|IssueStatus|Attention|IssueAct|Delivery|IssueCanceled|Deliverable|SessionClose|Priority), string>|\bcompleted: "做完|\binterrupted: "(叫停|被叫停|停下)/,
    says: "the shared catalog's words (packages/i18n/locales/*/shared.json: status, attention, stuck, act, outcome, delivered, canceled, deliverable, priority): say a sentence with them, do not keep another list",
    except: /^packages\/protocol\/src\/(rules|words)\//,
  },

  {
    name: "presence or the system in farm words, where agents and the workbench read them",
    pattern: /地里|【农场|农场现状|not_on_farm/,
    says: "在场 (present sessions: presentSessions, session_list), 现状 (the orchestrator's situation), VibeValley for the system; 地里 and 农场 are the farm's own words",
    dirs: [
      "apps/server/src/issue",
      "apps/server/src/session",
      "apps/server/src/task",
      "apps/server/src/tool",
      "apps/server/src/orchestrator",
      "apps/server/src/channel",
      "apps/server/src/mcp",
      "apps/server/src/notice",
      "apps/web/src/features",
      "apps/web/src/base",
      "apps/web/src/ui",
    ],
    // What the owner types in a test is the owner's words; the pixel pieces are the skins' own.
    except: /\.test\.ts$|^apps\/web\/src\/ui\/pixel\//,
  },
  {
    name: "the one orchestrator under its old names",
    pattern: /\b(orchestratorAgent|orchestratorHome|orchestratorLook|setOrchestratorLook|orchestratorChannel)\b/,
    says: "a profile's role (isOrchestrator, role: \"orchestrator\"); defaultOrchestrator only for what names none; agentHome; the profile's look.manager; WorkspaceState.orchestrators[id].channel",
  },
  {
    name: "a profile called a helper's where the owner reads it",
    pattern: /帮工档案/,
    says: "档案 (a profile): its role is 管家 or 帮工; the tools' words for a model may still say 帮工档案 for the profiles work goes to",
    dirs: ["apps/web/src", "apps/server/src"],
    // On the server only the word tables are the owner's; prompts.ts is a model's.
    except: /^apps\/server\/src\/(?!.*\/words\.ts$)/,
  },
  {
    name: "a profile seeded in code",
    pattern: /\b(seedAgents|orchestratorProfile)\b/,
    says: "a template (agent/template.ts: builtInTemplates, profileOf); a new farm installs the default orchestrator from its template, and agent.starters",
  },
  {
    name: "a place to talk under another name",
    pattern: /\b(Conversation\w*|conversation_id|channel_conversation|Rooms|RoomEvent|roomsPath|useRoom|followRoom)\b/,
    says: "Channel (channel_id, Channels): a channel, a direct channel and a thread are all channels, by type (as Discord's); a model's conversation is the brain's word",
  },
  {
    name: "a business name in farm words",
    pattern: /\b(onFarm|OnFarm|notOnFarm|NotOnFarm|farmURL|FarmURL|farmRules|farmNow|putFarm|MemoryAuthorFarm)\b|MemoryAuthor\.farm\b/,
    says: "presentSessions, Present, Absent, MCPURL, workplaceRules, situationNow, putSystem, MemoryAuthorSystem; farm words are for the skin",
    // The client's onFarm is the skin it is on.
    dirs: ["apps/server/src", "apps/web/src/features", "apps/web/src/base", "apps/web/src/ui"],
  },
];

// A word table (and the test that reads the English page) says what the owner reads, in the glossary's English column
// (docs/README.md 用语: ticket, plan, manager…); only the rules about Chinese words look into it.
const wordTable = /(?:^|\/)words(?:\.ts$|\/)|^apps\/web\/test\/english\.spec\.ts$/;
const han = /\p{Script=Han}/u;

/** Where a catalog's words were said before they moved to packages/i18n: web.farm.phone is apps/web/src/farm/phone's,
 * web.setting apps/web/src/features/setting's, shared the protocol's. The rules about a place's words look there. */
function placeOf(ns: string): string {
  if (ns === "shared") return "packages/protocol/src/words/zh.ts";
  const [host, ...parts] = ns.split(".");
  const feature = `apps/${host}/src/features/${parts[0]}`;
  return parts.length > 0 && existsSync(resolve(root, feature))
    ? `${feature}/${parts.slice(1).concat("words.ts").join("/")}`
    : `apps/${host}/src/${[...parts, "words.ts"].join("/")}`;
}

const catalogs = globSync("packages/i18n/locales/*/*.json", { cwd: root }).sort();
const files = DIRS.flatMap((dir) => globSync(`${dir}/**/*.{ts,tsx}`, { cwd: root })).sort();
const hits: string[] = [];
for (const source of [...files, ...catalogs]) {
  const lines = readFileSync(resolve(root, source), "utf8").split("\n");
  const file = source.startsWith("packages/i18n/locales/") ? placeOf(source.split("/").pop()!.slice(0, -".json".length)) : source;
  for (const [i, line] of lines.entries()) {
    for (const rule of RULES) {
      if (rule.dirs && !rule.dirs.some((dir) => file.startsWith(dir + "/"))) continue;
      if (rule.except?.test(file)) continue;
      if (wordTable.test(file) && !han.test(rule.pattern.source)) continue;
      if (rule.pattern.test(line)) hits.push(`${source}:${i + 1}: ${rule.name} — ${rule.says}`);
    }
  }
}
for (const hit of hits) console.error(`stale names: ${hit}`);
if (hits.length > 0) process.exit(1);
console.log(`stale names: ${files.length} files and ${catalogs.length} catalogs ok`);
