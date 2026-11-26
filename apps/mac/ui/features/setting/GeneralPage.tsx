import { t } from "@vibevalley/i18n";

import { SettingRow, SettingsGroup } from "../../design/domain/settings";
import { Segmented } from "../../design/Segmented";
import { setStart, StartValues, usePrefs } from "../../infra/state/prefs";
import { LanguageChoice } from "./SettingsForm";

export function GeneralGroups() {
  const start = usePrefs((p) => p.start);
  return (
    <>
      <SettingsGroup title={t("web.setting.language.title")} note={t("web.setting.scope.farm")}>
        <SettingRow label={t("web.setting.language.label")} hint={t("web.setting.general.languageHint")} last>
          <LanguageChoice />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title={t("web.setting.general.startupTitle")} note={t("web.setting.scope.device")}>
        <SettingRow label={t("web.setting.general.start")} hint={t("web.setting.general.startHint")} last>
          <Segmented
            label={t("web.setting.general.start")}
            testid="start"
            value={start()}
            options={StartValues.map((s) => ({ value: s, label: t(`web.setting.general.starts.${s}`) }))}
            onChange={setStart}
          />
        </SettingRow>
      </SettingsGroup>
    </>
  );
}
