import * as stylex from "@stylexjs/stylex";
import { Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { ArchivePanel, OrchestratorMemoryPanel } from "#/features/memory/index.ts";
import { TrajectoryLog } from "#/features/session/index.ts";
import { VoiceForm } from "#/features/voice/index.ts";
import { useAgent } from "#/infra/agents.ts";
import { useRouter, Link as A } from "#/infra/router.ts";
import { OrchestratorFace } from "#/ui/Face.tsx";
import { Tabs } from "#/ui/Tabs.tsx";

import { markWrongOf, orchestratorLooks } from "./looks";

const viewStyles = stylex.create({
  headDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 4)",
    paddingTop: "calc(var(--spacing) * 4)",
  },
  headSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 18)",
    height: "calc(var(--spacing) * 18)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--wb-hover)",
  },
  headDiv2: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  headH1: {
    fontSize: "var(--text-2xl)",
    lineHeight: "var(--text-2xl--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  headP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  orchestratorOfDiv: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBottom: "calc(var(--spacing) * 4)",
  },
  orchestratorOfDiv2: {
    minHeight: "0",
    flex: "1",
  },
  orchestratorOfDiv3: {
    height: "100%",
    overflowY: "auto",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBottom: "calc(var(--spacing) * 4)",
  },
  orchestratorOfDiv4: {
    display: "flex",
    maxWidth: "var(--container-4xl)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
  },
});

const styles = stylex.create({
  tabs: { borderBottomWidth: 1, borderBottomStyle: "solid", borderColor: "var(--color-line)", paddingBottom: "calc(var(--spacing) * 2)" },
});

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
    <div {...stylex.attrs(viewStyles.headDiv)}>
      <span {...stylex.attrs(viewStyles.headSpan)}>
        <OrchestratorFace size={64} agent={props.agent} />
      </span>
      <div {...stylex.attrs(viewStyles.headDiv2)}>
        <A href="/agents" class="text-xs text-muted hover:underline">
          {t("web.orchestrator.orchestrator.all")}
        </A>
        <h1 {...stylex.attrs(viewStyles.headH1)}>{profile()?.name || t("web.orchestrator.orchestrator.title")}</h1>
        <p {...stylex.attrs(viewStyles.headP)}>
          {t("web.orchestrator.orchestrator.intro")}
          {look() ? t("web.orchestrator.orchestrator.look", { name: look()?.name ?? "" }) : ""}{" "}
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
      styles={styles.tabs}
    />
  );
  // The trajectory takes the whole content area, its rows scrolling under a fixed head; the other tabs are a column.
  return (
    <Switch>
      <Match when={at() === "trajectory"}>
        <div {...stylex.attrs(viewStyles.orchestratorOfDiv)}>
          {head()}
          {bar()}
          <div {...stylex.attrs(viewStyles.orchestratorOfDiv2)}>
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
        <div {...stylex.attrs(viewStyles.orchestratorOfDiv3)}>
          <div {...stylex.attrs(viewStyles.orchestratorOfDiv4)}>
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
