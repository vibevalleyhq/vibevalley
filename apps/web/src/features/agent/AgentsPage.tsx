import { t } from "@vibevalley/i18n";
// 档案: every profile as a card, the orchestrators first and then the workers; an orchestrator's card opens its page, a
// worker's its profile, and each group ends with a card that makes a new one. /agents/<id> is a profile, /agents/new a
// new worker, /agents/new?role=orchestrator a new orchestrator.

import { createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useQueryClient } from "@tanstack/solid-query";
import { type Agent, type AgentTally, defaultOrchestrator, type RuntimeInfo } from "@vibevalley/protocol";
import { api, reasonOf } from "@/base/api";
import { hexColor } from "@/ui/cast";
import { toast } from "@/ui/toasts";
import { A } from "@/ui/A";
import { Hint } from "@/ui/Tip";
import { useAgentProblems, useOrchestrators, useWorkAgents } from "@/base/agents";
import { useCore } from "@/base/frame";
import { ready, useRuntimes } from "@/base/query";
import { AgentFace, OrchestratorFace } from "@/ui/Face";
import { Icon } from "@/ui/Icon";
import { useSkills } from "@/features/runtime";
import { AgentPage } from "./AgentPage";
import { TemplatesPage } from "./TemplatesPage";
import { orchestratorHref } from "@/features/orchestrator";

/** `rest` is the path after /agents/. */
export function AgentsRoute(props: { rest: string }) {
  return (
    <Show when={props.rest} keyed fallback={<AgentsPage />}>
      {(id) => (id === "templates" ? <TemplatesPage /> : <AgentPage id={decodeURIComponent(id)} />)}
    </Show>
  );
}

function AgentsPage() {
  const agents = useWorkAgents();
  const orchestrators = useOrchestrators();
  const core = useCore();
  const runtimes = useRuntimes();
  const allSkills = useSkills();
  const skills = createMemo(() => new Map(ready(allSkills, []).map((s) => [s.id, s.name])));
  const problems = useAgentProblems(agents);
  return (
    <div class="h-full overflow-y-auto">
      <div class="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-4 pb-8 sm:px-6">
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div class="flex items-center gap-1.5">
            <h1 class="text-2xl font-semibold">{t("web.agent.list.title")}</h1>
            <Hint text={t("web.agent.list.intro")} />
          </div>
          <span class="flex flex-wrap items-center gap-2">
            <A
              href="/agents/templates"
              data-testid="open-templates"
              title={t("web.agent.templates.openLine")}
              class="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm hover:bg-hover"
            >
              <Icon name="folder" size={14} />
              {t("web.agent.templates.open")}
            </A>
            <A
              href="/agents/new"
              data-testid="new-agent"
              class="inline-flex h-7 items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-sm text-page hover:bg-accent-hover"
            >
              <Icon name="add" size={14} />
              {t("web.agent.list.make")}
            </A>
          </span>
        </div>
        <h2 class="text-sm font-semibold text-muted">{t("web.agent.list.orchestrators")}</h2>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <For each={orchestrators()}>{(a) => <OrchestratorCard agent={a} />}</For>
          <A
            href="/agents/new?role=orchestrator"
            data-testid="new-orchestrator"
            aria-label={t("web.agent.list.makeOrchestrator")}
            class="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink/20 text-sm font-medium text-muted hover:border-leaf/60 hover:text-ok-ink"
          >
            <Icon name="add" size={24} />
            {t("web.agent.list.makeOrchestrator")}
          </A>
        </div>
        <h2 class="text-sm font-semibold text-muted">{t("web.agent.list.workers")}</h2>
        {/* The default orchestrator is always there: once it shows, the profiles are read. */}
        <Show when={orchestrators().length > 0 && agents().length === 0}>
          <p class="text-sm text-muted">
            <A href="/agents/templates" class="underline">
              {t("web.agent.templates.none")}
            </A>
          </p>
        </Show>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <For each={agents()}>
            {(a) => (
              <AgentCard
                agent={a}
                runtime={ready(runtimes, []).find((r) => r.id === a.runtime)}
                tally={core()?.progress?.agents[a.id]}
                here={(core()?.sessions ?? []).filter((h) => h.agent === a.id).length}
                skillName={skills()}
                errors={(problems()[a.id] ?? []).filter((i) => i.level === "error").map((i) => i.text)}
              />
            )}
          </For>
          <A
            href="/agents/new"
            aria-label={t("web.agent.list.make")}
            class="flex min-h-44 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink/20 text-sm font-medium text-muted hover:border-leaf/60 hover:text-ok-ink"
          >
            <Icon name="add" size={24} />
            {t("web.agent.list.make")}
          </A>
        </div>
      </div>
    </div>
  );
}

function CardShell(props: { agent: Agent; to: string; label: string; muted?: boolean; corner?: JSX.Element; children: JSX.Element }) {
  return (
    <div
      data-testid="agent-card"
      data-key={props.agent.id}
      data-role={props.agent.role}
      data-muted={props.muted === true ? "" : undefined}
      class="group relative"
    >
      <A
        href={props.to}
        aria-label={props.label}
        class={[
          "flex h-full flex-col rounded-lg border border-line bg-page p-4 transition-colors hover:border-ink/20 hover:bg-page focus-visible:outline-2 focus-visible:outline-focus",
          // Off, it says so by its dashed edge and greyed face, not by fading its words below what can be read.
          { "border-dashed": !(props.muted !== true) },
        ]}
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

function OrchestratorCard(props: { agent: Agent }) {
  const main = () => props.agent.id === defaultOrchestrator;
  return (
    <CardShell agent={props.agent} to={orchestratorHref(props.agent.id)} label={props.agent.name}>
      <div class="flex items-start gap-3 pb-3">
        <span class="flex size-20 shrink-0 items-center justify-center rounded-lg bg-hover">
          <OrchestratorFace size={68} agent={props.agent.id} />
        </span>
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="text-base font-semibold">{props.agent.name}</span>
          <span class="line-clamp-2 text-sm text-muted">{props.agent.duty || t("web.agent.list.orchestratorLine")}</span>
        </span>
      </div>
      <div class={footer}>
        <span>{t("web.agent.tab.memory")}</span>
        <span>{t("web.agent.list.ledger")}</span>
        <Show when={main()}>
          <span>{t("web.agent.list.voice")}</span>
        </Show>
      </div>
    </CardShell>
  );
}

export function AgentCard(props: {
  agent: Agent;
  runtime?: RuntimeInfo | undefined;
  tally?: AgentTally | undefined;
  here: number;
  skillName: Map<string, string>;
  errors: string[];
}) {
  const client = useQueryClient();
  const available = () => props.runtime?.installation.status === "available";
  const toggle = async () => {
    const a = props.agent;
    try {
      await api.agent.update({ ...a, enabled: !a.enabled });
      await client.invalidateQueries({ queryKey: ["agents"] });
    } catch (e) {
      toast(reasonOf(e));
    }
  };
  return (
    <CardShell
      agent={props.agent}
      to={`/agents/${encodeURIComponent(props.agent.id)}`}
      label={props.agent.name}
      muted={!props.agent.enabled}
      corner={
        <button
          type="button"
          data-testid="toggle"
          data-state={props.agent.enabled ? "on" : "off"}
          onClick={() => void toggle()}
          aria-label={t("web.agent.list.toggle", {
            act: props.agent.enabled ? t("web.agent.list.disable") : t("web.agent.list.enable"),
            name: props.agent.name,
          })}
          class="cursor-pointer rounded-md border border-line bg-page px-2 py-0.5 text-xs font-medium text-muted opacity-0 group-hover:opacity-100 hover:bg-side hover:text-ink focus-visible:opacity-100"
        >
          {props.agent.enabled ? t("web.agent.list.disable") : t("web.agent.list.enable")}
        </button>
      }
    >
      <div class="flex items-start gap-3">
        <span
          class="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-hover"
          style={{ background: `radial-gradient(70% 70% at 50% 70%, ${hexColor(props.agent.look.hat)}33, transparent), var(--color-hover)` }}
        >
          <AgentFace agentId={props.agent.id} runtime={props.agent.runtime} look={props.agent.look} size={68} muted={!props.agent.enabled} />
        </span>
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="flex items-center gap-2">
            <span class="truncate text-base font-semibold">{props.agent.name}</span>
            <Show when={props.here > 0}>
              <span class="shrink-0 rounded bg-hat px-1.5 text-xs text-bark-900">{t("web.agent.list.here", { n: props.here })}</span>
            </Show>
          </span>
          <span class="line-clamp-2 text-sm text-muted">{props.agent.duty}</span>
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
        <span title={t("web.agent.list.tallyHint")}>
          {t("web.agent.list.hired")} <span class="font-medium text-ink">{Math.round(props.tally?.hired ?? 0)}</span>
        </span>
        <span>
          {t("web.agent.list.merged")} <span class="font-medium text-ok-ink">{Math.round(props.tally?.harvested ?? 0)}</span>
        </span>
        <Show when={props.errors.length > 0} fallback={<span class="min-w-0 flex-1 truncate text-right">{props.agent.tags.slice(0, 4).join(" · ")}</span>}>
          <span class="min-w-0 flex-1 truncate text-right text-berry" title={props.errors.join("\n")}>
            {t("web.agent.cannot")}
            {props.errors[0]}
          </span>
        </Show>
      </div>
    </CardShell>
  );
}
