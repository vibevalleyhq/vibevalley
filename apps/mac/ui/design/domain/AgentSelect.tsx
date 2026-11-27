import { computed, Text, View } from "nsh";
import { Select as Base } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { Agent } from "@vibevalley/protocol";

import { Button } from "../Button";
import { Icon } from "../Icon";
import { motionClass, popupTransition } from "../motion";
import { TextLink } from "../TextLink";
import { AgentCodeBadge, AgentFace } from "./Face";

type AgentReadinessStatus = "ready" | "warn" | "error" | "checking";

interface AgentReadinessProblem {
  readonly text: string;
  readonly fixHref?: string | undefined;
}

interface AgentReadinessSummary {
  readonly status: AgentReadinessStatus;
  readonly runtimeLabel: string;
  readonly problems: readonly AgentReadinessProblem[];
}

const statusDotClass = (status: AgentReadinessStatus): string => {
  switch (status) {
    case "ready":
      return "bg-leaf";
    case "warn":
      return "bg-wheat";
    case "error":
      return "bg-berry";
    case "checking":
      return "bg-faint";
  }
};

const statusPill = (status: AgentReadinessStatus): { box: string; ink: string; label: string } => {
  switch (status) {
    case "ready":
      return { box: "bg-ok-soft", ink: "text-ok-ink", label: t("web.agent.selector.ready") };
    case "warn":
      return { box: "bg-warn-soft", ink: "text-warn-ink", label: t("web.agent.selector.warn") };
    case "error":
      return { box: "bg-bad-soft", ink: "text-berry", label: t("web.agent.selector.error") };
    case "checking":
      return { box: "bg-hover", ink: "text-muted", label: t("web.agent.selector.checking") };
  }
};

/** Unified helper selector showing avatar, runtime badge, and live `agent.validate` readiness. */
export function AgentSelect(props: {
  value: string;
  onChange: (v: string) => void;
  agents: readonly Agent[];
  readiness: () => Record<string, AgentReadinessSummary>;
  placeholder?: string | undefined;
  label: string;
  testid?: string | undefined;
  quiet?: boolean | undefined;
  size?: "control" | "field" | undefined;
  disabled?: boolean | undefined;
  class?: string | undefined;
}) {
  const agentById = computed(() => new Map(props.agents.map((a) => [a.id, a])));
  const allItems = computed(() => [
    ...(props.placeholder !== undefined ? [{ value: "", title: props.placeholder, disabled: false }] : []),
    ...props.agents.map((a) => ({ value: a.id, title: a.name, disabled: false })),
  ]);
  const selectedAgent = computed(() => (props.value ? agentById().get(props.value) : undefined));
  const selectedInfo = computed(() => (props.value ? props.readiness()[props.value] : undefined));
  const disabled = () => props.disabled === true;
  const triggerSurface = () => {
    const status = selectedInfo()?.status;
    if (status === "error") return "border-berry bg-bad-soft";
    if (props.quiet === true) {
      return disabled() ? "border-transparent bg-transparent" : "border-transparent bg-transparent hover:border-line hover:bg-page aria-expanded:bg-page";
    }
    return disabled() ? "border-line bg-page" : "border-line bg-page hover:border-faint hover:bg-hover aria-expanded:bg-page";
  };

  return (
    <Base
      testID={props.testid}
      accessibilityLabel={props.label}
      value={props.value}
      disabled={props.disabled}
      items={allItems()}
      searchable
      searchPlaceholder={t("web.agent.list.search")}
      searchAccessibilityLabel={t("web.agent.list.search")}
      searchTestID={props.testid ? `${props.testid}-search` : undefined}
      searchClass="mb-1 h-7 rounded-md border border-line bg-page px-2 text-xs text-ink placeholder:text-faint hover:border-faint focus:border-focus"
      empty={
        <View class="items-center px-2 py-3">
          <Text class="text-xs text-muted">{t("web.agent.list.emptySearch")}</Text>
        </View>
      }
      onChange={(e) => {
        const next = e.value ?? "";
        if (next === "" ? props.placeholder !== undefined : agentById().has(next)) {
          props.onChange(next);
        }
      }}
      cover={false}
      placement="bottom"
      offset={4}
      align="start"
      popupClass={`max-h-80 min-w-64 rounded-lg border border-line-strong bg-elevated p-1 shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`}
      popupStartingClass={popupTransition("opacity-0")}
      popupEndingClass={popupTransition("opacity-0")}
      listClass="max-h-64 gap-0.5"
      itemClass="group min-h-8 flex-row items-center gap-2 rounded-md px-2 py-1 focus:bg-hover hover:bg-hover selected:bg-selected disabled:opacity-50"
      renderItem={(entry) => {
        const agent = () => agentById().get(entry.value);
        const info = () => (entry.value ? props.readiness()[entry.value] : undefined);
        const problem = () => info()?.problems[0];
        return (
          <View testID={props.testid ? `${props.testid}-option-${entry.value}` : undefined} class="min-w-0 flex-1 flex-row items-center gap-2">
            <If when={agent()}>{(a) => <AgentFace agentId={a().id} name={a().name} look={a().look} runtime={a().runtime} size={22} />}</If>
            <View class="min-w-0 flex-1 gap-0.5">
              <View class="flex-row items-center gap-1.5">
                <If when={agent()}>{(a) => <AgentCodeBadge code={a().code} compact />}</If>
                <Text class={`min-w-0 truncate text-sm group-selected:font-medium ${agent() ? "text-ink" : "text-muted"}`}>{entry.title}</Text>
                <If when={info()}>{(s) => <Text class="shrink-0 text-2xs text-muted">{s().runtimeLabel}</Text>}</If>
              </View>
              <If when={problem()}>
                {(p) => <Text class={`truncate text-2xs ${info()?.status === "error" ? "text-berry" : "text-warn-ink"}`}>{p().text}</Text>}
              </If>
            </View>
            <If when={info()}>
              {(s) => {
                const pill = () => statusPill(s().status);
                return (
                  <View class={`shrink-0 rounded-sm px-1.5 py-px ${pill().box}`}>
                    <Text class={`text-2xs font-medium ${pill().ink}`}>{pill().label}</Text>
                  </View>
                );
              }}
            </If>
            <View class="size-3.5 shrink-0 items-center justify-center opacity-0 group-selected:opacity-100">
              <Icon name="ticked" size={12} tone="accent" />
            </View>
          </View>
        );
      }}
      class={props.class}
      trigger={
        <View
          testID={props.testid ? `${props.testid}-trigger` : undefined}
          class={[
            "min-w-0 flex-row items-center gap-1.5 rounded-md border",
            props.size === "control" ? "h-7 px-2" : "h-8 px-2.5",
            triggerSurface(),
            disabled() ? "opacity-50" : "aria-expanded:border-focus focus-visible:outline-2 focus-visible:outline-focus",
          ].join(" ")}
        >
          <If when={selectedAgent()}>
            {(a) => (
              <>
                <AgentFace agentId={a().id} name={a().name} look={a().look} runtime={a().runtime} size={16} />
                <AgentCodeBadge code={a().code} compact />
              </>
            )}
          </If>
          <Text class={`min-w-0 flex-1 truncate text-sm ${selectedAgent() ? "text-ink" : "text-faint"}`}>
            {selectedAgent()?.name ?? props.placeholder ?? ""}
          </Text>
          <If when={selectedInfo()}>
            {(s) => (
              <View class="shrink-0 flex-row items-center gap-1">
                <Text class="text-2xs text-muted">{s().runtimeLabel}</Text>
                <View class={`size-1.5 rounded-full ${statusDotClass(s().status)}`} />
              </View>
            )}
          </If>
          <Icon name="choose" size={12} tone="muted" />
        </View>
      }
    />
  );
}

/** Compact inline `agent.validate` readiness diagnostic bar beneath an AgentSelect. */
export function AgentReadinessNote(props: {
  agentId: string;
  readiness: () => Record<string, AgentReadinessSummary>;
  testid?: string | undefined;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const info = computed(() => (props.agentId ? props.readiness()[props.agentId] : undefined));
  return (
    <If when={info()}>
      {(s) => (
        <If
          when={s().status !== "checking"}
          else={
            <View testID={props.testid} class="flex-row items-center gap-1.5 px-1">
              <Text class="text-2xs text-faint">{t("web.agent.selector.checking")}</Text>
            </View>
          }
        >
          <If
            when={s().problems.length > 0}
            else={
              <View testID={props.testid} class="flex-row items-center gap-1.5 px-1">
                <Icon name="ticked" size={11} tone="leaf" />
                <Text class="truncate text-2xs text-muted">{`${s().runtimeLabel} · ${t("web.agent.selector.ready")}`}</Text>
              </View>
            }
          >
            <View
              testID={props.testid}
              class={`gap-1 rounded-md border px-2.5 py-1.5 ${s().status === "error" ? "border-berry bg-bad-soft" : "border-wheat bg-warn-soft"}`}
            >
              <Each of={s().problems} key={(p) => p.text}>
                {(p) => (
                  <View class="flex-row flex-wrap items-center gap-1.5">
                    <Icon name={s().status === "error" ? "cross" : "warn"} size={12} tone={s().status === "error" ? "berry" : "wheat"} />
                    <Text class={`min-w-0 flex-1 text-xs leading-snug ${s().status === "error" ? "text-berry" : "text-warn-ink"}`}>{p().text}</Text>
                    <If when={p().fixHref}>
                      {(href) => (
                        <If when={props.onNavigate} else={<TextLink href={href()}>{t("web.agent.selector.fix")}</TextLink>}>
                          {(go) => (
                            <Button size="compact" tone="quiet" onPress={() => go()(href())}>
                              {t("web.agent.selector.fix")}
                            </Button>
                          )}
                        </If>
                      )}
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </If>
      )}
    </If>
  );
}
