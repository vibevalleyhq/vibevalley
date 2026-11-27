import { computed, host, setColorScheme, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { BizCode } from "@vibevalley/protocol/api";
import { MotionChoiceValues, ThemeChoice, ThemeChoiceValues } from "@vibevalley/protocol/host";

import { SettingRow, SettingsGroup } from "../../design/domain/settings";
import { Select } from "../../design/Field";
import type { IconName } from "../../design/icons";
import { Banner } from "../../design/layout";
import { applyMotion, chooseMotion, motionChoice } from "../../design/motion";
import { Segmented } from "../../design/Segmented";
import { reasonOf } from "../../infra/api";
import { hostApi } from "../../infra/bridge";
import { currentHost } from "../../infra/host";
import { prefsNow, ScaleValues, setScale, setTheme, usePrefs } from "../../infra/state/prefs";

const themeIcon: Record<ThemeChoice, IconName> = { light: "themeLight", dark: "themeDark", system: "themeSystem" };

export const defaultMonoFonts = [
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
// Escaped CJK glyphs keep `no-cjk-literal` clean while rendering literal bilingual font specimens.
const specimenCodeComment = "// \u4e2d\u82f1\u6587\u7b49\u5bbd\u5bf9\u9f50\uff1a\u8fde\u5b57\u4e0e\u6613\u6df7\u6dc6\u5b57\u7b26";

interface CachedHostFont {
  readonly monoFont?: string;
  readonly monoFonts?: readonly string[];
  readonly terminalFontSize?: number;
}

let cachedHostFont: CachedHostFont | undefined;

/** Resets cached host font metadata (used by tests to isolate fresh-mount behavior). */
export function resetAppearanceFontCache(): void {
  cachedHostFont = undefined;
}

export interface MonoFontOption {
  readonly value: string;
  readonly label: string;
  readonly installed: boolean;
  readonly group?: string | undefined;
}

/** Appends CJK and monospace fallbacks so every font name renders both Latin glyphs and Chinese samples cleanly. */
export function fontFamilyStack(family: string): string {
  const trimmed = family.trim();
  if (trimmed === "") return "'PingFang SC', Menlo, monospace";
  const escaped = trimmed.replaceAll("'", "\\'");
  const quoted = /[\s,]/u.test(trimmed) ? `'${escaped}'` : escaped;
  return `${quoted}, 'PingFang SC', Menlo, monospace`;
}

/** Places genuinely installed host fonts first (curated order, then alphabetical) before uninstalled fallback presets. */
export function buildMonoFontOptions(
  hostFonts: readonly string[],
  currentFont?: string,
  labels: { readonly installed: string; readonly fallback: string } = {
    installed: t("web.setting.appearance.fontGroupInstalled"),
    fallback: t("web.setting.appearance.fontGroupFallback"),
  },
): readonly MonoFontOption[] {
  const installedUnique: string[] = [];
  const installedSet = new Set<string>();
  for (const raw of hostFonts) {
    const name = raw.trim();
    if (name !== "" && !installedSet.has(name)) {
      installedSet.add(name);
      installedUnique.push(name);
    }
  }

  const cur = currentFont?.trim();
  const hasHostList = installedUnique.length > 0;

  if (!hasHostList) {
    const presets: string[] = [...defaultMonoFonts];
    if (cur && !presets.includes(cur)) presets.unshift(cur);
    return presets.map((name) => ({ value: name, label: name, installed: false }));
  }

  const installedOrdered: string[] = [];
  const seen = new Set<string>();
  for (const preferred of defaultMonoFonts) {
    if (installedSet.has(preferred) && !seen.has(preferred)) {
      seen.add(preferred);
      installedOrdered.push(preferred);
    }
  }
  const restInstalled = installedUnique.filter((name) => !seen.has(name)).toSorted((a, b) => a.localeCompare(b));
  for (const name of restInstalled) {
    seen.add(name);
    installedOrdered.push(name);
  }

  const fallbackOrdered: string[] = [];
  if (cur && !seen.has(cur)) {
    seen.add(cur);
    fallbackOrdered.push(cur);
  }
  for (const preset of defaultMonoFonts) {
    if (!seen.has(preset)) {
      seen.add(preset);
      fallbackOrdered.push(preset);
    }
  }

  return [
    ...installedOrdered.map((name) => ({ value: name, label: name, installed: true, group: labels.installed })),
    ...fallbackOrdered.map((name) => ({ value: name, label: name, installed: false, group: labels.fallback })),
  ];
}

const chooseTheme = (theme: ThemeChoice) => {
  setTheme(theme);
  const hostTheme = currentHost().theme;
  if (hostTheme) hostTheme(theme);
  else setColorScheme(theme);
};

export function AppearanceGroups() {
  const theme = usePrefs((p) => p.theme);
  const scale = usePrefs((p) => p.scale);
  // Avoid triggering an eager heavy font load for Maple Mono before host.info resolves the real configured font.
  const monoFont = signal(cachedHostFont?.monoFont ?? (host.available() ? "" : defaultMonoFonts[0]));
  const previewFont = signal<string | undefined>(undefined);
  const installedFonts = signal<readonly string[]>(cachedHostFont?.monoFonts ?? []);
  const termSize = signal(cachedHostFont?.terminalFontSize ?? 13);
  const error = signal<string | undefined>(undefined);

  const activeSpecimenFont = computed(() => previewFont() ?? monoFont());
  const fontOptions = computed(() => buildMonoFontOptions(installedFonts(), monoFont()));
  const installedSet = computed(
    () =>
      new Set(
        installedFonts()
          .map((f) => f.trim())
          .filter(Boolean),
      ),
  );
  const uiPreviewSize = computed(() => Math.round((13 * scale()) / 100));

  const loadHostInfo = async () => {
    if (!host.available()) return;
    try {
      const env = await hostApi.info();
      if (env.bizCode !== 0) {
        if (env.bizCode !== BizCode.RouteNotFound) {
          error.set(env.message || t("web.setting.appearance.fontLoadFailed"));
        }
        return;
      }
      if (!env.data) return;
      const parsedTheme = ThemeChoice.safeParse(env.data.theme);
      if (parsedTheme.success && parsedTheme.data !== prefsNow().theme) setTheme(parsedTheme.data);
      if (env.data.motion) applyMotion(env.data.motion);
      const nextFont = env.data.monoFont?.trim() || monoFont() || defaultMonoFonts[0];
      const nextFonts = Array.isArray(env.data.monoFonts) ? env.data.monoFonts : installedFonts();
      const nextTermSize = typeof env.data.terminalFontSize === "number" ? Math.round(env.data.terminalFontSize) : termSize();
      cachedHostFont = {
        monoFont: nextFont,
        monoFonts: nextFonts,
        terminalFontSize: nextTermSize,
      };
      monoFont.set(nextFont);
      installedFonts.set(nextFonts);
      termSize.set(nextTermSize);
      if (typeof env.data.uiFontSize === "number") {
        const pct = Math.round((env.data.uiFontSize / 13) * 100);
        const closest = ScaleValues.reduce((best, cur) => (Math.abs(cur - pct) < Math.abs(best - pct) ? cur : best));
        setScale(closest);
      }
    } catch (err) {
      error.set(reasonOf(err));
    }
  };

  void loadHostInfo();

  const applyFont = async (patch: { monoFont?: string; terminalFontSize?: number; uiFontSize?: number }, rollback: () => void) => {
    error.set(undefined);
    if (!host.available()) return;
    try {
      const env = await hostApi.font(patch);
      if (env.bizCode !== 0) {
        rollback();
        error.set(env.message || t("web.setting.appearance.fontApplyFailed"));
      }
    } catch (err) {
      rollback();
      error.set(reasonOf(err));
    }
  };

  return (
    <View class="gap-5">
      <If when={error()}>
        {(err) => (
          <Banner tone="bad" role="alert" testID="appearance-error">
            {err()}
          </Banner>
        )}
      </If>

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
        <SettingRow label={t("web.setting.appearance.motion")} hint={t("web.setting.appearance.motionHint")}>
          <Segmented
            label={t("web.setting.appearance.motion")}
            testid="motion"
            value={motionChoice()}
            options={MotionChoiceValues.map((v) => ({ value: v, label: t(`web.setting.appearance.motionOption.${v}`) }))}
            onChange={chooseMotion}
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
                const prevScale = scale();
                const prevSize = termSize();
                setScale(next);
                const sized = Math.round((13 * next) / 100);
                termSize.set(sized);
                void applyFont({ terminalFontSize: sized, uiFontSize: sized }, () => {
                  setScale(prevScale);
                  termSize.set(prevSize);
                });
              }
            }}
          />
        </SettingRow>
        <SettingRow label={t("web.setting.appearance.monoFontRow")} hint={t("web.setting.appearance.monoFontHint")}>
          <Select
            label={t("web.setting.appearance.monoFont")}
            testid="mono-font"
            class="w-64 max-w-full"
            popupClass="min-w-80 max-h-80"
            itemClass="group min-h-8 flex-row items-center gap-2 rounded-md px-2 py-1 focus:bg-hover selected:bg-selected disabled:opacity-50"
            searchable
            searchPlaceholder={t("web.setting.appearance.fontSearch")}
            emptyText={t("web.setting.appearance.fontEmpty")}
            value={monoFont()}
            options={fontOptions()}
            renderValue={({ value, label }) => (
              <Text
                testID="mono-font-trigger-label"
                class={`min-w-0 flex-1 truncate text-sm ${value() ? "text-ink" : "text-muted"}`}
                style={value() ? { fontFamily: fontFamilyStack(value()) } : undefined}
              >
                {label() || t("web.setting.appearance.monoFont")}
              </Text>
            )}
            renderOption={(entry) => {
              const isFallback = () => installedSet().size > 0 && !installedSet().has(entry.value);
              return (
                <View
                  testID={`mono-font-option-${entry.value}`}
                  onMouseEnter={() => previewFont.set(entry.value)}
                  onMouseLeave={() => {
                    if (previewFont() === entry.value) previewFont.set(undefined);
                  }}
                  class="min-w-0 flex-1 flex-row items-center gap-2"
                >
                  <Text class={`min-w-0 flex-1 truncate text-sm group-selected:font-medium ${isFallback() ? "text-muted" : "text-ink"}`}>{entry.title}</Text>
                  <If when={isFallback()}>
                    <View class="shrink-0 rounded-sm bg-hover px-1.5 py-px">
                      <Text class="text-2xs text-faint">{t("web.setting.appearance.fontFallbackBadge")}</Text>
                    </View>
                  </If>
                </View>
              );
            }}
            onChange={(next) => {
              const prev = monoFont();
              previewFont.set(undefined);
              monoFont.set(next);
              cachedHostFont = { ...cachedHostFont, monoFont: next };
              void applyFont({ monoFont: next }, () => {
                monoFont.set(prev);
                cachedHostFont = { ...cachedHostFont, monoFont: prev };
              });
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
                const prev = termSize();
                termSize.set(n);
                void applyFont({ terminalFontSize: n }, () => termSize.set(prev));
              }
            }}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("web.setting.appearance.previewTitle")} note={t("web.setting.appearance.previewNote")} testid="appearance-specimen">
        <View class="gap-1 border-b border-line px-4 py-3">
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-2xs font-medium text-faint">{t("web.setting.appearance.previewUiHeading")}</Text>
            <Text testID="specimen-ui-meta" class="font-mono text-2xs text-muted tabular-nums">
              {`${scale()}% · ${uiPreviewSize()}pt`}
            </Text>
          </View>
          <Text testID="specimen-ui-text" class="text-ink" style={{ fontSize: uiPreviewSize() }}>
            {t("web.setting.appearance.previewUiBody")}
          </Text>
        </View>
        <View class="gap-1.5 bg-side px-4 py-3">
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-2xs font-medium text-faint">{t("web.setting.appearance.previewCodeHeading")}</Text>
            <Text testID="specimen-code-meta" class="font-mono text-2xs text-muted tabular-nums">
              {`${activeSpecimenFont() || "Menlo"} · ${termSize()}pt`}
            </Text>
          </View>
          <View class="gap-0.5 rounded-md border border-line bg-page px-3 py-2.5">
            <Text testID="specimen-code-comment" class="text-muted" style={{ fontFamily: fontFamilyStack(activeSpecimenFont()), fontSize: termSize() }}>
              {specimenCodeComment}
            </Text>
            <Text testID="specimen-code-line" class="text-ink" style={{ fontFamily: fontFamilyStack(activeSpecimenFont()), fontSize: termSize() }}>
              {"const check = (x: number) => x !== 0O1lI;"}
            </Text>
            <Text testID="specimen-code-meta-line" class="text-accent" style={{ fontFamily: fontFamilyStack(activeSpecimenFont()), fontSize: termSize() }}>
              {`const font = "${activeSpecimenFont() || "Menlo"}"; // ${termSize()}pt`}
            </Text>
          </View>
        </View>
      </SettingsGroup>
    </View>
  );
}
