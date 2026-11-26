import { Clipboard, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { SettingRow, SettingsGroup, SettingsPage } from "../../design/domain/settings";
import { IconButton } from "../../design/IconButton";
import { Quiet } from "../../design/layout";
import { Tag } from "../../design/Tag";
import { Tip } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { reasonOf } from "../../infra/api";
import { currentHost } from "../../infra/host";
import { ready, useSettings } from "../../infra/query";
import { useUpdates } from "../../infra/settings";
import { CommandLineRow, UpdateRow, useCommandLine } from "./UpdateRow";

function PathRow(props: { label: string; hint: string; path: string; last?: boolean }) {
  const reveal = currentHost().reveal;
  return (
    <SettingRow label={props.label} hint={props.hint} last={props.last}>
      <Tip text={props.path}>
        <View class="max-w-72 rounded-md border border-line bg-side px-2 py-0.5">
          <Text class="truncate font-mono text-xs text-muted">{props.path}</Text>
        </View>
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

function backendLabel(backend: string | undefined): string {
  switch (backend) {
    case "s3":
      return t("web.setting.data.backendS3");
    case "memory":
      return t("web.setting.data.backendMemory");
    default:
      return t("web.setting.data.backendLocalFs");
  }
}

export function DataSettingsPage() {
  const settings = useSettings();
  return (
    <SettingsPage title={t("web.setting.nav.data")} description={t("web.setting.data.intro")}>
      <If
        when={ready(settings, undefined)}
        else={<Quiet>{settings.error() ? t("web.base.form.unreachable", { why: reasonOf(settings.error()) }) : t("web.base.form.asking")}</Quiet>}
      >
        {(s) => (
          <>
            <SettingsGroup title={t("web.setting.data.storageTitle")}>
              <SettingRow label={t("web.setting.data.backend")} hint={t("web.setting.data.backendHint")} testid="data-storage-backend" last>
                <Tag icon="folder" tone="neutral" label={backendLabel(s().storageBackend)} />
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title={t("web.setting.about.files")}>
              <Each
                of={[
                  { label: t("web.setting.about.home"), hint: t("web.setting.about.homeHint"), path: s().home },
                  { label: t("web.setting.about.settings"), hint: t("web.setting.about.settingsHint"), path: s().file },
                  { label: t("web.setting.about.repos"), hint: t("web.setting.about.reposHint"), path: s().paths.repos },
                  { label: t("web.setting.about.worktrees"), hint: t("web.setting.about.worktreesHint"), path: s().paths.worktrees },
                ]}
                key={(p) => p.label}
              >
                {(p, i) => <PathRow label={p().label} hint={p().hint} path={p().path} last={i() === 3} />}
              </Each>
            </SettingsGroup>
          </>
        )}
      </If>
    </SettingsPage>
  );
}

export function AboutPage() {
  const settings = useSettings();
  const updates = useUpdates();
  const cli = useCommandLine();
  return (
    <SettingsPage title={t("web.setting.nav.about")} description={t("web.setting.about.intro")}>
      <If
        when={ready(settings, undefined)}
        else={<Quiet>{settings.error() ? t("web.base.form.unreachable", { why: reasonOf(settings.error()) }) : t("web.base.form.asking")}</Quiet>}
      >
        {(s) => (
          <SettingsGroup>
            <SettingRow label={t("web.setting.about.version")} hint={t("web.setting.about.versionHint")} last={!updates() && !cli.state()}>
              <View class="rounded-md border border-line bg-side px-2 py-0.5">
                <Text testID="about-version" class="font-mono text-xs font-medium tabular-nums text-ink">
                  {s().version}
                </Text>
              </View>
            </SettingRow>
            <UpdateRow state={updates} last={!cli.state()} />
            <CommandLineRow state={cli.state} onInstall={cli.install} onRemove={cli.remove} last />
          </SettingsGroup>
        )}
      </If>
    </SettingsPage>
  );
}
