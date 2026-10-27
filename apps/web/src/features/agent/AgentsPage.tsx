// 帮工: the orchestrator and every profile as cards; a card opens its profile, the last card
// makes a new one. /agents/<id> is a profile, /agents/new a new one.

import { agentsWording } from "./words";
import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useQueryClient } from "@tanstack/solid-query";
import type { Agent, AgentTally, RuntimeInfo } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import { hexColor } from "../../ui/cast";
import { toast } from "../../ui/toasts";
import { A } from "../../ui/A";
import { useAgentProblems, useWorkAgents } from "../../base/agents";
import { useCore } from "../../base/frame";
import { ready, useRuntimes } from "../../base/query";
import { AgentFace, OrchestratorFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { useSkills } from "../runtime/SkillsPage";
import { AgentPage } from "./AgentPage";
import { usePrefs } from "../../base/prefs";

/** `rest` is the path after /agents/. */
export function AgentsRoute(props: { rest: string }) {
  return (
    <Show when={props.rest} keyed fallback={<AgentsPage />}>
      {(id) => <AgentPage id={decodeURIComponent(id)} />}
    </Show>
  );
}

function AgentsPage() {
  const agents = useWorkAgents();
  const core = useCore();
  const runtimes = useRuntimes();
  const allSkills = useSkills();
  const skills = createMemo(() => new Map(ready(allSkills, []).map((s) => [s.id, s.name])));
  const problems = useAgentProblems(agents);
  return (
    <div class="h-full overflow-y-auto">
      <div class="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-4 pb-8 sm:px-6">
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div class="flex max-w-xl flex-col gap-1">
            <h1 class="text-2xl font-semibold">
              {agentsWording().list.title} <span class="text-base font-normal text-muted">{agentsWording().list.profiles}</span>
            </h1>
            <p class="text-sm text-muted">{agentsWording().list.intro}</p>
          </div>
          <A href="/agents/new" class="inline-flex h-7 items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-sm text-page hover:bg-leaf">
            <Icon name="button-add" size={14} />
            {agentsWording().list.make}
          </A>
        </div>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <OrchestratorCard />
          <For each={agents()}>
            {(a) => (
              <AgentCard
                agent={a}
                runtime={ready(runtimes, []).find((r) => r.id === a.runtime)}
                tally={core()?.progress?.agents?.[a.id]}
                here={(core()?.sessions ?? []).filter((h) => h.agent === a.id).length}
                skillName={skills()}
                errors={(problems()[a.id] ?? []).filter((i) => i.level === "error").map((i) => i.text)}
              />
            )}
          </For>
          <A
            href="/agents/new"
            aria-label={agentsWording().list.make}
            class="flex min-h-44 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink/20 text-sm font-medium text-muted hover:border-leaf/60 hover:text-[#3f6427]"
          >
            <Icon name="button-add" size={28} />
            {agentsWording().list.make}
          </A>
        </div>
      </div>
    </div>
  );
}

function CardShell(props: { to: string; label: string; muted?: boolean; corner?: JSX.Element; children: JSX.Element }) {
  return (
    <div class={["group relative", { "opacity-60": !!props.muted }]}>
      <A
        href={props.to}
        aria-label={props.label}
        class="flex h-full flex-col rounded-lg border border-line bg-page p-4 transition-colors hover:border-ink/20 hover:bg-[#fffbf2] focus-visible:outline-2 focus-visible:outline-focus"
      >
        {props.children}
      </A>
      <Show when={props.corner}>
        <div class="absolute top-3 right-3">{props.corner}</div>
      </Show>
    </div>
  );
}

const footer = "mt-auto flex items-center gap-3 border-t border-line pt-3 text-xs text-muted";

function OrchestratorCard() {
  const look = usePrefs((p) => p.orchestratorLook);
  return (
    <CardShell to="/orchestrator" label={agentsWording().list.orchestrator}>
      <div class="flex items-start gap-3 pb-3">
        <span class="flex size-20 shrink-0 items-center justify-center rounded-lg bg-hover">
          <OrchestratorFace size={68} look={look()} />
        </span>
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="text-base font-semibold">{agentsWording().list.orchestrator}</span>
          <span class="line-clamp-2 text-sm text-muted">{agentsWording().list.orchestratorLine}</span>
        </span>
      </div>
      <div class={footer}>
        <span>{agentsWording().tab.memory}</span>
        <span>{agentsWording().list.ledger}</span>
        <span>{agentsWording().list.voice}</span>
      </div>
    </CardShell>
  );
}

function AgentCard(props: { agent: Agent; runtime?: RuntimeInfo; tally?: AgentTally; here: number; skillName: Map<string, string>; errors: string[] }) {
  const client = useQueryClient();
  const available = () => props.runtime?.installation.status === "available";
  const toggle = async () => {
    const a = props.agent;
    try {
      await api.agent.save({ id: a.id, body: { ...a, enabled: !a.enabled } });
      await client.invalidateQueries({ queryKey: ["agents"] });
    } catch (e) {
      toast(reasonOf(e));
    }
  };
  return (
    <CardShell
      to={`/agents/${encodeURIComponent(props.agent.id)}`}
      label={props.agent.name}
      muted={!props.agent.enabled}
      corner={
        <button
          type="button"
          onClick={() => void toggle()}
          aria-label={agentsWording().list.toggle(props.agent.enabled ? agentsWording().list.disable : agentsWording().list.enable, props.agent.name)}
          class="cursor-pointer rounded-md border border-line bg-page px-2 py-0.5 text-xs font-medium text-muted opacity-0 group-hover:opacity-100 hover:bg-[#f6eedd] hover:text-ink focus-visible:opacity-100"
        >
          {props.agent.enabled ? agentsWording().list.disable : agentsWording().list.enable}
        </button>
      }
    >
      <div class="flex items-start gap-3">
        <span
          class="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-hover"
          style={{ background: `radial-gradient(70% 70% at 50% 70%, ${hexColor(props.agent.look.hat ?? "")}33, transparent), var(--color-hover)` }}
        >
          <AgentFace agentId={props.agent.id} runtime={props.agent.runtime} look={props.agent.look} size={68} muted={!props.agent.enabled} />
        </span>
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="flex items-center gap-2">
            <span class="truncate text-base font-semibold">{props.agent.name}</span>
            <Show when={props.here > 0}>
              <span class="shrink-0 rounded bg-hat px-1.5 text-xs text-bark-900">{agentsWording().list.here(props.here)}</span>
            </Show>
          </span>
          <span class="line-clamp-2 text-sm text-muted">{props.agent.role}</span>
          <span class="flex min-w-0 items-center gap-1.5 pt-1 text-xs text-muted">
            <span class={["size-[7px] shrink-0 rounded-full", available() ? "bg-leaf" : "bg-berry"]} aria-hidden="true" />
            <span class="truncate">
              {[props.runtime?.preset.label ?? props.agent.runtime, props.agent.model, props.agent.effort].filter(Boolean).join(" · ")}
            </span>
          </span>
        </span>
      </div>
      <Show when={props.agent.skills.length > 0}>
        <div class="flex flex-wrap gap-1 pt-3">
          <For each={props.agent.skills}>{(id) => <span class="rounded bg-hover px-1.5 text-xs">{props.skillName.get(id) ?? id}</span>}</For>
        </div>
      </Show>
      <div class={[footer, "mt-3"]}>
        <span title={agentsWording().list.tallyHint}>
          {agentsWording().list.hired} <span class="font-medium text-ink">{Math.round(props.tally?.hired ?? 0)}</span>
        </span>
        <span>
          {agentsWording().list.merged} <span class="font-medium text-[#3f6427]">{Math.round(props.tally?.harvested ?? 0)}</span>
        </span>
        <Show when={props.errors.length > 0} fallback={<span class="min-w-0 flex-1 truncate text-right">{props.agent.tags.slice(0, 4).join(" · ")}</span>}>
          <span class="min-w-0 flex-1 truncate text-right text-berry" title={props.errors.join("\n")}>
            {agentsWording().cannot}
            {props.errors[0]}
          </span>
        </Show>
      </div>
    </CardShell>
  );
}
