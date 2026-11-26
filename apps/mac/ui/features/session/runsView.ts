import { type Agent, defaultOrchestrator, type Issue, type Session, type SessionView } from "@vibevalley/protocol";
import { isOrchestratorSession, sessionIssueId, sessionProfile, sessionRepo } from "@vibevalley/protocol/rules";

export type RunsScope = "all" | "active" | "orchestrator" | "worker";

export const runsScopes: readonly RunsScope[] = ["all", "active", "orchestrator", "worker"];

export type RunEntry =
  | {
      readonly kind: "orchestrator";
      readonly id: string;
      readonly agent: Agent;
      readonly live?: SessionView | undefined;
      readonly active: boolean;
    }
  | {
      readonly kind: "worker";
      readonly id: string;
      readonly session: Session;
      readonly live?: SessionView | undefined;
      readonly issue?: Issue | undefined;
      readonly active: boolean;
    };

export type RunStatusBadge = "working" | "listening" | "resting" | "done" | "failed" | "interrupted" | "closed";

export interface BuildRunsInput {
  readonly orchestrators: readonly Agent[];
  readonly sessions: readonly Session[];
  readonly liveSessions: readonly SessionView[];
  readonly issues: readonly Issue[];
}

export interface RunsFilter {
  readonly scope: RunsScope;
  readonly agentId?: string | undefined;
  readonly issueId?: string | undefined;
  readonly query?: string | undefined;
}

export interface RunsQueryParams {
  readonly session?: string | undefined;
  readonly agent?: string | undefined;
  readonly issue?: string | undefined;
  readonly scope?: RunsScope | undefined;
}

function parseRunsScope(value: string | null): RunsScope {
  switch (value) {
    case "all":
    case "active":
    case "orchestrator":
    case "worker":
      return value;
    default:
      return "all";
  }
}

export function runsHref(params: RunsQueryParams = {}, basePath = "/runs"): string {
  const sp = new URLSearchParams();
  if (params.session) sp.set("session", params.session);
  if (params.scope && params.scope !== "all") sp.set("scope", params.scope);
  if (params.agent) sp.set("agent", params.agent);
  if (params.issue) sp.set("issue", params.issue);
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function parseRunsSearch(search: string | URLSearchParams): RunsQueryParams {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const scope = parseRunsScope(sp.get("scope"));
  const session = sp.get("session")?.trim() || undefined;
  const agent = sp.get("agent")?.trim() || undefined;
  const issue = sp.get("issue")?.trim() || undefined;
  return {
    ...(session !== undefined ? { session } : {}),
    ...(scope !== "all" ? { scope } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(issue !== undefined ? { issue } : {}),
  };
}

export function runActivityAt(entry: RunEntry): number {
  switch (entry.kind) {
    case "orchestrator": {
      const live = entry.live;
      if (!live) return 0;
      switch (live.phase._tag) {
        case "working":
          return live.phase.since;
        case "closed":
          return live.phase.at;
        case "resting":
        case "done":
        case "failed":
          return live.lastRun?.at ?? live.hiredAt;
      }
      break;
    }
    case "worker": {
      const phase = entry.live?.phase ?? entry.session.phase;
      switch (phase._tag) {
        case "working":
          return phase.since;
        case "closed":
          return phase.at;
        case "resting":
        case "done":
        case "failed":
          return entry.live?.lastRun?.at ?? entry.session.lastRun?.at ?? entry.session.hiredAt;
      }
    }
  }
}

export function runStatusOf(entry: RunEntry): RunStatusBadge {
  switch (entry.kind) {
    case "orchestrator": {
      const phase = entry.live?.phase;
      if (!phase) return "listening";
      switch (phase._tag) {
        case "working":
          return "working";
        case "resting":
        case "done":
        case "failed":
        case "closed":
          return "listening";
      }
      break;
    }
    case "worker": {
      const phase = entry.live?.phase ?? entry.session.phase;
      const lastOutcome = entry.live?.lastRun?.outcome ?? entry.session.lastRun?.outcome;
      switch (phase._tag) {
        case "working":
          return "working";
        case "failed":
          return "failed";
        case "closed":
          return "closed";
        case "done":
          return lastOutcome === "interrupted" ? "interrupted" : "done";
        case "resting":
          return lastOutcome === "interrupted" ? "interrupted" : "resting";
      }
    }
  }
}

function isClosedWorker(entry: RunEntry): boolean {
  switch (entry.kind) {
    case "orchestrator":
      return false;
    case "worker":
      return (entry.live?.phase ?? entry.session.phase)._tag === "closed";
  }
}

function compareRunEntries(a: RunEntry, b: RunEntry): number {
  if (a.active !== b.active) return a.active ? -1 : 1;

  if (a.active && b.active) {
    const timeDiff = runActivityAt(b) - runActivityAt(a);
    if (timeDiff !== 0) return timeDiff;
    if (a.kind !== b.kind) return a.kind === "orchestrator" ? -1 : 1;
    return a.id.localeCompare(b.id);
  }

  // Inactive entries: keep standing orchestrators visible right below active runs, default first.
  if (a.kind !== b.kind) return a.kind === "orchestrator" ? -1 : 1;
  if (a.kind === "orchestrator" && b.kind === "orchestrator") {
    if (a.id === defaultOrchestrator) return -1;
    if (b.id === defaultOrchestrator) return 1;
    const timeDiff = runActivityAt(b) - runActivityAt(a);
    if (timeDiff !== 0) return timeDiff;
    const nameDiff = a.agent.name.localeCompare(b.agent.name);
    return nameDiff !== 0 ? nameDiff : a.id.localeCompare(b.id);
  }

  const closedDiff = Number(isClosedWorker(a)) - Number(isClosedWorker(b));
  if (closedDiff !== 0) return closedDiff;
  const timeDiff = runActivityAt(b) - runActivityAt(a);
  if (timeDiff !== 0) return timeDiff;
  return a.id.localeCompare(b.id);
}

export function buildRunEntries(input: BuildRunsInput): RunEntry[] {
  const liveById = new Map<string, SessionView>();
  const liveOrchByAgent = new Map<string, SessionView>();
  for (const s of input.liveSessions) {
    liveById.set(s.id, s);
    if (isOrchestratorSession(s)) liveOrchByAgent.set(sessionProfile(s) ?? "", s);
  }
  const issueById = new Map<string, Issue>(input.issues.map((i) => [i.id, i]));

  const entries: RunEntry[] = [];

  for (const agent of input.orchestrators) {
    const live = liveOrchByAgent.get(agent.id);
    entries.push({
      kind: "orchestrator",
      id: agent.id,
      agent,
      ...(live !== undefined ? { live } : {}),
      active: live?.phase._tag === "working",
    });
  }

  const workerMap = new Map<string, Session>();
  for (const s of input.sessions) {
    if (isOrchestratorSession(s)) continue;
    workerMap.set(s.id, s);
  }
  for (const s of input.liveSessions) {
    if (isOrchestratorSession(s)) continue;
    if (!workerMap.has(s.id)) workerMap.set(s.id, s);
  }

  for (const session of workerMap.values()) {
    const live = liveById.get(session.id);
    const issueId = sessionIssueId(session);
    const issue = issueId !== undefined ? issueById.get(issueId) : undefined;
    const phase = live?.phase ?? session.phase;
    entries.push({
      kind: "worker",
      id: session.id,
      session,
      ...(live !== undefined ? { live } : {}),
      ...(issue !== undefined ? { issue } : {}),
      active: phase._tag === "working",
    });
  }

  return entries.toSorted(compareRunEntries);
}

function matchesScope(entry: RunEntry, scope: RunsScope): boolean {
  switch (scope) {
    case "all":
      return true;
    case "active":
      return entry.active;
    case "orchestrator":
      return entry.kind === "orchestrator";
    case "worker":
      return entry.kind === "worker";
  }
}

function matchesAgent(entry: RunEntry, agentId: string): boolean {
  switch (entry.kind) {
    case "orchestrator":
      return entry.agent.id === agentId;
    case "worker":
      return (sessionProfile(entry.session) ?? "") === agentId;
  }
}

function matchesIssue(entry: RunEntry, issueId: string): boolean {
  switch (entry.kind) {
    case "orchestrator":
      return false;
    case "worker":
      return sessionIssueId(entry.session) === issueId;
  }
}

function matchesQuery(entry: RunEntry, needle: string): boolean {
  switch (entry.kind) {
    case "orchestrator": {
      const hay = [entry.id, entry.agent.name, entry.agent.duty, ...entry.agent.tags].join(" ").toLowerCase();
      return hay.includes(needle);
    }
    case "worker": {
      const issueParts = entry.issue ? [`#${entry.issue.number}`, entry.issue.title, entry.issue.repo ?? ""] : [];
      const hay = [
        entry.id,
        entry.session.name,
        sessionProfile(entry.session) ?? "",
        entry.session.runtime,
        entry.session.brief,
        sessionRepo(entry.session) ?? "",
        ...issueParts,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    }
  }
}

export function filterRunEntries(entries: readonly RunEntry[], filter: RunsFilter): RunEntry[] {
  const needle = filter.query?.trim().toLowerCase() ?? "";
  return entries.filter((entry) => {
    if (!matchesScope(entry, filter.scope)) return false;
    if (filter.agentId && !matchesAgent(entry, filter.agentId)) return false;
    if (filter.issueId && !matchesIssue(entry, filter.issueId)) return false;
    if (needle && !matchesQuery(entry, needle)) return false;
    return true;
  });
}

export function resolveSelectedRun(entries: readonly RunEntry[], sessionId: string | undefined): RunEntry | undefined {
  if (sessionId) {
    const exact = entries.find((entry) => entry.id === sessionId || (entry.kind === "orchestrator" && entry.live?.id === sessionId));
    if (exact) return exact;
  }
  return entries[0];
}
