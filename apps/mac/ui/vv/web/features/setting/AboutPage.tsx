// Ported from VibeValley apps/web/src/features/setting/AboutPage.tsx.
import { Clipboard, Text } from "nsh";

import { t } from "@vibevalley/i18n";

import { reasonOf } from "../../infra/api";
import { currentHost } from "../../infra/host";
import { ready, useSettings } from "../../infra/query";
import { useUpdates } from "../../infra/settings";
import { SettingRow, SettingsGroup, SettingsPage } from "../../ui/domain/settings";
import { IconButton } from "../../ui/IconButton";
import { Quiet } from "../../ui/layout";
import { Tip } from "../../ui/Tip";
import { toast } from "../../ui/toasts";
import { CommandLineRow, UpdateRow, useCommandLine } from "./UpdateRow";

function PathRow(props: { label: string; hint: string; path: string; last?: boolean }) {
  const reveal = currentHost().reveal;
  return (
    <SettingRow label={props.label} hint={props.hint} last={props.last}>
      <Tip text={props.path}>
        <Text class="max-w-80 truncate font-mono text-xs text-muted">{props.path}</Text>
      </Tip>
      <IconButton
        icon="copy"
        label={t("web.setting.about.copy")}
        onClick={() =>
          void Clipboard.writeText(props.path).then(
            () => toast(t("web.setting.about.copied")),
            () => undefined,
          )
        }
      />
      <If when={reveal}>{(r) => <IconButton icon="open" label={t("web.setting.about.reveal")} onClick={() => r()(props.path)} />}</If>
    </SettingRow>
  );
}

export function AboutPage() {
  const settings = useSettings();
  const updates = useUpdates();
  const cli = useCommandLine();
  return (
    <SettingsPage title={t("web.setting.nav.about")}>
      <If
        when={ready(settings, undefined)}
        else={<Quiet>{settings.error() ? t("web.base.form.unreachable", { why: reasonOf(settings.error()) }) : t("web.base.form.asking")}</Quiet>}
      >
        {(s) => (
          <>
            <SettingsGroup>
              <SettingRow label={t("web.setting.about.version")} hint={t("web.setting.about.versionHint")} last={!updates() && !cli.state()}>
                <Text testID="about-version" class="font-mono text-sm text-ink">
                  {s().version}
                </Text>
              </SettingRow>
              <UpdateRow state={updates} last={!cli.state()} />
              <CommandLineRow state={cli.state} onInstall={cli.install} onRemove={cli.remove} last />
            </SettingsGroup>
            <SettingsGroup title={t("web.setting.about.files")}>
              <Each
                of={[
                  { label: t("web.setting.about.home"), hint: t("web.setting.about.homeHint"), path: s().home },
                  { label: t("web.setting.about.settings"), hint: t("web.setting.about.settingsHint"), path: s().file },
                  { label: t("web.setting.about.repos"), hint: t("web.setting.about.reposHint"), path: s().paths.repos },
                  { label: t("web.setting.about.worktrees"), hint: t("web.setting.about.worktreesHint"), path: s().paths.worktrees },
                  { label: t("web.setting.about.pkm"), hint: t("web.setting.about.pkmHint"), path: s().paths.pkm },
                ]}
              >
                {(p, i) => <PathRow label={p().label} hint={p().hint} path={p().path} last={i() === 4} />}
              </Each>
            </SettingsGroup>
          </>
        )}
      </If>
    </SettingsPage>
  );
}
