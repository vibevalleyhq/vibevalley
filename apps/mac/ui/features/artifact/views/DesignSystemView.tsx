import { Clipboard, Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../../design/Icon";
import { toast } from "../../../design/toasts";
import { type DesignSystemModel, resolveDesignColor } from "./previewModel";

function numericTokenPx(raw: string, fallback: number): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function DesignSystemView(props: { readonly model: DesignSystemModel; readonly theme: "light" | "dark" }) {
  const surfaceColor = () => resolveDesignColor("{color.surface}", props.theme);
  const panelColor = () => resolveDesignColor("{color.panel}", props.theme);
  const inkColor = () => resolveDesignColor("{color.ink}", props.theme);
  const accentColor = () => resolveDesignColor("{color.accent}", props.theme);
  const borderColor = () => resolveDesignColor("{color.border}", props.theme);

  return (
    <Scroll testID="artifact-design-system-view" class="min-h-0 flex-1" contentClass="gap-5 p-5">
      <If when={props.model.colors.length > 0}>
        <View class="gap-2">
          <Text class="text-xs font-semibold text-muted">{t("web.artifact.designSystem.colors")}</Text>
          <View class="flex-row flex-wrap gap-2.5">
            <Each of={props.model.colors} key={(c) => c.name}>
              {(c) => (
                <View
                  role="button"
                  testID={`ds-color-${c().name}`}
                  onPress={() => {
                    const chosen = props.theme === "dark" ? c().dark : c().light;
                    const value = chosen || c().light;
                    if (value) {
                      void Clipboard.writeText(value).then(() => toast(t("web.base.rich.copied")));
                    }
                  }}
                  class="w-44 gap-1.5 rounded-lg border border-line bg-side p-2.5 hover:border-faint hover:bg-hover"
                >
                  <View class="flex-row gap-1.5">
                    <View class="h-8 flex-1 rounded-sm border border-line bg-page" style={c().light ? { backgroundColor: c().light } : undefined} />
                    <View class="h-8 flex-1 rounded-sm border border-line bg-ink" style={c().dark ? { backgroundColor: c().dark } : undefined} />
                  </View>
                  <View class="flex-row items-center justify-between gap-1">
                    <Text class="truncate text-xs font-semibold text-ink">{c().name}</Text>
                    <Text class="font-mono text-2xs text-faint">{c().group}</Text>
                  </View>
                  <Text class="truncate font-mono text-2xs text-muted">{`${c().light} / ${c().dark}`}</Text>
                  <If when={c().note}>
                    <Text class="truncate text-2xs text-faint">{c().note}</Text>
                  </If>
                </View>
              )}
            </Each>
          </View>
        </View>
      </If>

      <If when={props.model.styles.length > 0 || props.model.scale.length > 0 || props.model.families.length > 0}>
        <View class="gap-2">
          <Text class="text-xs font-semibold text-muted">{t("web.artifact.designSystem.typography")}</Text>
          <View class="gap-2 rounded-xl border border-line bg-side p-4">
            <If when={props.model.families.length > 0}>
              <View class="flex-row flex-wrap gap-2">
                <Each of={props.model.families} key={(f) => f.id}>
                  {(f) => (
                    <View class="rounded-md border border-line bg-page px-2.5 py-1.5">
                      <Text class="font-mono text-2xs font-semibold text-ink">{f().id}</Text>
                      <Text class="font-mono text-2xs text-muted">{f().value}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
            <Each of={props.model.styles} key={(st) => st.id}>
              {(st) => (
                <View class="flex-row items-baseline justify-between gap-3 border-t border-line pt-2">
                  <Text class="min-w-0 flex-1 truncate text-ink" style={{ fontSize: numericTokenPx(st().size, 15) }}>
                    {`${st().id} · ${t("web.artifact.designSystem.specimen")}`}
                  </Text>
                  <Text class="shrink-0 font-mono text-2xs text-muted">{`${st().size} · w${st().weight} · lh ${st().lineHeight}`}</Text>
                </View>
              )}
            </Each>
            <If when={props.model.styles.length === 0 && props.model.scale.length > 0}>
              <View class="flex-row flex-wrap items-end gap-3">
                <Each of={props.model.scale} key={(sc) => sc.id}>
                  {(sc) => (
                    <View class="gap-0.5 rounded-md border border-line bg-page px-2.5 py-1.5">
                      <Text class="font-semibold text-ink" style={{ fontSize: Math.min(28, numericTokenPx(sc().value, 14)) }}>
                        Aa
                      </Text>
                      <Text class="font-mono text-2xs text-muted">{`${sc().id} · ${sc().value}`}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </View>
        </View>
      </If>

      <If when={props.model.space.length > 0 || props.model.radius.length > 0}>
        <View class="flex-row flex-wrap gap-4">
          <If when={props.model.space.length > 0}>
            <View class="min-w-60 flex-1 gap-2">
              <Text class="text-xs font-semibold text-muted">{t("web.artifact.designSystem.spacing")}</Text>
              <View class="gap-2 rounded-xl border border-line bg-side p-3.5">
                <Each of={props.model.space} key={(sp) => sp.id}>
                  {(sp) => (
                    <View class="flex-row items-center gap-2.5">
                      <Text class="w-12 font-mono text-2xs font-medium text-ink">{sp().id}</Text>
                      <View class="h-3 rounded-xs bg-accent" style={{ width: Math.min(180, Math.max(4, numericTokenPx(sp().value, 8) * 3)) }} />
                      <Text class="font-mono text-2xs text-muted">{sp().value}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>

          <If when={props.model.radius.length > 0}>
            <View class="min-w-60 flex-1 gap-2">
              <Text class="text-xs font-semibold text-muted">{t("web.artifact.designSystem.radius")}</Text>
              <View class="flex-row flex-wrap gap-2.5 rounded-xl border border-line bg-side p-3.5">
                <Each of={props.model.radius} key={(r) => r.id}>
                  {(r) => (
                    <View class="items-center gap-1 rounded-md border border-line bg-page px-3 py-2">
                      <View class="size-9 border-2 border-accent bg-ok-soft" style={{ borderRadius: Math.min(24, numericTokenPx(r().value, 6)) }} />
                      <Text class="font-mono text-2xs font-semibold text-ink">{r().id}</Text>
                      <Text class="font-mono text-2xs text-muted">{r().value}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>
        </View>
      </If>

      <If when={props.model.components.length > 0}>
        <View class="gap-2">
          <Text class="text-xs font-semibold text-muted">{t("web.artifact.designSystem.components")}</Text>
          <View class="flex-row flex-wrap gap-3">
            <Each of={props.model.components} key={(comp) => comp.path}>
              {(comp) => (
                <View class="min-w-72 flex-1 gap-2.5 rounded-xl border border-line bg-page p-3.5">
                  <View class="gap-0.5">
                    <Text class="text-sm font-semibold text-ink">{comp().name}</Text>
                    <If when={comp().summary}>
                      <Text class="text-xs text-muted">{comp().summary}</Text>
                    </If>
                  </View>

                  <If when={comp().variants.length > 0}>
                    <View
                      class="flex-row flex-wrap items-center gap-2 rounded-lg border p-3"
                      style={{ backgroundColor: surfaceColor(), borderColor: borderColor() }}
                    >
                      <Each of={comp().variants} key={(v) => v.id}>
                        {(v) => {
                          const bg = () => resolveDesignColor(v().bg, props.theme) ?? (v().id === "primary" ? accentColor() : panelColor());
                          const fg = () => resolveDesignColor(v().fg, props.theme) ?? (v().id === "primary" ? surfaceColor() : inkColor());
                          return (
                            <View
                              class="rounded-md border px-2.5 py-1"
                              style={{
                                backgroundColor: bg(),
                                borderColor: borderColor(),
                              }}
                            >
                              <Text class="text-xs font-medium" style={{ color: fg() }}>
                                {v().id}
                              </Text>
                            </View>
                          );
                        }}
                      </Each>
                    </View>
                  </If>

                  <If when={comp().states.length > 0}>
                    <View class="flex-row flex-wrap gap-1">
                      <Each of={comp().states} key={(st) => st}>
                        {(st) => (
                          <View class="rounded-xs border border-line bg-side px-1.5 py-0.5">
                            <Text class="font-mono text-2xs text-faint">{st()}</Text>
                          </View>
                        )}
                      </Each>
                    </View>
                  </If>

                  <If when={comp().guidelinesDo.length > 0 || comp().guidelinesDont.length > 0}>
                    <View class="gap-1 border-t border-line pt-2">
                      <Each of={comp().guidelinesDo} key={(item) => item}>
                        {(item) => (
                          <View class="flex-row items-center gap-1.5">
                            <Icon name="check" size={12} tone="ok-ink" />
                            <Text class="text-2xs text-muted">{`${t("web.artifact.designSystem.guidelinesDo")}: ${item()}`}</Text>
                          </View>
                        )}
                      </Each>
                      <Each of={comp().guidelinesDont} key={(item) => item}>
                        {(item) => (
                          <View class="flex-row items-center gap-1.5">
                            <Icon name="cross" size={12} tone="berry" />
                            <Text class="text-2xs text-muted">{`${t("web.artifact.designSystem.guidelinesDont")}: ${item()}`}</Text>
                          </View>
                        )}
                      </Each>
                    </View>
                  </If>
                </View>
              )}
            </Each>
          </View>
        </View>
      </If>
    </Scroll>
  );
}
