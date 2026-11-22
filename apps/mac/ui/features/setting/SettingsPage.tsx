import { Scroll, signal, Text, View, windowSize, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

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
import { VoiceForm } from "../voice";
import { AboutPage } from "./AboutPage";
import { AppearanceGroups } from "./AppearancePage";
import { GeneralGroups } from "./GeneralPage";
import { Readiness } from "./Readiness";
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

const sections: readonly Section[] = [
  { id: "general", group: "main", icon: "settings", label: t("web.setting.nav.general"), words: t("web.setting.words.general") },
  { id: "models", group: "main", icon: "plug", label: t("web.setting.nav.models"), words: t("web.setting.words.models") },
  { id: "voice", group: "main", icon: "call", label: t("web.setting.nav.voice"), words: t("web.setting.words.voice") },
  { id: "connections", group: "main", icon: "chat", label: t("web.setting.nav.connections"), words: t("web.setting.words.connections") },
  { id: "about", group: "about", icon: "info", label: t("web.setting.nav.about"), words: t("web.setting.words.about") },
];

type VoiceTab = "call" | "moss" | "dictation";
type ConnectionsTab = "chat" | "github";

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
    case "dictation":
      return `/settings/voice/${first}`;
    case "chat":
      return tail ? `/settings/connections/chat/${tail}` : "/settings/connections/chat";
    case "github":
      return "/settings/connections/github";
    case "skills":
      return tail ? `/team/skills/${tail}` : "/team/skills";
    case "memory":
      return "/team/memory";
    default:
      return undefined;
  }
}

function VoiceSettings(props: { sub: string | undefined }) {
  const router = useRouter();
  const tab = (): VoiceTab => (props.sub === "moss" || props.sub === "dictation" ? props.sub : "call");
  const features = () => (tab() === "moss" ? (["live", "vision"] as const) : tab() === "dictation" ? (["dictation"] as const) : (["call"] as const));
  return (
    <Page title={t("web.setting.nav.voice")} hint={tab() === "moss" ? t("web.voice.moss.intro") : undefined}>
      <Segmented
        label={t("web.setting.nav.voice")}
        testid="voice-subnav"
        value={tab()}
        options={[
          { value: "call", label: t("web.setting.nav.call") },
          { value: "moss", label: "MOSS Live" },
          { value: "dictation", label: t("web.setting.nav.dictation") },
        ]}
        onChange={(v) => router.navigate(`/settings/voice/${v}`)}
      />
      <Readiness features={features()} />
      <VoiceForm part="line" view={tab()} />
    </Page>
  );
}

function ConnectionsSettings(props: { sub: string | undefined; id: string | undefined }) {
  const router = useRouter();
  const tab = (): ConnectionsTab => (props.sub === "github" ? "github" : "chat");
  return (
    <View class="gap-4">
      <Segmented
        label={t("web.setting.nav.connections")}
        testid="connections-subnav"
        value={tab()}
        options={[
          { value: "chat", label: t("web.setting.nav.chat") },
          { value: "github", label: "GitHub" },
        ]}
        onChange={(v) => router.navigate(`/settings/connections/${v}`)}
      />
      <If when={tab() === "github"} else={<ConnectorsPage id={props.id} basePath="/settings/connections/chat" />}>
        <Page title="GitHub" hint={t("web.setting.github.note")}>
          <GitHub />
        </Page>
      </If>
    </View>
  );
}

/** At /team/memory, under the Team place. */
export function TeamMemoryPage() {
  return (
    <Scroll testID="team-memory-page" class="min-h-0 min-w-0 flex-1 bg-page" contentClass="px-6 py-5">
      <Page title={t("web.setting.nav.memory")} hint={t("web.setting.memory.intro")} action={<SettingsFile />}>
        <SettingsForm part="memory" />
      </Page>
    </Scroll>
  );
}

/** Tailwind's md (48rem): narrower, the list sits over the section. */
const md = () => windowSize().width >= 768;

/** `rest` is the path after /settings/. */
export function SettingsPage(props: { rest: string }) {
  const query = signal("");
  const q = () => query().trim().toLowerCase();
  const parts = () => props.rest.split("/");
  const redirect = () => legacyRedirect(props.rest);
  const section = () => sections.find((s) => s.id === parts()[0]);
  const connectorId = () => (parts().length > 2 ? decodeURIComponent(parts().slice(2).join("/")) : undefined);
  const shown = (g: Group) => sections.filter((s) => s.group === g && matches(q(), [s.label, s.words]));
  const navWidth = usePaneWidth("settingsNav", 224, 176, 360);
  const body = (s: Section): JSX.Element => {
    switch (s.id) {
      case "general":
        return (
          <Page title={t("web.setting.nav.general")}>
            <GeneralGroups />
            <AppearanceGroups />
          </Page>
        );
      case "models":
        return (
          <Page title={t("web.setting.nav.models")} hint={t("web.setting.models.intro")} action={<SettingsFile />}>
            <Readiness features={["orchestrator", "call"]} />
            <SettingsForm part="deepseek" />
            <ProviderModels />
            <VoiceForm part="line" view="accounts" />
          </Page>
        );
      case "voice":
        return <VoiceSettings sub={parts()[1]} />;
      case "connections":
        return <ConnectionsSettings sub={parts()[1]} id={connectorId()} />;
      default:
        return <AboutPage />;
    }
  };
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
                    <If when={shown("main").length > 0}>
                      <View class="gap-0.5">
                        <Each of={shown("main")}>{(s) => <SectionLink section={s()} current={s() === current()} />}</Each>
                      </View>
                    </If>
                    <View class="flex-1" />
                    <Each of={shown("about")}>
                      {(s) => (
                        <View class="border-t border-line pt-3">
                          <SectionLink section={s()} current={s() === current()} />
                        </View>
                      )}
                    </Each>
                  </Scroll>
                </View>
                <Scroll testID={`settings-${current().id}`} class="min-h-0 min-w-0 flex-1 bg-page" contentClass="px-6 py-5">
                  <Each of={[current()]}>{(s) => body(s())}</Each>
                </Scroll>
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
