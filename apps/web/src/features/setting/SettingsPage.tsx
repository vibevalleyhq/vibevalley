// 设置: its parts in a menu on the left, each its own address so a link lands on it; the
// first four are the server's settings in a card, the rest whole pages of their own.

import { voiceWording, VoiceForm } from "../voice";
import { runtimesWording, SkillsPage } from "../runtime";
import { lanWording, LanPage } from "../lan";
import { connectorWording, ConnectorsPage } from "../connector";
import { settingsWording } from "./words";
import { For, Match, Show, Switch } from "solid-js";
import { Navigate } from "../../ui/A";
import { Keyed } from "../../base/util";
import { Card, ListCard, ListRow } from "../../ui/layout";
import { GitHub, LanguageForm, SettingsFile, SettingsForm } from "./SettingsForm";
import { Hint } from "../../ui/Tip";

export const sections = [
  { id: "deepseek", label: "DeepSeek", line: settingsWording().sections.deepseek.line },
  { id: "language", label: settingsWording().sections.language.label, line: settingsWording().sections.language.line },
  { id: "memory", label: settingsWording().sections.memory.label, line: "Nowledge Mem、EverOS" },
  { id: "github", label: "GitHub", line: settingsWording().sections.github.line },
  { id: "connectors", label: connectorWording().connectors.section.label, line: connectorWording().connectors.section.line },
  { id: "skills", label: runtimesWording().library.section.label, line: runtimesWording().library.section.line },
  { id: "voice", label: voiceWording().voice.section.label, line: voiceWording().voice.section.line },
  { id: "lan", label: lanWording().lan.section.label, line: lanWording().lan.section.line },
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
              <Match when={section().id === "deepseek" || section().id === "memory"}>
                <Card title={section().label} action={<SettingsFile />} class="max-w-3xl">
                  <Keyed key={section().id}>{() => <SettingsForm part={section().id as "deepseek" | "memory"} />}</Keyed>
                </Card>
              </Match>
              <Match when={section().id === "language"}>
                <Card title={section().label} action={<Hint text={settingsWording().language.line} />} class="max-w-3xl">
                  <LanguageForm />
                </Card>
              </Match>
              <Match when={section().id === "github"}>
                <Card title={section().label} action={<Hint text={settingsWording().github.note} />} class="max-w-3xl">
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
