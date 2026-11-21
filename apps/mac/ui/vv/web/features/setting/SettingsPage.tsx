// Ported from VibeValley apps/web/src/features/setting/SettingsPage.tsx: the
// same sections, groups, search and resizable list, every section's forms.
// Not here: MOSS Live's playground (microphone and camera, features/voice).
import { Scroll, signal, Text, View, windowSize, type JSX } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { matches } from "../../base/search";
import { Link as A, Navigate } from "../../infra/router";
import { SettingsPage as Page, SettingsSearch } from "../../ui/domain/settings";
import { Icon } from "../../ui/Icon";
import type { IconName } from "../../ui/icons";
import { ActiveBar } from "../../ui/layout";
import { Splitter, usePaneWidth } from "../../ui/Splitter";
import { Bubble } from "../../ui/Tip";
import { ConnectorsPage } from "../connector";
import { MossAccounts, ProviderPage } from "../provider";
import { SkillsPage } from "../runtime";
import { VoiceForm } from "../voice";
import { AboutPage } from "./AboutPage";
import { AppearancePage } from "./AppearancePage";
import { GeneralPage } from "./GeneralPage";
import { Readiness } from "./Readiness";
import { GitHub, SettingsFile, SettingsForm } from "./SettingsForm";

/** The groups listed under their names. */
type Listed = "options" | "helpers" | "voice" | "connect";
// about stands apart at the foot of the list: what this copy is, not a setting.
type Group = Listed | "about";

const groups: readonly Listed[] = ["options", "helpers", "voice", "connect"];

interface Section {
  readonly id: string;
  readonly group: Group;
  readonly icon: IconName;
  readonly label: string;
  /** What else the search finds it by: the names of its settings. */
  readonly words: string;
}

const sections: readonly Section[] = [
  { id: "general", group: "options", icon: "settings", label: t("web.setting.nav.general"), words: t("web.setting.words.general") },
  { id: "appearance", group: "options", icon: "appearance", label: t("web.setting.nav.appearance"), words: t("web.setting.words.appearance") },
  { id: "accounts", group: "options", icon: "key", label: t("web.setting.nav.accounts"), words: t("web.setting.words.accounts") },
  { id: "providers", group: "options", icon: "plug", label: t("web.provider.title"), words: t("web.provider.words") },
  { id: "memory", group: "helpers", icon: "memory", label: t("web.setting.nav.memory"), words: t("web.setting.words.memory") },
  { id: "skills", group: "helpers", icon: "skill", label: t("web.setting.nav.skills"), words: t("web.setting.words.skills") },
  { id: "call", group: "voice", icon: "call", label: t("web.setting.nav.call"), words: t("web.setting.words.call") },
  { id: "moss", group: "voice", icon: "realtime", label: "MOSS Live", words: t("web.setting.words.moss") },
  { id: "dictation", group: "voice", icon: "record", label: t("web.setting.nav.dictation"), words: t("web.setting.words.dictation") },
  { id: "github", group: "connect", icon: "terminal", label: "GitHub", words: t("web.setting.words.github") },
  { id: "chat", group: "connect", icon: "chat", label: t("web.setting.nav.chat"), words: t("web.setting.words.chat") },
  { id: "about", group: "about", icon: "info", label: t("web.setting.nav.about"), words: t("web.setting.words.about") },
];

/** Tailwind's md (48rem): narrower, the list sits over the section. */
const md = () => windowSize().width >= 768;

/** `rest` is the path after /settings/. */
export function SettingsPage(props: { rest: string }) {
  const query = signal("");
  const q = () => query().trim().toLowerCase();
  const parts = () => props.rest.split("/");
  const section = () => sections.find((s) => s.id === parts()[0]);
  const id = () => (parts().length > 1 ? decodeURIComponent(parts().slice(1).join("/")) : undefined);
  const shown = (g: Group) => sections.filter((s) => s.group === g && matches(q(), [s.label, s.words]));
  const navWidth = usePaneWidth("settingsNav", 224, 176, 360);
  const body = (s: Section): JSX.Element => {
    switch (s.id) {
      case "general":
        return <GeneralPage />;
      case "appearance":
        return <AppearancePage />;
      case "accounts":
        return (
          <Page title={t("web.setting.nav.accounts")} hint={t("web.setting.accounts.intro")} action={<SettingsFile />}>
            <Readiness features={["orchestrator", "call"]} />
            <SettingsForm part="deepseek" />
            <MossAccounts />
            <VoiceForm part="line" view="accounts" />
          </Page>
        );
      case "providers":
        return <ProviderPage />;
      case "about":
        return <AboutPage />;
      case "memory":
        return (
          <Page title={t("web.setting.nav.memory")} hint={t("web.setting.memory.intro")} action={<SettingsFile />}>
            <SettingsForm part="memory" />
          </Page>
        );
      case "skills":
        return <SkillsPage id={id()} />;
      case "call":
        return (
          <Page title={t("web.setting.nav.call")}>
            <Readiness features={["call"]} />
            <VoiceForm part="line" view="call" />
          </Page>
        );
      case "moss":
        return (
          <Page title="MOSS Live" hint={t("web.voice.moss.intro")}>
            <Readiness features={["live", "vision"]} />
            <VoiceForm part="line" view="moss" />
          </Page>
        );
      case "dictation":
        return (
          <Page title={t("web.setting.nav.dictation")}>
            <Readiness features={["dictation"]} />
            <VoiceForm part="line" view="dictation" />
          </Page>
        );
      case "github":
        return (
          <Page title="GitHub" hint={t("web.setting.github.note")}>
            <GitHub />
          </Page>
        );
      default:
        return <ConnectorsPage id={id()} />;
    }
  };
  return (
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
                <View class="h-7 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2 transition duration-120 ease-out hover:border-faint focus-within:border-focus">
                  <Icon name="search" size={14} tone="faint" />
                  <Input
                    testID="settings-search"
                    accessibilityLabel={t("web.setting.nav.search")}
                    placeholder={t("web.setting.nav.search")}
                    value={query()}
                    onChange={(e) => query.set(e.value)}
                    class="min-w-0 flex-1 text-sm text-ink placeholder:text-faint"
                  />
                  <If when={query().length > 0}>
                    <View
                      role="button"
                      accessibilityLabel={t("web.issue.page.clear")}
                      tooltip={<Bubble text={t("web.issue.page.clear")} />}
                      onPress={() => query.set("")}
                      class="size-4 shrink-0 items-center justify-center rounded-xs hover:bg-hover"
                    >
                      <Icon name="close" size={10} tone="muted" />
                    </View>
                  </If>
                </View>
                <Each of={groups}>
                  {(g) => (
                    <If when={shown(g()).length > 0}>
                      <View class="gap-0.5">
                        <Text class="px-2 pb-1 text-2xs font-semibold text-faint">{t(`web.setting.groups.${g()}`)}</Text>
                        <Each of={shown(g())}>{(s) => <SectionLink section={s()} current={s() === current()} />}</Each>
                      </View>
                    </If>
                  )}
                </Each>
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
  );
}

function SectionLink(props: { section: Section; current: boolean }) {
  return (
    <A
      href={`/settings/${props.section.id}`}
      testID={`settings-section-${props.section.id}`}
      accessibilityLabel={props.section.label}
      accessibilityState={{ selected: props.current }}
      class={`relative group h-7 flex-row items-center gap-2 rounded-md px-2 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${props.current ? "bg-selected" : "hover:bg-hover"}`}
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
