// Ported from VibeValley apps/web/src/features/agent/AgentsPage.tsx: the
// orchestrators and the helpers as cards, each to its profile. The faces
// are letters until the farm's pixel art is drawn here (ui/domain/Face);
// the portrait's radial glow is a flat tint of the hat colour. The enable
// toggle shows on hover as there; nsh has no group hover, so it shows
// while the card is hovered by a signal.
import { Scroll, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, type AgentTally, defaultOrchestrator, type RuntimeInfo } from "@vibevalley/protocol";

import { createMemo } from "../../../solid";
import { useAgentProblems, useOrchestrators, useWorkAgents } from "../../infra/agents";
import { api } from "../../infra/api";
import { useCore } from "../../infra/frame";
import { ready, useQueryClient, useRuntimes } from "../../infra/query";
import { Link as A } from "../../infra/router";
import { createAct } from "../../ui/act";
import { hexColor } from "../../ui/domain/cast";
import { AgentFace, OrchestratorFace } from "../../ui/domain/Face";
import { Icon } from "../../ui/Icon";
import { Bubble } from "../../ui/Tip";
import { mix } from "../../ui/tone";
import { useSkills } from "../runtime/SkillsPage";
import { AgentPage } from "./AgentPage";
import { orchestratorHref } from "./OrchestratorProfile";
import { TemplatesPage } from "./TemplatesPage";

/** `rest` is the path after /agents/. */
export function AgentsRoute(props: { rest: string }) {
  return (
    <If when={props.rest} else={<AgentsPage />}>
      {(id) => <Each of={[id()]}>{(at) => (at() === "templates" ? <TemplatesPage /> : <AgentPage id={decodeURIComponent(at())} />)}</Each>}
    </If>
  );
}

function NewCard(props: { href: string; label: string; testID?: string; tall?: boolean }) {
  const hovered = signal(false);
  return (
    <A
      href={props.href}
      testID={props.testID}
      accessibilityLabel={props.label}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      class={`${props.tall === true ? "min-h-44" : "min-h-32"} items-center justify-center gap-2 rounded-lg border border-dashed transition duration-120 ease-out hover:bg-hover`}
      style={{ borderColor: hovered() ? mix("leaf", 0.6) : mix("ink", 0.2) }}
    >
      <Icon name="add" size={24} tone={hovered() ? "ok-ink" : "muted"} />
      <Text class={`text-sm font-medium ${hovered() ? "text-ok-ink" : "text-muted"}`}>{props.label}</Text>
    </A>
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
    <Scroll testID="agents-page" class="h-full flex-1 bg-page" contentClass="gap-5 px-5 pt-4 pb-8">
      <View class="flex-row flex-wrap items-center justify-end gap-3">
        <View class="flex-row flex-wrap items-center gap-2">
          <A
            href="/agents/templates"
            testID="open-templates"
            tooltip={<Bubble text={t("web.agent.templates.openLine")} />}
            class="h-7 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2.5 transition duration-120 ease-out hover:bg-hover active:translate-y-px"
          >
            <Icon name="folder" size={14} />
            <Text class="text-sm text-ink">{t("web.agent.templates.open")}</Text>
          </A>
          <A
            href="/agents/new"
            testID="new-agent"
            class="h-7 flex-row items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 transition duration-120 ease-out hover:bg-accent-hover active:translate-y-px"
          >
            <Icon name="add" size={14} tone="page" />
            <Text class="text-sm text-page">{t("web.agent.list.make")}</Text>
          </A>
        </View>
      </View>
      <View class="flex-row items-center gap-2">
        <Text role="header" class="text-sm font-semibold text-muted">
          {t("web.agent.list.orchestrators")}
        </Text>
        <If when={orchestrators().length > 0}>
          <View class="rounded-sm bg-hover px-1.5 py-px">
            <Text class="text-2xs font-medium tabular-nums text-muted">{String(orchestrators().length)}</Text>
          </View>
        </If>
      </View>
      <View class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        <Each of={orchestrators()} key={(a) => a.id}>
          {(a) => <OrchestratorCard agent={a()} />}
        </Each>
        <NewCard href="/agents/new?role=orchestrator" testID="new-orchestrator" label={t("web.agent.list.makeOrchestrator")} />
      </View>
      <View class="flex-row items-center gap-2 pt-1">
        <Text role="header" class="text-sm font-semibold text-muted">
          {t("web.agent.list.helpers")}
        </Text>
        <If when={agents().length > 0}>
          <View class="rounded-sm bg-hover px-1.5 py-px">
            <Text class="text-2xs font-medium tabular-nums text-muted">{String(agents().length)}</Text>
          </View>
        </If>
      </View>
      {/* The default orchestrator is always there: once it shows, the profiles are read. */}
      <If when={orchestrators().length > 0 && agents().length === 0}>
        <A href="/agents/templates" class="self-start">
          <Text class="text-sm text-muted hover:underline">{t("web.agent.templates.none")}</Text>
        </A>
      </If>
      <View class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        <Each of={agents()} key={(a) => a.id}>
          {(a) => (
            <AgentCard
              agent={a()}
              runtime={ready(runtimes, []).find((r) => r.id === a().runtime)}
              tally={core()?.progress?.agents[a().id]}
              here={(core()?.sessions ?? []).filter((h) => h.agent === a().id).length}
              skillName={skills()}
              errors={(problems()[a().id] ?? []).filter((i) => i.level === "error").map((i) => i.text)}
            />
          )}
        </Each>
        <NewCard href="/agents/new" label={t("web.agent.list.make")} tall />
      </View>
    </Scroll>
  );
}

function CardShell(props: { agent: Agent; to: string; label: string; muted?: boolean; corner?: (hovered: boolean) => JSX.Element; children: JSX.Element }) {
  const hovered = signal(false);
  return (
    <View onMouseEnter={() => hovered.set(true)} onMouseLeave={() => hovered.set(false)}>
      <A
        href={props.to}
        testID={`agent-card-${props.agent.id}`}
        accessibilityLabel={props.label}
        class={`h-full rounded-lg border border-line bg-page p-4 transition-colors duration-180 ease-out ${props.muted === true ? "border-dashed" : ""}`}
        style={{ borderColor: hovered() ? mix("ink", 0.2) : undefined }}
      >
        {props.children}
      </A>
      <If when={props.corner}>{(corner) => <View class="absolute top-3 right-3">{corner()(hovered())}</View>}</If>
    </View>
  );
}

function OrchestratorCard(props: { agent: Agent }) {
  const main = () => props.agent.id === defaultOrchestrator;
  return (
    <CardShell agent={props.agent} to={orchestratorHref(props.agent.id)} label={props.agent.name}>
      <View class="flex-row items-start gap-3 pb-3">
        <View class="h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-hover">
          <OrchestratorFace size={68} agent={props.agent.id} />
        </View>
        <View class="min-w-0 flex-1 gap-0.5">
          <Text class="text-base font-semibold text-ink">{props.agent.name}</Text>
          <Text class="text-sm text-muted" style={{ numberOfLines: 2 }}>
            {props.agent.duty || t("web.agent.list.orchestratorLine")}
          </Text>
        </View>
      </View>
      <View class="mt-auto flex-row items-center gap-3 border-t border-line pt-3">
        <Text class="text-xs text-muted">{t("web.agent.tab.memory")}</Text>
        <Text class="text-xs text-muted">{t("web.agent.list.ledger")}</Text>
        <If when={main()}>
          <Text class="text-xs text-muted">{t("web.agent.list.voice")}</Text>
        </If>
      </View>
    </CardShell>
  );
}

function AgentCard(props: {
  agent: Agent;
  runtime?: RuntimeInfo | undefined;
  tally?: AgentTally | undefined;
  here: number;
  skillName: Map<string, string>;
  errors: string[];
}) {
  const client = useQueryClient();
  const available = () => props.runtime?.installation.status === "available";
  const act = createAct();
  // The API saves a whole profile, and the cached one may be older than an edit made since (in another window).
  const toggle = () => {
    const { id, enabled } = props.agent;
    return act.run(async () => {
      const latest = (await api.agent.list()).find((a) => a.id === id);
      if (latest) await api.agent.update({ ...latest, enabled: !enabled });
      await client.invalidate({ prefix: ["agents"] });
    });
  };
  return (
    <CardShell
      agent={props.agent}
      to={`/agents/${encodeURIComponent(props.agent.id)}`}
      label={props.agent.name}
      muted={!props.agent.enabled}
      corner={(hovered) => (
        <View
          role="button"
          testID={`toggle-${props.agent.enabled ? "on" : "off"}`}
          disabled={act.busy()}
          accessibilityState={{ busy: act.busy() }}
          onPress={() => void toggle()}
          accessibilityLabel={t("web.agent.list.toggle", {
            act: props.agent.enabled ? t("web.agent.list.disable") : t("web.agent.list.enable"),
            name: props.agent.name,
          })}
          class="group rounded-md border border-line bg-page px-2 py-0.5 transition duration-120 ease-out hover:bg-hover"
          style={{ opacity: hovered ? 1 : 0 }}
        >
          <Text class="text-xs font-medium text-muted group-hover:text-ink">
            {props.agent.enabled ? t("web.agent.list.disable") : t("web.agent.list.enable")}
          </Text>
        </View>
      )}
    >
      <View class="flex-row items-start gap-3">
        <View
          class="h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-hover"
          style={{ backgroundColor: `${hexColor(props.agent.look.hat)}33` }}
        >
          <AgentFace
            agentId={props.agent.id}
            name={props.agent.name}
            runtime={props.agent.runtime}
            look={props.agent.look}
            size={68}
            muted={!props.agent.enabled}
          />
        </View>
        <View class="min-w-0 flex-1 gap-0.5">
          <View class="flex-row items-center gap-2">
            <Text class="min-w-0 shrink truncate text-base font-semibold text-ink">{props.agent.name}</Text>
            <If when={props.here > 0}>
              <View class="shrink-0 rounded-sm bg-hat px-1.5 py-0.5">
                <Text class="text-xs font-medium tabular-nums text-bark-900">{t("web.agent.list.here", { n: props.here })}</Text>
              </View>
            </If>
          </View>
          <Text class="text-sm text-muted" style={{ numberOfLines: 2 }}>
            {props.agent.duty}
          </Text>
          <View class="min-w-0 flex-row items-center gap-1.5 pt-1">
            <View class={`h-1.75 w-1.75 shrink-0 rounded-full ${available() ? "bg-leaf" : "bg-berry"}`} />
            <Text class="truncate text-xs text-muted">
              {[props.runtime?.preset.label ?? props.agent.runtime, props.agent.model, props.agent.effort].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </View>
      </View>
      <If when={props.agent.skills.length > 0}>
        <View class="flex-row flex-wrap gap-1 pt-3">
          <Each of={props.agent.skills}>
            {(id) => (
              <View class="rounded-sm bg-hover px-1.5 py-0.5">
                <Text class="text-xs text-ink">{props.skillName.get(id()) ?? id()}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <View class="mt-auto flex-row items-center gap-3 border-t border-line pt-3">
        <View tooltip={<Bubble text={t("web.agent.list.tallyHint")} />} class="flex-row">
          <Text class="text-xs text-muted">
            {`${t("web.agent.list.hired")} `}
            <Text class="font-medium tabular-nums text-ink">{String(Math.round(props.tally?.hired ?? 0))}</Text>
          </Text>
        </View>
        <Text class="text-xs text-muted">
          {`${t("web.agent.list.merged")} `}
          <Text class="font-medium tabular-nums text-ok-ink">{String(Math.round(props.tally?.harvested ?? 0))}</Text>
        </Text>
        <If
          when={props.errors.length > 0}
          else={<Text class="min-w-0 flex-1 truncate text-right text-xs text-muted">{props.agent.tags.slice(0, 4).join(" · ")}</Text>}
        >
          <View class="min-w-0 flex-1" tooltip={<Bubble text={props.errors.join("\n")} />}>
            <Text testID="agent-card-error" class="truncate text-right text-xs text-berry">
              {t("web.agent.cannot") + (props.errors[0] ?? "")}
            </Text>
          </View>
        </If>
      </View>
    </CardShell>
  );
}
