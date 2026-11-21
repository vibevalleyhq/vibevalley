import { Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { orchestratorLooks } from "../../design/domain/cast";
import { OrchestratorFace } from "../../design/domain/Face";
import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { Tabs } from "../../design/Tabs";
import { useAgent } from "../../infra/agents";
import { Keyed, variant } from "../../infra/base/dom";
import { Link as A, Navigate, useRouter } from "../../infra/router";
import { OrchestratorMemoryPanel } from "../memory";
import { runsHref } from "../session";
import { VoiceForm } from "../voice";

const tabs = [
  { id: "memory", label: t("web.orchestrator.orchestrator.tab.memory"), icon: "memory" as IconName },
  { id: "voice", label: t("web.orchestrator.orchestrator.tab.voice"), icon: "call" as IconName },
] as const;
type Tab = (typeof tabs)[number]["id"];

type OrchestratorRoute = { readonly kind: "tab"; readonly agent: string; readonly tab: Tab } | { readonly kind: "redirect"; readonly agent: string };

/** Which orchestrator and tab a path after /orchestrator/ is: a tab alone is the default orchestrator's. */
function orchestratorPath(rest: string): OrchestratorRoute {
  const [first = "", second = ""] = rest.split("/").map(decodeURIComponent);
  if (first === "trajectory") return { kind: "redirect", agent: defaultOrchestrator };
  if (second === "trajectory") return { kind: "redirect", agent: first || defaultOrchestrator };
  const tabOf = (value: string): Tab => tabs.find((x) => x.id === value)?.id ?? "memory";
  if (!first || tabs.some((x) => x.id === first)) return { kind: "tab", agent: defaultOrchestrator, tab: tabOf(first) };
  return { kind: "tab", agent: first, tab: tabOf(second) };
}

/** The page of an orchestrator's tab. */
const orchestratorHref = (agent: string, tab: Tab = "memory") =>
  agent === defaultOrchestrator ? `/orchestrator/${tab}` : `/orchestrator/${encodeURIComponent(agent)}/${tab}`;

/** `rest` is the path after /orchestrator/. */
export function OrchestratorPage(props: { rest: string }) {
  const where = () => orchestratorPath(props.rest);
  return (
    <If when={variant(where(), "kind", "tab")} else={<Navigate href={runsHref({ session: where().agent })} />}>
      {(target) => <Keyed key={target().agent}>{() => <OrchestratorOf agent={target().agent} tab={target().tab} />}</Keyed>}
    </If>
  );
}

function OrchestratorOf(props: { agent: string; tab: Tab }) {
  const router = useRouter();
  const profile = useAgent(() => props.agent);
  // Only the default orchestrator is on the phone: the voice is its.
  const shown = () => tabs.filter((item) => item.id !== "voice" || props.agent === defaultOrchestrator);
  const at = () => (shown().some((item) => item.id === props.tab) ? props.tab : "memory");
  const look = () => orchestratorLooks.find((l) => l.id === (profile()?.look.orchestrator ?? "farmer"));
  const head = () => (
    <View class="gap-2 pt-4">
      <A
        href="/agents"
        class="group -ml-1.5 self-start rounded-md px-1.5 py-0.5 transition duration-120 ease-out hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Text class="text-xs text-muted group-hover:text-ink">{t("web.orchestrator.orchestrator.all")}</Text>
      </A>
      <View class="flex-row flex-wrap items-center gap-4">
        <View class="size-18 shrink-0 items-center justify-center rounded-lg border border-line bg-side">
          <OrchestratorFace size={64} agent={props.agent} />
        </View>
        <View class="min-w-0 flex-1 gap-1">
          <View class="flex-row flex-wrap items-center gap-2">
            <Text role="header" class="truncate text-xl font-semibold text-ink">
              {profile()?.name || t("web.orchestrator.orchestrator.title")}
            </Text>
            <If when={look()}>
              {(l) => (
                <View class="h-5 flex-row items-center rounded-sm bg-side px-1.5">
                  <Text class="text-2xs font-medium text-muted">{l().name}</Text>
                </View>
              )}
            </If>
          </View>
          <Text class="text-sm leading-relaxed text-muted">
            {`${t("web.orchestrator.orchestrator.intro")}${look() ? t("web.orchestrator.orchestrator.look", { name: look()?.name ?? "" }) : ""}`}
          </Text>
        </View>
        <View class="shrink-0 flex-row flex-wrap items-center gap-2">
          <A
            href={runsHref({ session: props.agent })}
            testID="orchestrator-runs-link"
            class="h-7 shrink-0 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2.5 transition duration-120 ease-out hover:border-faint hover:bg-hover active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Icon name="log" size={14} tone="muted" />
            <Text class="text-sm text-ink">{t("web.orchestrator.orchestrator.runsLink")}</Text>
          </A>
          <A
            href={`/agents/${encodeURIComponent(props.agent)}`}
            class="h-7 shrink-0 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2.5 transition duration-120 ease-out hover:border-faint hover:bg-hover active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Icon name="edit" size={14} tone="muted" />
            <Text class="text-sm text-ink">{t("web.orchestrator.orchestrator.profile")}</Text>
          </A>
        </View>
      </View>
    </View>
  );
  const bar = () => (
    <Tabs
      look="line"
      label={t("web.orchestrator.orchestrator.tabs")}
      value={at()}
      onChange={(v) => router.navigate(orchestratorHref(props.agent, v))}
      items={shown().map((x) => ({ value: x.id, label: x.label, icon: x.icon }))}
      class="border-b border-line"
    />
  );
  return (
    <Scroll testID="orchestrator-page" class="h-full flex-1 bg-page" contentClass="px-5 pb-5">
      <View class="w-full max-w-4xl gap-4">
        {head()}
        {bar()}
        <If when={at() === "memory"} else={<VoiceForm part="agent" />}>
          <OrchestratorMemoryPanel agent={props.agent} />
        </If>
      </View>
    </Scroll>
  );
}
