// 管家: who an orchestrator is, and its 记性, 轨迹 (every round, a round markable as wrong), 旧账 (the conversation it
// folded away) and, for the default one that answers the phone, 声音 (what it says on a call). /orchestrator/<tab> is
// the default orchestrator's, /orchestrator/<profile id>/<tab> another's.

import { Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { useAgent } from "@/base/agents";
import { useRouter } from "@/base/router";
import { ArchivePanel, OrchestratorMemoryPanel } from "@/features/memory";
import { TrajectoryLog } from "@/features/session";
import { VoiceForm } from "@/features/voice";
import { A } from "@/ui/A";
import { OrchestratorFace } from "@/ui/Face";
import { Tabs } from "@/ui/Tabs";

import { markWrongOf } from "./evals";
import { orchestratorLooks } from "./looks";

const tabs = [
  { id: "memory", label: t("web.orchestrator.orchestrator.tab.memory") },
  { id: "trajectory", label: t("web.orchestrator.orchestrator.tab.trajectory") },
  { id: "archive", label: t("web.orchestrator.orchestrator.tab.archive") },
  { id: "voice", label: t("web.orchestrator.orchestrator.tab.voice") },
] as const;
type Tab = (typeof tabs)[number]["id"];

/** Which orchestrator and tab a path after /orchestrator/ is: a tab alone is the default orchestrator's. */
function orchestratorPath(rest: string): { readonly agent: string; readonly tab: Tab } {
  const [first = "", second = ""] = rest.split("/").map(decodeURIComponent);
  const tabOf = (t: string): Tab => tabs.find((x) => x.id === t)?.id ?? "memory";
  if (!first || tabs.some((t) => t.id === first)) return { agent: defaultOrchestrator, tab: tabOf(first) };
  return { agent: first, tab: tabOf(second) };
}

/** The page of an orchestrator's tab. */
export const orchestratorHref = (agent: string, tab: Tab = "memory") =>
  agent === defaultOrchestrator ? `/orchestrator/${tab}` : `/orchestrator/${encodeURIComponent(agent)}/${tab}`;

/** `rest` is the path after /orchestrator/. */
export function OrchestratorPage(props: { rest: string }) {
  const where = () => orchestratorPath(props.rest);
  return (
    <Show when={where().agent} keyed>
      {(agent) => <OrchestratorOf agent={agent} tab={where().tab} />}
    </Show>
  );
}

function OrchestratorOf(props: { agent: string; tab: Tab }) {
  const router = useRouter();
  const profile = useAgent(() => props.agent);
  // Only the default orchestrator is on the phone: the voice is its.
  const shown = () => tabs.filter((t) => t.id !== "voice" || props.agent === defaultOrchestrator);
  const at = () => (shown().some((t) => t.id === props.tab) ? props.tab : "memory");
  const look = () => orchestratorLooks.find((l) => l.id === (profile()?.look.orchestrator ?? "farmer"));
  const head = () => (
    <div class="flex items-center gap-4 pt-4">
      <span class="flex size-18 shrink-0 items-center justify-center rounded-lg bg-hover">
        <OrchestratorFace size={64} agent={props.agent} />
      </span>
      <div class="flex min-w-0 flex-col gap-0.5">
        <A href="/agents" class="text-xs text-muted hover:underline">
          {t("web.orchestrator.orchestrator.all")}
        </A>
        <h1 class="text-2xl font-semibold">{profile()?.name || t("web.orchestrator.orchestrator.title")}</h1>
        <p class="text-sm text-muted">
          {t("web.orchestrator.orchestrator.intro")}
          {look() ? t("web.orchestrator.orchestrator.look", { name: look()!.name }) : ""}{" "}
          <A href={`/agents/${encodeURIComponent(props.agent)}`} class="underline">
            {t("web.orchestrator.orchestrator.profile")}
          </A>
        </p>
      </div>
    </div>
  );
  const bar = () => (
    <Tabs
      label={t("web.orchestrator.orchestrator.tabs")}
      value={at()}
      onChange={(v) => router.navigate(orchestratorHref(props.agent, v))}
      items={shown().map((x) => ({ value: x.id, label: x.label }))}
      class="border-b border-line pb-2"
    />
  );
  // The trajectory takes the whole content area, its rows scrolling under a fixed head; the other tabs are a column.
  return (
    <Switch>
      <Match when={at() === "trajectory"}>
        <div class="flex h-full min-h-0 flex-col gap-4 px-4 pb-4">
          {head()}
          {bar()}
          <div class="min-h-0 flex-1">
            <TrajectoryLog
              id={props.agent}
              asked={t("web.orchestrator.orchestrator.heard")}
              empty={t("web.orchestrator.orchestrator.quiet")}
              title={t("web.orchestrator.orchestrator.trajectory")}
              about={t("web.orchestrator.orchestrator.about")}
              onMarkWrong={markWrongOf(props.agent)}
            />
          </div>
        </div>
      </Match>
      <Match when={at() !== "trajectory"}>
        <div class="h-full overflow-y-auto px-4 pb-4">
          <div class="mx-auto flex max-w-4xl flex-col gap-4">
            {head()}
            {bar()}
            <Switch>
              <Match when={at() === "memory"}>
                <OrchestratorMemoryPanel agent={props.agent} />
              </Match>
              <Match when={at() === "archive"}>
                <ArchivePanel agent={props.agent} />
              </Match>
              <Match when={at() === "voice"}>
                <VoiceForm part="agent" />
              </Match>
            </Switch>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
