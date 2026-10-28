import { t } from "@vibevalley/i18n";
// 设置: a search over it, then its sections in groups on the left, each an icon and a name with its own address, so a
// link lands on it; the chosen one on the right, as groups of rows (ui/settings.tsx). The search keeps the sections
// whose name or words hold it, and lights the rows that do.

import { Splitter, usePaneWidth } from "../../ui/Splitter";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { IconName } from "../../ui/icons";
import { SkillsPage } from "../runtime";
import { LanPage } from "../lan";
import { ConnectorsPage } from "../connector";
import { MossPlayground, VoiceForm } from "../voice";
import { A, Navigate } from "../../ui/A";
import { Icon } from "../../ui/Icon";
import { TextInput } from "../../ui/Field";
import { matches, SettingsPage as Page, SettingsSearch } from "../../ui/settings";
import { AboutPage } from "./AboutPage";
import { AppearancePage } from "./AppearancePage";
import { GeneralPage } from "./GeneralPage";
import { GitHub, SettingsFile, SettingsForm } from "./SettingsForm";

type Group = "options" | "helpers" | "voice" | "connect";

const groups: readonly Group[] = ["options", "helpers", "voice", "connect"];

interface Section {
  readonly id: string;
  readonly group: Group;
  readonly icon: IconName;
  readonly label: string;
  /** What else the search finds it by: the names of its settings. */
  readonly words: string;
}

export const sections: readonly Section[] = [
  { id: "general", group: "options", icon: "settings", label: t("web.setting.nav.general"), words: t("web.setting.words.general") },
  { id: "appearance", group: "options", icon: "appearance", label: t("web.setting.nav.appearance"), words: t("web.setting.words.appearance") },
  { id: "models", group: "options", icon: "key", label: t("web.setting.nav.models"), words: t("web.setting.words.models") },
  { id: "about", group: "options", icon: "info", label: t("web.setting.nav.about"), words: t("web.setting.words.about") },
  { id: "memory", group: "helpers", icon: "memory", label: t("web.setting.nav.memory"), words: t("web.setting.words.memory") },
  { id: "skills", group: "helpers", icon: "skill", label: t("web.setting.nav.skills"), words: t("web.setting.words.skills") },
  { id: "call", group: "voice", icon: "call", label: t("web.setting.nav.call"), words: t("web.setting.words.call") },
  { id: "moss", group: "voice", icon: "realtime", label: "MOSS Live", words: t("web.setting.words.moss") },
  { id: "dictation", group: "voice", icon: "record", label: t("web.setting.nav.dictation"), words: t("web.setting.words.dictation") },
  { id: "github", group: "connect", icon: "terminal", label: "GitHub", words: t("web.setting.words.github") },
  { id: "chat", group: "connect", icon: "chat", label: t("web.setting.nav.chat"), words: t("web.setting.words.chat") },
  { id: "devices", group: "connect", icon: "devices", label: t("web.setting.nav.devices"), words: t("web.setting.words.devices") },
];

/** `rest` is the path after /settings/. */
export function SettingsPage(props: { rest: string }) {
  const [query, setQuery] = createSignal("");
  const q = () => query().trim().toLowerCase();
  const parts = () => props.rest.split("/");
  const section = () => sections.find((s) => s.id === parts()[0]);
  const id = () => (parts().length > 1 ? decodeURIComponent(parts().slice(1).join("/")) : undefined);
  const shown = (g: Group) => sections.filter((s) => s.group === g && (q() === "" || matches(q(), s.label, s.words)));
  const navWidth = usePaneWidth("settingsNav", 224, 176, 360);
  return (
    <Show when={section()} fallback={<Navigate href="/settings/general" />}>
      {(section) => (
        <SettingsSearch value={q}>
          <div class="flex h-full min-h-0 flex-col md:flex-row">
            <nav
              aria-label={t("web.setting.nav.label")}
              class="relative flex shrink-0 flex-col gap-4 border-line p-3 md:w-(--pane-w) md:overflow-y-auto md:border-r"
              style={{ "--pane-w": `${navWidth()}px` }}
            >
              <div class="hidden md:block">
                <Splitter pane="settingsNav" side="right" width={navWidth()} min={176} max={360} label={t("web.setting.nav.width")} />
              </div>
              <TextInput
                type="search"
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
                      <For each={shown(g)}>
                        {(s) => (
                          <A
                            href={`/settings/${s.id}`}
                            aria-current={s === section() ? "page" : undefined}
                            class={[
                              "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
                              s === section() ? "bg-selected font-medium text-ink" : "text-muted hover:bg-hover hover:text-ink",
                            ]}
                          >
                            <Icon name={s.icon} size={16} />
                            {s.label}
                          </A>
                        )}
                      </For>
                    </div>
                  </Show>
                )}
              </For>
            </nav>
            <div class="scroll-fade-y min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
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
                  <LanPage />
                </Match>
              </Switch>
            </div>
          </div>
        </SettingsSearch>
      )}
    </Show>
  );
}
