import { t } from "@vibevalley/i18n";
// 关于: the server's version, and where the farm keeps its files; copied, or shown in Finder where the host can.

import { For, Show } from "solid-js";
import { reasonOf } from "@/base/api";
import { currentHost } from "@/base/host";
import { ready, useSettings } from "@/base/query";
import { IconButton } from "@/ui/IconButton";
import { Quiet } from "@/ui/layout";
import { SettingRow, SettingsGroup, SettingsPage } from "@/ui/settings";
import { toast } from "@/ui/toasts";

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
        fallback={<Quiet>{settings.error ? t("web.base.form.unreachable", { why: reasonOf(settings.error) }) : t("web.base.form.asking")}</Quiet>}
      >
        {(s) => (
          <>
            <SettingsGroup>
              <SettingRow label={t("web.setting.about.version")} hint={t("web.setting.about.versionHint")}>
                <span class="font-mono text-sm">{s().version}</span>
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title={t("web.setting.about.files")}>
              <For
                each={[
                  { label: t("web.setting.about.home"), hint: t("web.setting.about.homeHint"), path: s().home },
                  { label: t("web.setting.about.settings"), hint: t("web.setting.about.settingsHint"), path: s().file },
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
