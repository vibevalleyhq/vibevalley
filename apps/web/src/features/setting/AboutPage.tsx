import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { reasonOf } from "#/infra/api.ts";
import { currentHost } from "#/infra/host.ts";
import { ready, useSettings } from "#/infra/query.ts";
import { SettingRow, SettingsGroup, SettingsPage } from "#/ui/domain/settings.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { Quiet } from "#/ui/layout.tsx";
import { toast } from "#/ui/toasts.ts";

import { CommandLineRow, UpdateRow } from "./UpdateRow";

function PathRow(props: { label: string; hint: string; path: string }) {
  const reveal = currentHost().reveal;
  return (
    <SettingRow label={props.label} hint={props.hint}>
      <span class="max-w-80 truncate font-mono text-xs text-muted" title={props.path}>
        {props.path}
      </span>
      <IconButton
        icon="copy"
        label={t("web.setting.about.copy")}
        onClick={() =>
          void navigator.clipboard.writeText(props.path).then(
            () => toast(t("web.setting.about.copied")),
            () => undefined,
          )
        }
      />
      <Show when={reveal}>{(r) => <IconButton icon="open" label={t("web.setting.about.reveal")} onClick={() => r()(props.path)} />}</Show>
    </SettingRow>
  );
}

export function AboutPage() {
  const settings = useSettings();
  return (
    <SettingsPage title={t("web.setting.nav.about")}>
      <Show
        when={ready(settings, undefined)}
        fallback={<Quiet>{settings.error() ? t("web.base.form.unreachable", { why: reasonOf(settings.error()) }) : t("web.base.form.asking")}</Quiet>}
      >
        {(s) => (
          <>
            <SettingsGroup>
              <SettingRow label={t("web.setting.about.version")} hint={t("web.setting.about.versionHint")}>
                <span class="font-mono text-sm">{s().version}</span>
              </SettingRow>
              <UpdateRow />
              <CommandLineRow />
            </SettingsGroup>
            <SettingsGroup title={t("web.setting.about.files")}>
              <For
                each={[
                  { label: t("web.setting.about.home"), hint: t("web.setting.about.homeHint"), path: s().home },
                  { label: t("web.setting.about.settings"), hint: t("web.setting.about.settingsHint"), path: s().file },
                  { label: t("web.setting.about.repos"), hint: t("web.setting.about.reposHint"), path: s().paths.repos },
                  { label: t("web.setting.about.worktrees"), hint: t("web.setting.about.worktreesHint"), path: s().paths.worktrees },
                  { label: t("web.setting.about.pkm"), hint: t("web.setting.about.pkmHint"), path: s().paths.pkm },
                ]}
              >
                {(p) => <PathRow label={p.label} hint={p.hint} path={p.path} />}
              </For>
            </SettingsGroup>
          </>
        )}
      </Show>
    </SettingsPage>
  );
}
