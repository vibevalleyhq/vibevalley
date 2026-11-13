// Ported from VibeValley apps/web/src/features/orchestrator/OrchestratorPage.tsx:
// an orchestrator's head and tabs. The trajectory tab is features/session's
// TrajectoryLog with the "marked wrong" cases; memory and the voice agent's
// settings as there.
import { Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { Keyed } from "../../base/dom";
import { useAgent } from "../../infra/agents";
import { Link as A, useRouter } from "../../infra/router";
import { OrchestratorFace } from "../../ui/domain/Face";
import { Tabs } from "../../ui/Tabs";
import { OrchestratorMemoryPanel } from "../memory";
import { TrajectoryLog } from "../session/Trajectory";
import { VoiceForm } from "../voice";
import { markWrongOf, orchestratorLooks } from "./looks";

const tabs = [
  { id: "memory", label: t("web.orchestrator.orchestrator.tab.memory") },
  { id: "trajectory", label: t("web.orchestrator.orchestrator.tab.trajectory") },
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
  return <Keyed key={where().agent}>{() => <OrchestratorOf agent={where().agent} tab={where().tab} />}</Keyed>;
}

function OrchestratorOf(props: { agent: string; tab: Tab }) {
  const router = useRouter();
  const profile = useAgent(() => props.agent);
  // Only the default orchestrator is on the phone: the voice is its.
  const shown = () => tabs.filter((t) => t.id !== "voice" || props.agent === defaultOrchestrator);
  const at = () => (shown().some((t) => t.id === props.tab) ? props.tab : "memory");
  const look = () => orchestratorLooks.find((l) => l.id === (profile()?.look.orchestrator ?? "farmer"));
  const head = () => (
    <View class="flex-row items-center gap-4 pt-4">
      <View class="h-18 w-18 shrink-0 items-center justify-center rounded-lg bg-hover">
        <OrchestratorFace size={64} agent={props.agent} />
      </View>
      <View class="min-w-0 gap-0.5">
        <A href="/agents" class="self-start">
          <Text class="text-xs text-muted">{t("web.orchestrator.orchestrator.all")}</Text>
        </A>
        <Text role="header" class="text-2xl font-semibold text-ink">
          {profile()?.name || t("web.orchestrator.orchestrator.title")}
        </Text>
        <View class="flex-row flex-wrap items-baseline">
          <Text class="text-sm text-muted">
            {`${t("web.orchestrator.orchestrator.intro")}${look() ? t("web.orchestrator.orchestrator.look", { name: look()?.name ?? "" }) : ""} `}
          </Text>
          <A href={`/agents/${encodeURIComponent(props.agent)}`}>
            <Text class="text-sm text-muted underline">{t("web.orchestrator.orchestrator.profile")}</Text>
          </A>
        </View>
      </View>
    </View>
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
    <If
      when={at() === "trajectory"}
      else={
        <Scroll testID="orchestrator-page" class="h-full flex-1" contentClass="px-4 pb-4">
          <View class="w-full max-w-4xl gap-4">
            {head()}
            {bar()}
            <If when={at() === "memory"} else={<VoiceForm part="agent" />}>
              <OrchestratorMemoryPanel agent={props.agent} />
            </If>
          </View>
        </Scroll>
      }
    >
      <View testID="orchestrator-page" class="h-full min-h-0 flex-1 gap-4 px-4 pb-4">
        {head()}
        {bar()}
        <View class="min-h-0 flex-1">
          <TrajectoryLog
            id={props.agent}
            asked={t("web.orchestrator.orchestrator.heard")}
            empty={t("web.orchestrator.orchestrator.quiet")}
            title={t("web.orchestrator.orchestrator.trajectory")}
            about={t("web.orchestrator.orchestrator.about")}
            onMarkWrong={markWrongOf(props.agent)}
          />
        </View>
      </View>
    </If>
  );
}
