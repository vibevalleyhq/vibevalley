import { host, setColorScheme, signal } from "nsh";

import { t } from "@vibevalley/i18n";
import { type ThemeChoice, ThemeChoiceValues } from "@vibevalley/protocol/host";

import { hostApi } from "../../../../bridge";
import { currentHost } from "../../infra/host";
import { ScaleValues, setScale, setTheme, usePrefs } from "../../state/prefs";
import { SettingRow, SettingsGroup } from "../../ui/domain/settings";
import { Select } from "../../ui/Field";
import type { IconName } from "../../ui/icons";
import { Segmented } from "../../ui/Segmented";

const themeIcon: Record<ThemeChoice, IconName> = { light: "themeLight", dark: "themeDark", system: "themeSystem" };

const defaultMonoFonts = [
  "Maple Mono NF CN",
  "JetBrainsMono Nerd Font",
  "JetBrains Maple Mono",
  "Sarasa Mono SC",
  "JetBrains Mono",
  "SF Mono",
  "Menlo",
  "IBM Plex Mono",
  "Fira Code",
  "Monaco",
] as const;
const fontSizes = [11, 12, 13, 14, 15, 16, 18, 20] as const;

const chooseTheme = (theme: ThemeChoice) => {
  setTheme(theme);
  setColorScheme(theme);
  currentHost().theme?.(theme);
};

export function AppearanceGroups() {
  const theme = usePrefs((p) => p.theme);
  const scale = usePrefs((p) => p.scale);
  const monoFont = signal("Maple Mono NF CN");
  const availableFonts = signal<readonly string[]>(defaultMonoFonts);
  const termSize = signal(13);

  if (host.available()) {
    void hostApi.info().then((env) => {
      if (env.bizCode === 0 && env.data) {
        if (env.data.monoFont) monoFont.set(env.data.monoFont);
        if (Array.isArray(env.data.monoFonts) && env.data.monoFonts.length > 0) {
          const merged: string[] = [...defaultMonoFonts];
          for (const f of env.data.monoFonts) {
            if (!merged.includes(f)) merged.push(f);
          }
          availableFonts.set(merged);
        }
        if (typeof env.data.terminalFontSize === "number") termSize.set(Math.round(env.data.terminalFontSize));
        if (typeof env.data.uiFontSize === "number") {
          const pct = Math.round((env.data.uiFontSize / 13) * 100);
          const closest = ScaleValues.reduce((best, cur) => (Math.abs(cur - pct) < Math.abs(best - pct) ? cur : best));
          setScale(closest);
        }
      }
    });
  }

  return (
    <SettingsGroup title={t("web.setting.nav.appearance")} note={t("web.setting.scope.device")}>
      <SettingRow label={t("web.setting.appearance.theme")} hint={t("web.setting.appearance.themeHint")}>
        <Segmented
          label={t("web.setting.appearance.theme")}
          testid="theme"
          value={theme()}
          options={ThemeChoiceValues.map((v) => ({ value: v, icon: themeIcon[v], label: t(`web.setting.appearance.themes.${v}`) }))}
          onChange={chooseTheme}
        />
      </SettingRow>
      <SettingRow label={t("web.setting.appearance.scale")} hint={t("web.setting.appearance.scaleHint")}>
        <Segmented
          label={t("web.setting.appearance.scale")}
          testid="scale"
          value={String(scale())}
          options={ScaleValues.map((v) => ({ value: String(v), label: `${v}%` }))}
          onChange={(v) => {
            const next = ScaleValues.find((s) => String(s) === v);
            if (next !== undefined) {
              setScale(next);
              const sized = Math.round((13 * next) / 100);
              termSize.set(sized);
              void hostApi.font({ terminalFontSize: sized, uiFontSize: sized });
            }
          }}
        />
      </SettingRow>
      <SettingRow label={t("web.setting.appearance.monoFontRow")} hint={t("web.setting.appearance.monoFontHint")}>
        <Select
          label={t("web.setting.appearance.monoFont")}
          testid="mono-font"
          value={monoFont()}
          options={availableFonts().map((f) => ({ value: f, label: f }))}
          onChange={(next) => {
            monoFont.set(next);
            void hostApi.font({ monoFont: next });
          }}
        />
      </SettingRow>
      <SettingRow label={t("web.setting.appearance.terminalFontSize")} hint={t("web.setting.appearance.terminalFontSizeHint")} last>
        <Segmented
          label={t("web.setting.appearance.terminalFontSize")}
          testid="terminal-font-size"
          value={String(termSize())}
          options={fontSizes.map((s) => ({ value: String(s), label: `${s}pt` }))}
          onChange={(v) => {
            const n = Number(v);
            if (Number.isFinite(n)) {
              termSize.set(n);
              void hostApi.font({ terminalFontSize: n });
            }
          }}
        />
      </SettingRow>
    </SettingsGroup>
  );
}
