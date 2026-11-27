import { computed, Scroll, signal, Text, View, windowSize, type JSX } from "nsh";

import { list, t } from "@vibevalley/i18n";
import { type Feature, FeatureValues, type Missing, type Readiness } from "@vibevalley/protocol";

import { SettingsPage as Page, SettingsSearch } from "../../design/domain/settings";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { ActiveBar } from "../../design/layout";
import { Splitter, usePaneWidth } from "../../design/Splitter";
import { TextLink } from "../../design/TextLink";
import { matches } from "../../infra/base/search";
import { ready, settingsQuery, useQuery } from "../../infra/query";
import { fixOf } from "../../infra/readiness";
import { Link as A, Navigate } from "../../infra/router";
import { useVdpNode } from "../../infra/vdpProbe";
import { ConnectorsPage } from "../connector";
import { ProviderModels } from "../provider";
import { SkillsPage } from "../runtime";
import { VoiceForm } from "../voice";
import { AboutPage, DataSettingsPage } from "./AboutPage";
import { AppearanceGroups } from "./AppearancePage";
import { GeneralGroups } from "./GeneralPage";
import { McpSettingsPage } from "./McpSettingsPage";
import { ProfileSettingsPage } from "./ProfileSettingsPage";
import { RemoteAccessPage } from "./RemoteAccessPage";
import { GitHub, SettingsForm } from "./SettingsForm";

type Group = "workspace" | "connect" | "about";

interface Section {
  readonly id: string;
  readonly group: Group;
  readonly icon: IconName;
  readonly label: string;
  /** What else the search finds it by: the names of its settings. */
  readonly words: string;
}

const allSections = (): readonly Section[] => [
  { id: "profile", group: "workspace", icon: "agents", label: t("web.setting.nav.profile"), words: t("web.setting.words.profile") },
  { id: "general", group: "workspace", icon: "settings", label: t("web.setting.nav.general"), words: t("web.setting.words.general") },
  { id: "appearance", group: "workspace", icon: "appearance", label: t("web.setting.nav.appearance"), words: t("web.setting.words.appearance") },
  { id: "models", group: "workspace", icon: "key", label: t("web.setting.nav.models"), words: t("web.setting.words.models") },
  { id: "skills", group: "workspace", icon: "skill", label: t("web.setting.nav.skills"), words: t("web.setting.words.skills") },
  { id: "memory", group: "workspace", icon: "memory", label: t("web.setting.nav.memory"), words: t("web.setting.words.memory") },
  { id: "mcp", group: "connect", icon: "plug", label: t("web.setting.nav.mcp"), words: t("web.setting.words.mcp") },
  { id: "voice", group: "connect", icon: "call", label: t("web.setting.nav.voice"), words: t("web.setting.words.voice") },
  { id: "chat", group: "connect", icon: "chat", label: t("web.setting.nav.chat"), words: t("web.setting.words.chat") },
  { id: "github", group: "connect", icon: "branch", label: "GitHub", words: t("web.setting.words.github") },
  { id: "remote", group: "connect", icon: "devices", label: t("web.setting.nav.remote"), words: t("web.setting.words.remote") },
  { id: "data", group: "about", icon: "folder", label: t("web.setting.nav.data"), words: t("web.setting.words.data") },
  { id: "about", group: "about", icon: "info", label: t("web.setting.nav.about"), words: t("web.setting.words.about") },
];

function legacyRedirect(rest: string): string | undefined {
  const [first, sub, ...more] = rest.split("/");
  switch (first) {
    case "accounts":
    case "providers":
      return "/settings/models";
    case "call":
    case "moss":
      return "/settings/voice";
    case "connections": {
      if (sub === "github") return "/settings/github";
      if (sub === "remote") return "/settings/remote";
      if (sub === "chat") {
        const restId = more.filter(Boolean).join("/");
        return restId ? `/settings/chat/${restId}` : "/settings/chat";
      }
      return "/settings/chat";
    }
    case "tree":
      return "/settings/memory";
    default:
      return undefined;
  }
}

type ReadinessRow =
  | { readonly key: string; readonly ready: true; readonly text: string }
  | { readonly key: string; readonly ready: false; readonly text: string; readonly fixHref?: string | undefined };

function buildReadinessRows(
  features: readonly Feature[],
  all: Record<Feature, Readiness>,
  options: { collapseSameReason?: boolean; selfHref?: string },
): ReadinessRow[] {
  const readyNames: string[] = [];
  const lackingByMissing = new Map<Missing, Feature[]>();
  const rows: ReadinessRow[] = [];

  if (options.collapseSameReason === true) {
    for (const f of features) {
      const state = all[f];
      if (state.ready) {
        readyNames.push(t(`web.setting.feature.${f}`));
      } else {
        const group = lackingByMissing.get(state.missing);
        if (group) group.push(f);
        else lackingByMissing.set(state.missing, [f]);
      }
    }
    if (readyNames.length > 0) {
      rows.push({
        key: `ready:${readyNames.join(",")}`,
        ready: true,
        text: t("web.setting.readiness.ready", { feature: list(readyNames) }),
      });
    }
    for (const [missing, group] of lackingByMissing) {
      const fix = fixOf(missing);
      rows.push({
        key: `lacks:${missing}`,
        ready: false,
        text: t("web.setting.readiness.lacks", {
          feature: list(group.map((f) => t(`web.setting.feature.${f}`))),
          why: fix.words,
        }),
        ...(fix.href !== options.selfHref ? { fixHref: fix.href } : {}),
      });
    }
    return rows;
  }

  for (const f of features) {
    const state = all[f];
    const name = t(`web.setting.feature.${f}`);
    if (state.ready) {
      rows.push({ key: `ready:${f}`, ready: true, text: t("web.setting.readiness.ready", { feature: name }) });
    } else {
      const fix = fixOf(state.missing);
      rows.push({
        key: `lacks:${f}`,
        ready: false,
        text: t("web.setting.readiness.lacks", { feature: name, why: fix.words }),
        ...(fix.href !== options.selfHref ? { fixHref: fix.href } : {}),
      });
    }
  }
  return rows;
}

function SettingsReadiness(props: { features: readonly Feature[]; selfHref?: string; collapseSameReason?: boolean }) {
  const settings = useQuery(settingsQuery);
  const rows = computed(() => {
    const readiness = ready(settings, undefined)?.readiness;
    if (!readiness) return undefined;
    return buildReadinessRows(props.features, readiness, {
      ...(props.collapseSameReason !== undefined ? { collapseSameReason: props.collapseSameReason } : {}),
      ...(props.selfHref !== undefined ? { selfHref: props.selfHref } : {}),
    });
  });

  return (
    <If when={rows()}>
      {(items) => (
        <View class="gap-1.5 rounded-lg bg-side px-3.5 py-2.5" testID="readiness">
          <Each of={items()} key={(row) => row.key}>
            {(row) => {
              const fixHref = () => {
                const r = row();
                return !r.ready ? r.fixHref : undefined;
              };
              return (
                <View class="flex-row flex-wrap items-center gap-2" testID={row().ready ? "readiness-row-ready" : "readiness-row-lacking"}>
                  <If
                    when={!row().ready}
                    else={
                      <>
                        <Icon name="ticked" size={14} tone="leaf" />
                        <Text class="text-sm text-ink">{row().text}</Text>
                      </>
                    }
                  >
                    <Icon name="warn" size={14} />
                    <Text class="text-sm text-ink">{row().text}</Text>
                    <If when={fixHref()}>
                      {(href) => (
                        <TextLink href={href()} testid="readiness-fix">
                          {t("web.setting.readiness.fix")}
                        </TextLink>
                      )}
                    </If>
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
      )}
    </If>
  );
}

function VoiceSettings() {
  return (
    <Page title={t("web.setting.nav.voice")} description={t("web.voice.moss.intro")}>
      <SettingsReadiness features={FeatureValues.filter((f) => f === "live" || f === "vision" || f === "call")} collapseSameReason />
      <VoiceForm part="line" />
    </Page>
  );
}

function SectionBody(props: { id: string; connectorId: string | undefined }) {
  return (
    <>
      <If when={props.id === "profile"}>
        <ProfileSettingsPage />
      </If>
      <If when={props.id === "general"}>
        <Page title={t("web.setting.nav.general")} description={t("web.setting.general.intro")}>
          <GeneralGroups />
        </Page>
      </If>
      <If when={props.id === "appearance"}>
        <Page title={t("web.setting.nav.appearance")} description={t("web.setting.appearance.intro")}>
          <AppearanceGroups />
        </Page>
      </If>
      <If when={props.id === "models"}>
        <Page title={t("web.setting.nav.models")} hint={t("web.setting.models.intro")}>
          <SettingsReadiness features={["orchestrator", "call"]} selfHref="/settings/models" />
          <SettingsForm part="deepseek" />
          <ProviderModels />
        </Page>
      </If>
      <If when={props.id === "memory"}>
        <Page title={t("web.setting.nav.memory")} hint={t("web.setting.memory.intro")}>
          <SettingsForm part="memory" />
        </Page>
      </If>
      <If when={props.id === "mcp"}>
        <McpSettingsPage />
      </If>
      <If when={props.id === "voice"}>
        <VoiceSettings />
      </If>
      <If when={props.id === "chat"}>
        <ConnectorsPage id={props.connectorId} basePath="/settings/chat" />
      </If>
      <If when={props.id === "github"}>
        <Page title="GitHub" hint={t("web.setting.github.note")}>
          <GitHub />
        </Page>
      </If>
      <If when={props.id === "remote"}>
        <RemoteAccessPage />
      </If>
      <If when={props.id === "data"}>
        <DataSettingsPage />
      </If>
      <If when={props.id === "about"}>
        <AboutPage />
      </If>
    </>
  );
}

/** `rest` is the path after /settings/. */
export function SettingsPage(props: { rest: string }) {
  useVdpNode({ testId: "settings-nav", role: "navigation" });
  /** Tailwind's md (48rem): narrower, the list sits over the section. */
  const md = computed(() => windowSize().width >= 768);
  const query = signal("");
  const q = computed(() => query().trim().toLowerCase());
  const parts = computed(() => props.rest.split("/"));
  const redirect = computed(() => legacyRedirect(props.rest));
  const sections = allSections();
  const section = computed(() => sections.find((s) => s.id === parts()[0]));
  const skillId = computed(() => (parts().length > 1 ? decodeURIComponent(parts().slice(1).join("/")) : undefined));
  const connectorId = computed(() => (parts()[0] === "chat" && parts().length > 1 ? decodeURIComponent(parts().slice(1).join("/")) : undefined));
  const workspaceShown = computed(() => sections.filter((s) => s.group === "workspace" && matches(q(), [s.label, s.words])));
  const connectShown = computed(() => sections.filter((s) => s.group === "connect" && matches(q(), [s.label, s.words])));
  const aboutShown = computed(() => sections.filter((s) => s.group === "about" && matches(q(), [s.label, s.words])));
  const navWidth = usePaneWidth("settingsNav", 224, 184, 320);
  return (
    <If
      when={redirect()}
      else={
        <If when={section()} else={<Navigate href="/settings/general" />}>
          {(current) => (
            <SettingsSearch.Provider value={q}>
              <View class={`h-full min-h-0 flex-1 ${md() ? "flex-row" : ""}`}>
                <View
                  testID="settings-nav"
                  accessibilityLabel={t("web.setting.nav.label")}
                  class={`shrink-0 border-line bg-side ${md() ? "h-full min-h-0 border-r" : "max-h-60 border-b"}`}
                  style={md() ? { width: navWidth() } : undefined}
                >
                  <If when={md()}>
                    <Splitter pane="settingsNav" side="right" width={navWidth()} min={184} max={320} label={t("web.setting.nav.width")} />
                  </If>
                  <View class="shrink-0 px-2.5 pt-3 pb-2.5">
                    <SearchField
                      testid="settings-search"
                      clearTestid="settings-search-clear"
                      value={query()}
                      onInput={(v) => query.set(v)}
                      placeholder={t("web.setting.nav.search")}
                      label={t("web.setting.nav.search")}
                    />
                  </View>
                  <Scroll class={md() ? "min-h-0 flex-1" : "shrink"} contentClass="gap-4 px-2.5 pb-3">
                    <If when={workspaceShown().length > 0}>
                      <NavGroup title={t("web.setting.nav.groupWorkspace")}>
                        <Each of={workspaceShown()} key={(s) => s.id}>
                          {(s) => <SectionLink section={s()} current={s().id === current().id} />}
                        </Each>
                      </NavGroup>
                    </If>
                    <If when={connectShown().length > 0}>
                      <NavGroup title={t("web.setting.nav.groupConnect")}>
                        <Each of={connectShown()} key={(s) => s.id}>
                          {(s) => <SectionLink section={s()} current={s().id === current().id} />}
                        </Each>
                      </NavGroup>
                    </If>
                  </Scroll>
                  <If when={aboutShown().length > 0}>
                    <View class="shrink-0 border-t border-line px-2.5 py-2.5">
                      <Text class="px-2.5 pt-0.5 pb-1 text-2xs font-semibold text-faint">{t("web.setting.nav.groupAbout")}</Text>
                      <View class="gap-0.5">
                        <Each of={aboutShown()} key={(s) => s.id}>
                          {(s) => <SectionLink section={s()} current={s().id === current().id} />}
                        </Each>
                      </View>
                    </View>
                  </If>
                </View>
                <If
                  when={current().id === "skills"}
                  else={
                    <Scroll testID={`settings-${current().id}`} class="min-h-0 min-w-0 flex-1 bg-page" contentClass={md() ? "px-8 py-7" : "px-5 py-5"}>
                      <Each of={[current()]} key={(s) => s.id}>
                        {(s) => <SectionBody id={s().id} connectorId={connectorId()} />}
                      </Each>
                    </Scroll>
                  }
                >
                  <View testID="settings-skills" class={`min-h-0 min-w-0 flex-1 bg-page ${md() ? "px-8 py-7" : "px-5 py-5"}`}>
                    <SkillsPage id={skillId()} />
                  </View>
                </If>
              </View>
            </SettingsSearch.Provider>
          )}
        </If>
      }
    >
      {(target) => <Navigate href={target()} />}
    </If>
  );
}

function NavGroup(props: { title: string; children: JSX.Element }) {
  return (
    <View class="gap-1">
      <Text class="px-2.5 pt-1 pb-0.5 text-2xs font-semibold text-faint">{props.title}</Text>
      <View class="gap-0.5">{props.children}</View>
    </View>
  );
}

function SectionLink(props: { section: Section; current: boolean }) {
  return (
    <A
      href={`/settings/${props.section.id}`}
      testID={`settings-section-${props.section.id}`}
      accessibilityLabel={props.section.label}
      accessibilityState={{ selected: props.current }}
      class={`relative group h-8 flex-row items-center gap-2.5 rounded-md px-2.5 focus-visible:outline-2 focus-visible:outline-focus ${
        props.current ? "bg-selected" : "bg-transparent hover:bg-hover"
      }`}
    >
      <If when={props.current}>
        <ActiveBar />
      </If>
      <View class="w-4 shrink-0 items-center justify-center">
        <Icon name={props.section.icon} size={14} tone={props.current ? "ink" : "muted"} />
      </View>
      <Text class={`min-w-0 flex-1 truncate text-sm ${props.current ? "font-medium text-ink" : "text-muted group-hover:text-ink"}`}>{props.section.label}</Text>
    </A>
  );
}
