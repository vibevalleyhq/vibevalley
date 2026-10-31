// 通用: the farm's language, and where this machine's page opens.

import { t } from "@vibevalley/i18n";

import { setStart, StartValues, usePrefs } from "@/state/prefs";
import { Segmented } from "@/ui/Segmented";
import { SettingRow, SettingsGroup, SettingsPage } from "@/ui/settings";

import { LanguageChoice } from "./SettingsForm";

export function GeneralPage() {
  const start = usePrefs((p) => p.start);
  return (
    <SettingsPage title={t("web.setting.nav.general")}>
      <SettingsGroup note={t("web.setting.scope.farm")}>
        <SettingRow label={t("web.setting.language.label")} hint={t("web.setting.general.languageHint")}>
          <LanguageChoice />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup note={t("web.setting.scope.device")}>
        <SettingRow label={t("web.setting.general.start")} hint={t("web.setting.general.startHint")}>
          <Segmented
            label={t("web.setting.general.start")}
            testid="start"
            value={start()}
            options={StartValues.map((s) => ({ value: s, label: t(`web.setting.general.starts.${s}`) }))}
            onChange={setStart}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
