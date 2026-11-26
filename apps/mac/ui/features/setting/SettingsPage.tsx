import { computed, Scroll, signal, Text, View, windowSize, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { FeatureValues } from "@vibevalley/protocol";

import { Readiness } from "../../design/domain/Readiness";
import { SettingsPage as Page, SettingsSearch } from "../../design/domain/settings";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { ActiveBar } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { Splitter, usePaneWidth } from "../../design/Splitter";
import { matches } from "../../infra/base/search";
import { Link as A, Navigate, useRouter } from "../../infra/router";
import { ConnectorsPage } from "../connector";
import { ProviderModels } from "../provider";
import { SkillsPage } from "../runtime";
import { VoiceForm } from "../voice";
import { AboutPage } from "./AboutPage";
import { AppearanceGroups } from "./AppearancePage";
import { GeneralGroups } from "./GeneralPage";
import { RemoteAccessPage } from "./RemoteAccessPage";
import { GitHub, SettingsFile, SettingsForm } from "./SettingsForm";

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
  { id: "general", group: "workspace", icon: "settings", label: t("web.setting.nav.general"), words: t("web.setting.words.general") },
  { id: "models", group: "workspace", icon: "plug", label: t("web.setting.nav.models"), words: t("web.setting.words.models") },
  { id: "skills", group: "workspace", icon: "skill", label: t("web.setting.nav.skills"), words: t("web.setting.words.skills") },
  { id: "memory", group: "workspace", icon: "memory", label: t("web.setting.nav.memory"), words: t("web.setting.words.memory") },
  { id: "voice", group: "connect", icon: "call", label: t("web.setting.nav.voice"), words: t("web.setting.words.voice") },
  {
    id: "connections",
    group: "connect",
    icon: "chat",
    label: t("web.setting.nav.connections"),
    words: `${t("web.setting.words.connections")} ${t("web.setting.words.remote")}`,
  },
  { id: "about", group: "about", icon: "info", label: t("web.setting.nav.about"), words: t("web.setting.words.about") },
];

type ConnectionsTab = "chat" | "github" | "remote";

function legacyRedirect(rest: string): string | undefined {
  const [first, ...more] = rest.split("/");
  const tail = more.join("/");
  switch (first) {
    case "appearance":
      return "/settings/general";
    case "accounts":
    case "providers":
      return "/settings/models";
    case "call":
    case "moss":
      return "/settings/voice";
    case "chat":
      return tail ? `/settings/connections/chat/${tail}` : "/settings/connections/chat";
    case "github":
      return "/settings/connections/github";
    case "remote":
      return "/settings/connections/remote";
    default:
      return undefined;
  }
}

function VoiceSettings() {
  return (
    <Page title={t("web.setting.nav.voice")} hint={t("web.voice.moss.intro")}>
      <Readiness features={FeatureValues.filter((f) => f === "live" || f === "vision" || f === "call")} />
      <VoiceForm part="line" />
    </Page>
  );
}

function ConnectionsSettings(props: { sub: string | undefined; id: string | undefined }) {
  const router = useRouter();
  const tab = (): ConnectionsTab => (props.sub === "github" || props.sub === "remote" ? props.sub : "chat");
  return (
    <View class={`w-full gap-6 ${tab() === "chat" ? "" : "max-w-180"}`}>
      <Segmented
        label={t("web.setting.nav.connections")}
        testid="connections-subnav"
        value={tab()}
        options={[
          { value: "chat", label: t("web.setting.nav.chat") },
          { value: "github", label: "GitHub" },
          { value: "remote", label: t("web.setting.nav.remote") },
        ]}
        onChange={(v) => router.navigate(`/settings/connections/${v}`)}
      />
      <If when={tab() === "chat"}>
        <ConnectorsPage id={props.id} basePath="/settings/connections/chat" />
      </If>
      <If when={tab() === "github"}>
        <Page title="GitHub" hint={t("web.setting.github.note")}>
          <GitHub />
        </Page>
      </If>
      <If when={tab() === "remote"}>
        <RemoteAccessPage />
      </If>
    </View>
  );
}

function SectionBody(props: { id: string; sub: string | undefined; connectorId: string | undefined }) {
  return (
    <>
      <If when={props.id === "general"}>
        <Page title={t("web.setting.nav.general")} description={t("web.setting.general.intro")}>
          <GeneralGroups />
          <AppearanceGroups />
        </Page>
      </If>
      <If when={props.id === "models"}>
        <Page title={t("web.setting.nav.models")} hint={t("web.setting.models.intro")} action={<SettingsFile />}>
          <Readiness features={["orchestrator", "call"]} />
          <SettingsForm part="deepseek" />
          <ProviderModels />
        </Page>
      </If>
      <If when={props.id === "memory"}>
        <Page title={t("web.setting.nav.memory")} hint={t("web.setting.memory.intro")} action={<SettingsFile />}>
          <SettingsForm part="memory" />
        </Page>
      </If>
      <If when={props.id === "voice"}>
        <VoiceSettings />
      </If>
      <If when={props.id === "connections"}>
        <ConnectionsSettings sub={props.sub} id={props.connectorId} />
      </If>
      <If when={props.id === "about"}>
        <AboutPage />
      </If>
    </>
  );
}

/** `rest` is the path after /settings/. */
export function SettingsPage(props: { rest: string }) {
  /** Tailwind's md (48rem): narrower, the list sits over the section. */
  const md = computed(() => windowSize().width >= 768);
  const query = signal("");
  const q = computed(() => query().trim().toLowerCase());
  const parts = computed(() => props.rest.split("/"));
  const redirect = computed(() => legacyRedirect(props.rest));
  const sections = allSections();
  const section = computed(() => sections.find((s) => s.id === parts()[0]));
  const skillId = computed(() => (parts().length > 1 ? decodeURIComponent(parts().slice(1).join("/")) : undefined));
  const connectorId = computed(() => (parts().length > 2 ? decodeURIComponent(parts().slice(2).join("/")) : undefined));
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
                          {(s) => <SectionLink section={s()} current={s() === current()} />}
                        </Each>
                      </NavGroup>
                    </If>
                    <If when={connectShown().length > 0}>
                      <NavGroup title={t("web.setting.nav.groupConnect")}>
                        <Each of={connectShown()} key={(s) => s.id}>
                          {(s) => <SectionLink section={s()} current={s() === current()} />}
                        </Each>
                      </NavGroup>
                    </If>
                  </Scroll>
                  <If when={aboutShown().length > 0}>
                    <View class="shrink-0 border-t border-line px-2.5 py-2.5">
                      <Each of={aboutShown()} key={(s) => s.id}>
                        {(s) => <SectionLink section={s()} current={s() === current()} />}
                      </Each>
                    </View>
                  </If>
                </View>
                <If
                  when={current().id === "skills"}
                  else={
                    <Scroll testID={`settings-${current().id}`} class="min-h-0 min-w-0 flex-1 bg-page" contentClass={md() ? "px-8 py-7" : "px-5 py-5"}>
                      <Each of={[current()]} key={(s) => s.id}>
                        {(s) => <SectionBody id={s().id} sub={parts()[1]} connectorId={connectorId()} />}
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
        props.current ? "bg-selected" : "hover:bg-hover"
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
