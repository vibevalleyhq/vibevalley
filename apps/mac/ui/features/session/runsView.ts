import { type Agent, defaultOrchestrator, type Issue, type Session, type SessionEvent, type SessionView, type Spent } from "@vibevalley/protocol";
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

export interface RunTelemetryRollup {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly spent?: Spent | undefined;
  readonly contextUsed: number;
  readonly contextWindow: number;
  readonly contextPct: number;
  readonly hasContext: boolean;
  readonly llmRetries: number;
  readonly runErrors: number;
}

/** Projects aggregated token usage, Spent cost, context saturation, and retry/error counts for a run entry. */
export function runTelemetryOf(entry: RunEntry, steps: readonly SessionEvent[] = []): RunTelemetryRollup {
  const session = entry.kind === "worker" ? (entry.live ?? entry.session) : entry.live;
  const baseTel = session?.telemetry;
  const spent =
    entry.kind === "worker"
      ? (entry.live?.spent ?? entry.session.spent ?? entry.live?.lastRun?.spent ?? entry.session.lastRun?.spent)
      : (entry.live?.spent ?? entry.live?.lastRun?.spent);
  const phase = session?.phase;
  const lastOutcome = session?.lastRun?.outcome;

  let stepIn = 0;
  let stepCache = 0;
  let stepOut = 0;
  let stepCtxUsed = 0;
  let stepCtxWindow = 0;
  let stepRetries = 0;
  let stepErrors = 0;
  for (const s of steps) {
    if (s.type === "llm/retry") stepRetries += 1;
    else if (s.type === "run/error") stepErrors += 1;
    if (s.tokens) {
      const i = Math.max(0, Math.round(s.tokens.input));
      const c = Math.max(0, Math.round(s.tokens.cacheRead));
      const o = Math.max(0, Math.round(s.tokens.output));
      stepIn += i;
      stepCache += c;
      stepOut += o;
      if (s.tokens.contextUsed !== undefined && s.tokens.contextUsed > 0) {
        stepCtxUsed = Math.round(s.tokens.contextUsed);
      } else {
        const fallback = Math.max(i, c);
        if (fallback > 0) stepCtxUsed = fallback;
      }
      if (s.tokens.contextWindow !== undefined && s.tokens.contextWindow > 0) {
        stepCtxWindow = Math.round(s.tokens.contextWindow);
      }
    }
  }

  const inputTokens = Math.max(baseTel?.inputTokens ?? 0, stepIn);
  const cacheReadTokens = Math.max(baseTel?.cacheReadTokens ?? 0, stepCache);
  const outputTokens = Math.max(baseTel?.outputTokens ?? 0, stepOut);
  const telemetryTokens = inputTokens + cacheReadTokens + outputTokens;
  const totalTokens = Math.max(spent?.tokens ?? 0, telemetryTokens);

  const effectiveSpent: Spent | undefined =
    spent !== undefined
      ? { tokens: Math.max(spent.tokens, totalTokens), ...(spent.cny !== undefined ? { cny: spent.cny } : {}) }
      : totalTokens > 0
        ? { tokens: totalTokens }
        : undefined;

  const contextUsed = stepCtxUsed > 0 ? stepCtxUsed : (baseTel?.contextUsed ?? 0);
  const contextWindow = stepCtxWindow > 0 ? stepCtxWindow : (baseTel?.contextWindow ?? 0);
  const hasContext = contextUsed > 0 && contextWindow > 0;
  const contextPct = hasContext ? Math.min(100, Math.round((contextUsed / contextWindow) * 100)) : 0;

  const liveRetry = phase?._tag === "working" && phase.retry !== undefined ? Math.max(1, phase.retry.attempt) : 0;
  const llmRetries = Math.max(baseTel?.llmRetries ?? 0, stepRetries, liveRetry);
  const failedFlag = phase?._tag === "failed" || lastOutcome === "failed" ? 1 : 0;
  const runErrors = Math.max(baseTel?.runErrors ?? 0, stepErrors, failedFlag);

  return {
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
    ...(effectiveSpent !== undefined ? { spent: effectiveSpent } : {}),
    contextUsed,
    contextWindow,
    contextPct,
    hasContext,
    llmRetries,
    runErrors,
  };
}

/** Whether a run entry is in a recoverable stopped state (`failed`, `interrupted`, or `resting`). */
export function isRecoverableRun(entry: RunEntry): boolean {
  if (entry.kind !== "worker") return false;
  const status = runStatusOf(entry);
  return status === "failed" || status === "interrupted" || status === "resting";
}
