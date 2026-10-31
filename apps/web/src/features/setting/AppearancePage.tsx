// 外观: how the workbench looks on this machine. The farm, the memory tree and the pixel skin are drawn and keep theirs.

import { t } from "@vibevalley/i18n";
import { ThemeChoiceValues } from "@vibevalley/protocol/host";

import { ScaleValues, setScale, setTheme, usePrefs } from "@/state/prefs";
import { Segmented } from "@/ui/Segmented";
import { SettingRow, SettingsGroup, SettingsPage } from "@/ui/settings";

export function AppearancePage() {
  const theme = usePrefs((p) => p.theme);
  const scale = usePrefs((p) => p.scale);
  return (
    <SettingsPage title={t("web.setting.nav.appearance")} hint={t("web.setting.appearance.intro")}>
      <SettingsGroup note={t("web.setting.scope.device")}>
        <SettingRow label={t("web.setting.appearance.theme")} hint={t("web.setting.appearance.themeHint")}>
          <Segmented
            label={t("web.setting.appearance.theme")}
            testid="theme"
            value={theme()}
            options={ThemeChoiceValues.map((v) => ({ value: v, label: t(`web.setting.appearance.themes.${v}`) }))}
            onChange={setTheme}
          />
        </SettingRow>
        <SettingRow label={t("web.setting.appearance.scale")} hint={t("web.setting.appearance.scaleHint")}>
          <Segmented
            label={t("web.setting.appearance.scale")}
            testid="scale"
            value={String(scale())}
            options={ScaleValues.map((v) => ({ value: String(v), label: `${v}%` }))}
            onChange={(v) => {
              const scale = ScaleValues.find((s) => String(s) === v);
              if (scale !== undefined) setScale(scale);
            }}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
