import { t } from "@vibevalley/i18n";
import { type Agent, type AgentProblem, defaultOrchestrator, type RuntimeInfo } from "@vibevalley/protocol";

import { api } from "./api";
import { createSettled } from "./base/dom";
import { defineQuery, ready, retryRead, useAgents, useQuery, useRuntimes } from "./query";
import { fixOf } from "./readiness";
import { createMemo } from "./solid";

export interface LocalizedAgentProblem {
  readonly text: string;
  readonly fixHref?: string | undefined;
}

const DEEPSEEK_KEY_RE = /no\s+deepseek\s+api\s+key\s+is\s+set/iu;
const GENERIC_API_KEY_RE = /no\s+api\s+key\s+is\s+set/iu;

/** Localizes raw English engine readiness errors and attaches the matching settings route when actionable. */
export function localizeAgentProblem(raw: string): LocalizedAgentProblem {
  if (DEEPSEEK_KEY_RE.test(raw)) {
    const fix = fixOf("deepseekKey");
    return { text: fix.words, fixHref: fix.href };
  }
  if (GENERIC_API_KEY_RE.test(raw)) {
    return { text: t("web.agent.missingApiKey"), fixHref: fixOf("deepseekKey").href };
  }
  return { text: raw };
}

export type AgentReadinessStatus = "ready" | "warn" | "error" | "checking";

export interface AgentReadinessSummary {
  readonly status: AgentReadinessStatus;
  readonly runtimeLabel: string;
  readonly problems: readonly LocalizedAgentProblem[];
  readonly errors: readonly LocalizedAgentProblem[];
  readonly warnings: readonly LocalizedAgentProblem[];
}

/** All worker teammates on the roster (both locally dispatched and externally registered). */
export function useWorkAgents(enabled = false) {
  const all = useAgents();
  return (): Agent[] =>
    ready(all, [])
      .filter((a) => a.role === "worker" && (!enabled || a.enabled))
      .toSorted((a, b) => Number(b.enabled) - Number(a.enabled));
}

/** Only locally dispatched (`managed`) worker teammates eligible for VibeValley OAR execution sessions. */
export function useManagedWorkAgents(enabled = false) {
  const all = useAgents();
  return (): Agent[] =>
    ready(all, [])
      .filter((a) => a.role === "worker" && (a.mode ?? "managed") === "managed" && (!enabled || a.enabled))
      .toSorted((a, b) => Number(b.enabled) - Number(a.enabled));
}

const runtimeOrder = (r: RuntimeInfo) => (r.installation.status === "available" ? (r.settings.enabled ? 0 : 1) : 2);

// toSorted is stable: the preset order stands within each group.
export const sortRuntimes = (runtimes: readonly RuntimeInfo[]): RuntimeInfo[] => runtimes.toSorted((a, b) => runtimeOrder(a) - runtimeOrder(b));

/** The orchestrators' profiles, the default one first. */
export function useOrchestrators() {
  const all = useAgents();
  return (): Agent[] =>
    ready(all, [])
      .filter((a) => a.role === "orchestrator")
      .toSorted((a, b) => (a.id === defaultOrchestrator ? -1 : b.id === defaultOrchestrator ? 1 : 0));
}

/** A profile by its id, once the profiles are read; undefined for none or one gone. */
export function useAgent(id: () => string | undefined) {
  const all = useAgents();
  return (): Agent | undefined => {
    const want = id();
    return want ? ready(all, []).find((a) => a.id === want) : undefined;
  };
}

/** What the server says is wrong with each of these drafts (agent.validate), by id; empty until it answers. */
const problemsQuery = defineQuery({
  key: (input: { agents: readonly Agent[]; token: string }) => ["agent-check", input.token],
  fetch: (input, context) => api.agent.validate({ agents: [...input.agents] }, context),
  gcTime: 0,
  ...retryRead,
});

export function useAgentProblems(agents: () => readonly Agent[]) {
  const settled = createSettled(agents);
  const got = useQuery(() => problemsQuery({ agents: settled(), token: crypto.randomUUID() }));
  return (): Record<string, AgentProblem[]> => Object.fromEntries(ready(got, []).map((c) => [c.id, c.problems]));
}

const workValidateQuery = defineQuery({
  key: (input: { agents: readonly Agent[]; sig: string }) => ["agent-work-validate", input.sig],
  fetch: (input, context) => (input.agents.length === 0 ? Promise.resolve([]) : api.agent.validate({ agents: [...input.agents] }, context)),
  ...retryRead,
});

/** Validated runtime & config readiness (from `agent.validate` + `runtime.list`) keyed by agent id for managed OAR workers. */
export function useWorkAgentReadiness(enabled = true) {
  const agents = useManagedWorkAgents(enabled);
  const runtimes = useRuntimes();
  const sig = createMemo(() => {
    const a = agents()
      .map((item) => `${item.id}:${item.runtime}:${item.model ?? ""}:${item.effort ?? ""}:${String(item.enabled)}`)
      .join("|");
    const r = ready(runtimes, [])
      .map((rt) => `${rt.id}:${rt.installation.status}:${String(rt.settings.enabled)}`)
      .join("|");
    return `${a}::${r}`;
  });
  const got = useQuery(() => workValidateQuery({ agents: agents(), sig: sig() }));

  return createMemo((): Record<string, AgentReadinessSummary> => {
    const list = agents();
    const runtimeList = ready(runtimes, []);
    const validated = ready(got, undefined);
    const pending = got.status() === "pending" && validated === undefined && list.length > 0;
    const byId = new Map((validated ?? []).map((v) => [v.id, v.problems]));
    const out: Record<string, AgentReadinessSummary> = {};

    for (const agent of list) {
      const rt = runtimeList.find((r) => r.id === agent.runtime);
      const runtimeLabel = rt?.preset.label ?? agent.runtime;
      const rawProblems = byId.get(agent.id) ?? [];
      const errors = rawProblems.filter((p) => p.level === "error").map((p) => localizeAgentProblem(p.text));
      const warnings = rawProblems.filter((p) => p.level === "warn").map((p) => localizeAgentProblem(p.text));
      const problems = [...errors, ...warnings];
      const status: AgentReadinessStatus = pending
        ? "checking"
        : errors.length > 0
          ? "error"
          : warnings.length > 0
            ? "warn"
            : got.status() === "error" && rt && (rt.installation.status !== "available" || !rt.settings.enabled)
              ? "error"
              : "ready";
      out[agent.id] = { status, runtimeLabel, problems, errors, warnings };
    }
    return out;
  });
}
