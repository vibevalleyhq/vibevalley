import { computed, Scroll, signal, Text, View, windowSize } from "nsh";

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

type Group = "main" | "about";

interface Section {
  readonly id: string;
  readonly group: Group;
  readonly icon: IconName;
  readonly label: string;
  /** What else the search finds it by: the names of its settings. */
  readonly words: string;
}

const allSections = (): readonly Section[] => [
  { id: "general", group: "main", icon: "settings", label: t("web.setting.nav.general"), words: t("web.setting.words.general") },
  { id: "models", group: "main", icon: "plug", label: t("web.setting.nav.models"), words: t("web.setting.words.models") },
  { id: "skills", group: "main", icon: "skill", label: t("web.setting.nav.skills"), words: t("web.setting.words.skills") },
  { id: "memory", group: "main", icon: "memory", label: t("web.setting.nav.memory"), words: t("web.setting.words.memory") },
  { id: "voice", group: "main", icon: "call", label: t("web.setting.nav.voice"), words: t("web.setting.words.voice") },
  {
    id: "connections",
    group: "main",
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
    <View class="gap-4">
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
        <Page title={t("web.setting.nav.general")}>
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
  const mainShown = computed(() => sections.filter((s) => s.group === "main" && matches(q(), [s.label, s.words])));
  const aboutShown = computed(() => sections.filter((s) => s.group === "about" && matches(q(), [s.label, s.words])));
  const navWidth = usePaneWidth("settingsNav", 224, 176, 360);
  return (
    <If
      when={redirect()}
      else={
        <If when={section()} else={<Navigate href="/settings/general" />}>
          {(current) => (
            <SettingsSearch.Provider value={q}>
              <View class={`h-full min-h-0 flex-1 ${md() ? "flex-row" : ""}`}>
                <View class={`shrink-0 border-line bg-side ${md() ? "border-r" : "max-h-56 border-b"}`} style={md() ? { width: navWidth() } : undefined}>
                  <If when={md()}>
                    <Splitter pane="settingsNav" side="right" width={navWidth()} min={176} max={360} label={t("web.setting.nav.width")} />
                  </If>
                  <Scroll
                    accessibilityLabel={t("web.setting.nav.label")}
                    testID="settings-nav"
                    class={md() ? "flex-1" : "shrink"}
                    contentClass={`gap-4 p-3 ${md() ? "min-h-full" : ""}`}
                  >
                    <SearchField
                      testid="settings-search"
                      value={query()}
                      onInput={(v) => query.set(v)}
                      placeholder={t("web.setting.nav.search")}
                      label={t("web.setting.nav.search")}
                    />
                    <If when={mainShown().length > 0}>
                      <View class="gap-0.5">
                        <Each of={mainShown()} key={(s) => s.id}>
                          {(s) => <SectionLink section={s()} current={s() === current()} />}
                        </Each>
                      </View>
                    </If>
                    <View class="flex-1" />
                    <Each of={aboutShown()} key={(s) => s.id}>
                      {(s) => (
                        <View class="border-t border-line pt-3">
                          <SectionLink section={s()} current={s() === current()} />
                        </View>
                      )}
                    </Each>
                  </Scroll>
                </View>
                <If
                  when={current().id === "skills"}
                  else={
                    <Scroll testID={`settings-${current().id}`} class="min-h-0 min-w-0 flex-1 bg-page" contentClass="px-6 py-5">
                      <Each of={[current()]} key={(s) => s.id}>
                        {(s) => <SectionBody id={s().id} sub={parts()[1]} connectorId={connectorId()} />}
                      </Each>
                    </Scroll>
                  }
                >
                  <View testID="settings-skills" class="min-h-0 min-w-0 flex-1 bg-page px-6 py-5">
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

function SectionLink(props: { section: Section; current: boolean }) {
  return (
    <A
      href={`/settings/${props.section.id}`}
      testID={`settings-section-${props.section.id}`}
      accessibilityLabel={props.section.label}
      accessibilityState={{ selected: props.current }}
      class={`relative group h-7 flex-row items-center gap-2 rounded-md px-2 focus-visible:outline-2 focus-visible:outline-focus ${props.current ? "bg-selected" : "hover:bg-hover"}`}
    >
      <If when={props.current}>
        <ActiveBar />
      </If>
      <View class="w-4 shrink-0 items-center justify-center">
        <Icon name={props.section.icon} size={14} tone={props.current ? "ink" : "muted"} />
      </View>
      <Text class={`min-w-0 flex-1 truncate text-sm font-medium ${props.current ? "text-ink" : "text-muted group-hover:text-ink"}`}>{props.section.label}</Text>
    </A>
  );
}
