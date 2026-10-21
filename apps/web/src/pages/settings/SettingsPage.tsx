// 设置: its parts in a menu on the left, each its own address so a link lands on it; the
// first four are the server's settings in a card, the rest whole pages of their own.

import { For, Match, Show, Switch } from "solid-js";
import { Navigate } from "../../app/A";
import { Keyed } from "../../app/util";
import { Card, ListCard, ListRow } from "../kit";
import { ConnectorsPage } from "./ConnectorsPage";
import { LanPage } from "./LanPage";
import { GitHub, SettingsForm } from "./SettingsForm";
import { SkillsPage } from "./SkillsPage";
import { VoiceForm } from "./VoiceForm";

export const sections = [
  { id: "deepseek", label: "DeepSeek", line: "管家用的钥匙" },
  { id: "agora", label: "Agora 语音", line: "App ID 和 Certificate" },
  { id: "memory", label: "记性", line: "Nowledge Mem、EverOS" },
  { id: "github", label: "GitHub", line: "gh 和登录，能不能提 PR" },
  { id: "connectors", label: "连接器", line: "微信 飞书 QQ" },
  { id: "skills", label: "技能", line: "帮工能带的技能" },
  { id: "voice", label: "声音", line: "和管家打电话" },
  { id: "lan", label: "连接到本机", line: "手机和别的电脑" },
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
            <ListCard title="设置" label="设置的分区">
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
