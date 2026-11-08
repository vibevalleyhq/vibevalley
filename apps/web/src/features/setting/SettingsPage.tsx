import { createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";

import { matches } from "#/base/search.ts";
import { ConnectorsPage } from "#/features/connector/index.ts";
import { LanPage } from "#/features/lan/index.ts";
import { ProviderPage } from "#/features/provider/index.ts";
import { SkillsPage } from "#/features/runtime/index.ts";
import { MossPlayground, VoiceForm } from "#/features/voice/index.ts";
import { Link as A, Navigate } from "#/infra/router.ts";
import { TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";
import { SettingsPage as Page, SettingsSearch } from "#/ui/settings.tsx";
import { Splitter, usePaneWidth } from "#/ui/Splitter.tsx";

import { AboutPage } from "./AboutPage";
import { AppearancePage } from "./AppearancePage";
import { GeneralPage } from "./GeneralPage";
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
  { id: "models", group: "options", icon: "key", label: t("web.setting.nav.models"), words: t("web.setting.words.models") },
  { id: "providers", group: "options", icon: "plug", label: t("web.provider.title"), words: t("web.provider.words") },
  { id: "memory", group: "helpers", icon: "memory", label: t("web.setting.nav.memory"), words: t("web.setting.words.memory") },
  { id: "skills", group: "helpers", icon: "skill", label: t("web.setting.nav.skills"), words: t("web.setting.words.skills") },
  { id: "call", group: "voice", icon: "call", label: t("web.setting.nav.call"), words: t("web.setting.words.call") },
  { id: "moss", group: "voice", icon: "realtime", label: "MOSS Live", words: t("web.setting.words.moss") },
  { id: "dictation", group: "voice", icon: "record", label: t("web.setting.nav.dictation"), words: t("web.setting.words.dictation") },
  { id: "github", group: "connect", icon: "terminal", label: "GitHub", words: t("web.setting.words.github") },
  { id: "chat", group: "connect", icon: "chat", label: t("web.setting.nav.chat"), words: t("web.setting.words.chat") },
  { id: "devices", group: "connect", icon: "devices", label: t("web.setting.nav.devices"), words: t("web.setting.words.devices") },
  { id: "about", group: "about", icon: "info", label: t("web.setting.nav.about"), words: t("web.setting.words.about") },
];

/** `rest` is the path after /settings/. */
export function SettingsPage(props: { rest: string }) {
  const [query, setQuery] = createSignal("");
  const q = () => query().trim().toLowerCase();
  const parts = () => props.rest.split("/");
  const section = () => sections.find((s) => s.id === parts()[0]);
  const id = () => (parts().length > 1 ? decodeURIComponent(parts().slice(1).join("/")) : undefined);
  const shown = (g: Group) => sections.filter((s) => s.group === g && matches(q(), [s.label, s.words]));
  const navWidth = usePaneWidth("settingsNav", 224, 176, 360);
  return (
    <Show when={section()} fallback={<Navigate href="/settings/general" />}>
      {(section) => (
        <SettingsSearch value={q}>
          <div class="flex h-full min-h-0 flex-col md:flex-row">
            <nav
              aria-label={t("web.setting.nav.label")}
              data-testid="settings-nav"
              class="relative flex max-h-56 shrink-0 flex-col gap-4 overflow-y-auto border-line p-3 md:max-h-none md:w-(--pane-w) md:border-r"
              style={{ "--pane-w": `${navWidth()}px` }}
            >
              <div class="hidden md:block">
                <Splitter pane="settingsNav" side="right" width={navWidth()} min={176} max={360} label={t("web.setting.nav.width")} />
              </div>
              <TextInput
                type="search"
                data-testid="settings-search"
                aria-label={t("web.setting.nav.search")}
                placeholder={t("web.setting.nav.search")}
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <For each={groups}>
                {(g) => (
                  <Show when={shown(g).length > 0}>
                    <div class="flex flex-col gap-0.5">
                      <span class="px-2 pb-1 text-xs font-medium text-faint">{t(`web.setting.groups.${g}`)}</span>
                      <For each={shown(g)}>{(s) => <SectionLink section={s} current={s === section()} />}</For>
                    </div>
                  </Show>
                )}
              </For>
              <For each={shown("about")}>
                {(s) => (
                  <div class="flex flex-col border-t border-line pt-3 md:mt-auto">
                    <SectionLink section={s} current={s === section()} />
                  </div>
                )}
              </For>
            </nav>
            <div class="min-h-0 min-w-0 flex-1 scroll-fade-y overflow-y-auto p-5">
              <Switch>
                <Match when={section().id === "general"}>
                  <GeneralPage />
                </Match>
                <Match when={section().id === "appearance"}>
                  <AppearancePage />
                </Match>
                <Match when={section().id === "models"}>
                  <Page title={t("web.setting.nav.models")} hint={t("web.setting.models.intro")} action={<SettingsFile />}>
                    <SettingsForm part="deepseek" />
                  </Page>
                </Match>
                <Match when={section().id === "providers"}>
                  <ProviderPage />
                </Match>
                <Match when={section().id === "about"}>
                  <AboutPage />
                </Match>
                <Match when={section().id === "memory"}>
                  <Page title={t("web.setting.nav.memory")} hint={t("web.setting.memory.intro")} action={<SettingsFile />}>
                    <SettingsForm part="memory" />
                  </Page>
                </Match>
                <Match when={section().id === "skills"}>
                  <SkillsPage id={id()} />
                </Match>
                <Match when={section().id === "call"}>
                  <Page title={t("web.setting.nav.call")}>
                    <VoiceForm part="line" view="call" />
                  </Page>
                </Match>
                <Match when={section().id === "moss"}>
                  <Page title="MOSS Live" hint={t("web.voice.moss.intro")}>
                    <VoiceForm part="line" view="moss" />
                    <MossPlayground />
                  </Page>
                </Match>
                <Match when={section().id === "dictation"}>
                  <Page title={t("web.setting.nav.dictation")}>
                    <VoiceForm part="line" view="dictation" />
                  </Page>
                </Match>
                <Match when={section().id === "github"}>
                  <Page title="GitHub" hint={t("web.setting.github.note")}>
                    <GitHub />
                  </Page>
                </Match>
                <Match when={section().id === "chat"}>
                  <ConnectorsPage id={id()} />
                </Match>
                <Match when={section().id === "devices"}>
                  <Page title={t("web.setting.nav.devices")}>
                    <LanPage />
                  </Page>
                </Match>
              </Switch>
            </div>
          </div>
        </SettingsSearch>
      )}
    </Show>
  );
}

function SectionLink(props: { section: Section; current: boolean }) {
  return (
    <A
      href={`/settings/${props.section.id}`}
      data-key={props.section.id}
      aria-current={props.current ? "page" : undefined}
      class={[
        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
        props.current ? "bg-selected font-medium text-ink" : "text-muted hover:bg-hover hover:text-ink",
      ]}
    >
      <Icon name={props.section.icon} size={16} />
      {props.section.label}
    </A>
  );
}
