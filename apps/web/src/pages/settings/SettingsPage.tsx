// 设置: its parts in a menu on the left, each its own address so a link lands on it; the
// first five are the server's settings in a card, the rest whole pages of their own.

import { settingsWording } from "./words";
import { For, Match, Show, Switch } from "solid-js";
import { Navigate } from "../../ui/A";
import { Keyed } from "../../base/util";
import { Card, ListCard, ListRow } from "../../ui/layout";
import { ConnectorsPage } from "./ConnectorsPage";
import { LanPage } from "../../features/lan/LanPage";
import { GitHub, LanguageForm, SettingsForm } from "./SettingsForm";
import { SkillsPage } from "../../features/runtime/SkillsPage";
import { VoiceForm } from "../../features/voice/VoiceForm";

export const sections = [
  { id: "deepseek", label: "DeepSeek", line: settingsWording().sections.deepseek.line },
  { id: "language", label: settingsWording().sections.language.label, line: settingsWording().sections.language.line },
  { id: "agora", label: settingsWording().sections.agora.label, line: settingsWording().sections.agora.line },
  { id: "memory", label: settingsWording().sections.memory.label, line: "Nowledge Mem、EverOS" },
  { id: "github", label: "GitHub", line: settingsWording().sections.github.line },
  { id: "connectors", label: settingsWording().sections.connectors.label, line: settingsWording().sections.connectors.line },
  { id: "skills", label: settingsWording().sections.skills.label, line: settingsWording().sections.skills.line },
  { id: "voice", label: settingsWording().sections.voice.label, line: settingsWording().sections.voice.line },
  { id: "lan", label: settingsWording().sections.lan.label, line: settingsWording().sections.lan.line },
] as const;

/** `rest` is the path after /settings/. */
export function SettingsPage(props: { rest: string }) {
  const parts = () => props.rest.split("/");
  const section = () => sections.find((s) => s.id === parts()[0]);
  const id = () => (parts().length > 1 ? decodeURIComponent(parts().slice(1).join("/")) : undefined);
  return (
    <Show when={section()} fallback={<Navigate href="/settings/deepseek" />}>
      {(section) => (
        <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 md:flex-row md:overflow-hidden">
          <div class="shrink-0 md:w-60 md:overflow-y-auto">
            <ListCard title={settingsWording().sections.title} label={settingsWording().sections.label}>
              <For each={sections}>{(s) => <ListRow to={`/settings/${s.id}`} active={s === section()} title={s.label} line={s.line} />}</For>
            </ListCard>
          </div>
          <div class="min-h-0 min-w-0 flex-1 md:overflow-y-auto">
            <Switch>
              <Match when={section().id === "deepseek" || section().id === "agora" || section().id === "memory"}>
                <Card title={section().label} class="max-w-3xl">
                  <Keyed key={section().id}>{() => <SettingsForm part={section().id as "deepseek" | "agora" | "memory"} />}</Keyed>
                </Card>
              </Match>
              <Match when={section().id === "language"}>
                <Card title={section().label} class="max-w-3xl">
                  <LanguageForm />
                </Card>
              </Match>
              <Match when={section().id === "github"}>
                <Card title={section().label} class="max-w-3xl">
                  <GitHub />
                </Card>
              </Match>
              <Match when={section().id === "connectors"}>
                <ConnectorsPage id={id()} />
              </Match>
              <Match when={section().id === "skills"}>
                <SkillsPage id={id()} />
              </Match>
              <Match when={section().id === "voice"}>
                <VoiceForm part="line" />
              </Match>
              <Match when={section().id === "lan"}>
                <LanPage />
              </Match>
            </Switch>
          </div>
        </div>
      )}
    </Show>
  );
}
