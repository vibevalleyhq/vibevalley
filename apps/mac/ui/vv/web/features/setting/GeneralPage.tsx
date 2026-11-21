import { t } from "@vibevalley/i18n";

import { setStart, StartValues, usePrefs } from "../../state/prefs";
import { SettingRow, SettingsGroup } from "../../ui/domain/settings";
import { Segmented } from "../../ui/Segmented";
import { LanguageChoice } from "./SettingsForm";

export function GeneralGroups() {
  const start = usePrefs((p) => p.start);
  return (
    <>
      <SettingsGroup note={t("web.setting.scope.farm")}>
        <SettingRow label={t("web.setting.language.label")} hint={t("web.setting.general.languageHint")} last>
          <LanguageChoice />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup note={t("web.setting.scope.device")}>
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
