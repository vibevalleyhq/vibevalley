import { computed, effect, Scroll, signal, Text, View, WebView } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { TextArea } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { ActiveBar } from "../../design/layout";
import { Markdown } from "../../design/Markdown";
import { Tabs } from "../../design/Tabs";
import { toast } from "../../design/toasts";
import { api } from "../../infra/api";
import { useQueryClient } from "../../infra/query";
import { shownTheme } from "../../infra/state/prefs";
import { EMPTY_INSPECTED_TOKENS, inspectDesignTokens, type InspectedTokensSpec, useReportViewContext, useStoreEntries, useStoreViewHtml } from "./store";
import type { StoreViewerProps } from "./StoreArtifactView";

type DsTab = "overview" | "colors" | "typography" | "components" | "tokensJson";

const DsManifestSchema = z.object({
  name: z.exactOptional(z.string()),
  version: z.exactOptional(z.string()),
  components: z.exactOptional(
    z.array(
      z.object({
        id: z.string(),
        title: z.exactOptional(z.string()),
        preview: z.string(),
      }),
    ),
  ),
});

function parsePx(raw: string, fallback: number, min = 2, max = 96): number {
  const m = /^(\d+(?:\.\d+)?)\s*(px|rem)?$/iu.exec(raw.trim());
  if (!m) return fallback;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return fallback;
  const px = m[2]?.toLowerCase() === "rem" ? num * 16 : num;
  return Math.max(min, Math.min(max, Math.round(px)));
}

function isJsonValid(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

export function DesignSystemView(props: StoreViewerProps) {
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const queries = useQueryClient();
  const act = createAct();

  const tab = signal<DsTab>("overview");
  const previewTheme = signal<"light" | "dark">(shownTheme());
  const selectedComponent = signal<string | undefined>(undefined);
  const tokensDraft = signal<string | undefined>(undefined);

  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.artifact.seq);
  const tokensRaw = () => snapshot().entries.get("project/tokens.json")?.value ?? "{}";
  const parsedTokens = signal<InspectedTokensSpec>(EMPTY_INSPECTED_TOKENS);
  const draftCssLength = signal(0);
  const compiledCss = () => parsedTokens().css;
  const readmeText = () => snapshot().entries.get("project/README.md")?.value ?? `# ${props.artifact.title}`;

  let tokensRun = 0;
  effect(() => {
    const raw = tokensRaw();
    const myRun = ++tokensRun;
    void inspectDesignTokens(raw).then(
      (spec) => {
        if (myRun === tokensRun) parsedTokens.set(spec);
      },
      () => {
        if (myRun === tokensRun) parsedTokens.set(EMPTY_INSPECTED_TOKENS);
      },
    );
  });

  let draftRun = 0;
  effect(() => {
    if (tab() !== "tokensJson") return;
    const raw = tokensDraft() ?? tokensRaw();
    const myRun = ++draftRun;
    if (!isJsonValid(raw)) {
      draftCssLength.set(0);
      return;
    }
    void inspectDesignTokens(raw).then(
      (spec) => {
        if (myRun === draftRun) draftCssLength.set(spec.css.length);
      },
      () => {
        if (myRun === draftRun) draftCssLength.set(0);
      },
    );
  });

  const components = computed(() => {
    const raw = snapshot().entries.get("project/design-system.json")?.value;
    if (raw) {
      try {
        const parsed = DsManifestSchema.safeParse(JSON.parse(raw));
        if (parsed.success && parsed.data.components && parsed.data.components.length > 0) {
          return parsed.data.components;
        }
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
    return [...snapshot().entries.keys()]
      .filter((p) => p.startsWith("project/components/") && p.endsWith(".html"))
      .toSorted()
      .map((p) => {
        const seg = p.slice("project/components/".length).split("/")[0] ?? p;
        return { id: seg, title: seg, preview: p };
      });
  });

  const activeComponent = () => {
    const id = selectedComponent();
    const all = components();
    return (id ? all.find((c) => c.id === id) : undefined) ?? all.at(0);
  };

  const componentView = useStoreViewHtml(() => {
    if (tab() !== "components") return undefined;
    const comp = activeComponent();
    if (!comp) return undefined;
    return {
      id: props.artifact.id,
      theme: previewTheme(),
      seq: seq(),
      path: comp.preview,
    };
  });

  useReportViewContext(
    () => props.artifact.id,
    () => ({
      artifactType: "design-system",
      title: props.artifact.title,
      seq: seq(),
      activeTab: tab(),
    }),
  );

  const toggleDefault = () => {
    const next = !props.artifact.isDefault;
    const id = props.artifact.id;
    void act.run(async () => {
      await api.artifact.update({ id, isDefault: next });
      await queries.invalidate({ prefix: ["artifacts"] });
    });
  };

  const saveTokens = () => {
    const val = tokensDraft() ?? tokensRaw();
    void act.run(async () => {
      await client.batch([{ op: "set", path: "project/tokens.json", kind: "json", value: val }]);
      tokensDraft.set(undefined);
      toast(t("web.artifact.designSystem.savedTokens"));
    });
  };

  const tabItems = [
    { value: "overview" as const, label: t("web.artifact.designSystem.overview") },
    { value: "colors" as const, label: t("web.artifact.designSystem.colors") },
    { value: "typography" as const, label: t("web.artifact.designSystem.typography") },
    { value: "components" as const, label: t("web.artifact.designSystem.components") },
    { value: "tokensJson" as const, label: t("web.artifact.designSystem.tokensJson") },
  ];

  const draftValue = () => tokensDraft() ?? tokensRaw();
  const draftValid = () => isJsonValid(draftValue());

  return (
    <View testID="design-system-view" class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-page">
      <View class="min-h-11 shrink-0 flex-row flex-wrap items-center gap-2 border-b border-line bg-side px-3 py-2">
        <Tabs label={props.artifact.title} value={tab()} onChange={(v) => tab.set(v)} items={tabItems} />
        <View class="ml-auto flex-row flex-wrap items-center gap-1.5">
          <If when={props.artifact.isDefault === true}>
            <View testID="ds-default-badge" class="h-6 flex-row items-center gap-1 rounded-full bg-ok-soft px-2.5">
              <Icon name="check" size={12} tone="leaf" />
              <Text class="text-xs font-medium text-ok-ink">{t("web.artifact.types.defaultBadge")}</Text>
            </View>
          </If>
          <Button icon="appearance" testID="ds-toggle-default" disabled={act.busy()} onPress={toggleDefault}>
            {props.artifact.isDefault === true ? t("web.artifact.types.unsetDefault") : t("web.artifact.types.setDefault")}
          </Button>
          <Button
            icon={previewTheme() === "light" ? "themeLight" : "themeDark"}
            testID="ds-toggle-theme"
            onPress={() => previewTheme.set(previewTheme() === "light" ? "dark" : "light")}
          >
            {previewTheme() === "light" ? t("web.artifact.designSystem.themeLight") : t("web.artifact.designSystem.themeDark")}
          </Button>
        </View>
      </View>

      <If when={tab() === "overview"}>
        <Scroll class="min-h-0 flex-1" contentClass="p-4 gap-4">
          <View class="w-full max-w-3xl self-center gap-4">
            <View class="flex-row flex-wrap gap-2">
              <View class="rounded-md border border-line bg-side px-3 py-1.5">
                <Text class="font-mono text-xs text-muted tabular-nums">{`${parsedTokens().colors.length} colors`}</Text>
              </View>
              <View class="rounded-md border border-line bg-side px-3 py-1.5">
                <Text class="font-mono text-xs text-muted tabular-nums">{`${parsedTokens().styles.length} type styles`}</Text>
              </View>
              <View class="rounded-md border border-line bg-side px-3 py-1.5">
                <Text class="font-mono text-xs text-muted tabular-nums">{`${parsedTokens().space.length} spacing · ${parsedTokens().radius.length} radius`}</Text>
              </View>
              <View class="rounded-md border border-line bg-side px-3 py-1.5">
                <Text class="font-mono text-xs text-muted tabular-nums">{`${compiledCss().length} B CSS`}</Text>
              </View>
            </View>
            <Markdown text={readmeText()} />
          </View>
        </Scroll>
      </If>

      <If when={tab() === "colors"}>
        <Scroll class="min-h-0 flex-1" contentClass="p-4 gap-5">
          <View testID="ds-colors-grid" class="flex-row flex-wrap gap-3">
            <Each of={parsedTokens().colors}>
              {(item) => {
                const c = () => item();
                const ratio = () => (previewTheme() === "dark" ? c().contrastDark : c().contrastLight);
                return (
                  <View testID="ds-color-swatch" class="w-60 shrink-0 gap-2 rounded-lg border border-line bg-side p-3">
                    <View class="h-14 flex-row overflow-hidden rounded-md border border-line">
                      <View class="flex-1" style={{ backgroundColor: c().light }} />
                      <View class="w-px bg-line" />
                      <View class="flex-1" style={{ backgroundColor: c().dark }} />
                    </View>
                    <View class="flex-row items-center justify-between gap-2">
                      <Text class="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-ink">{`--color-${c().id}`}</Text>
                      <View class="shrink-0 rounded-sm bg-hover px-1.5 py-0.5">
                        <Text class="text-2xs text-muted">{c().group}</Text>
                      </View>
                    </View>
                    <View class="flex-row items-center justify-between gap-2">
                      <Text class="font-mono text-2xs text-muted tabular-nums">{`L: ${c().light}`}</Text>
                      <Text class="font-mono text-2xs text-muted tabular-nums">{`D: ${c().dark}`}</Text>
                    </View>
                    <If when={c().note !== ""}>
                      <Text class="text-xs leading-relaxed text-muted">{c().note}</Text>
                    </If>
                    <If when={ratio()}>
                      {(r) => (
                        <View
                          testID="ds-contrast-badge"
                          class={`h-5 flex-row items-center self-start rounded-full px-2 ${r() >= 4.5 ? "bg-ok-soft" : "bg-bad-soft"}`}
                        >
                          <Text class={`text-2xs font-medium tabular-nums ${r() >= 4.5 ? "text-ok-ink" : "text-berry"}`}>
                            {r() >= 4.5
                              ? t("web.artifact.designSystem.contrastPass", { ratio: r() })
                              : t("web.artifact.designSystem.contrastLow", { ratio: r() })}
                          </Text>
                        </View>
                      )}
                    </If>
                  </View>
                );
              }}
            </Each>
          </View>

          <If when={parsedTokens().space.length > 0 || parsedTokens().radius.length > 0}>
            <View testID="ds-spacing-radius" class="gap-4 border-t border-line pt-4">
              <If when={parsedTokens().space.length > 0}>
                <View class="gap-2">
                  <Text class="text-xs font-semibold text-muted">Spacing</Text>
                  <View class="flex-row flex-wrap gap-2">
                    <Each of={parsedTokens().space}>
                      {(sp) => (
                        <View class="flex-row items-center gap-2.5 rounded-md border border-line bg-side px-3 py-2">
                          <Text class="font-mono text-xs font-semibold text-ink">{`--space-${sp().id}`}</Text>
                          <View class="h-3 rounded-xs bg-accent" style={{ width: parsePx(sp().value, 16, 4, 120) }} />
                          <Text class="font-mono text-2xs text-muted tabular-nums">{sp().value}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </View>
              </If>
              <If when={parsedTokens().radius.length > 0}>
                <View class="gap-2">
                  <Text class="text-xs font-semibold text-muted">Radius</Text>
                  <View class="flex-row flex-wrap gap-2">
                    <Each of={parsedTokens().radius}>
                      {(rad) => (
                        <View class="flex-row items-center gap-2.5 rounded-md border border-line bg-side px-3 py-2">
                          <View class="size-7 border border-accent bg-page" style={{ borderRadius: parsePx(rad().value, 6, 0, 24) }} />
                          <View class="gap-0.5">
                            <Text class="font-mono text-xs font-semibold text-ink">{`--radius-${rad().id}`}</Text>
                            <Text class="font-mono text-2xs text-muted tabular-nums">{rad().value}</Text>
                          </View>
                        </View>
                      )}
                    </Each>
                  </View>
                </View>
              </If>
            </View>
          </If>
        </Scroll>
      </If>

      <If when={tab() === "typography"}>
        <Scroll class="min-h-0 flex-1" contentClass="p-4 gap-4">
          <View testID="ds-typography" class="gap-4">
            <View class="flex-row flex-wrap gap-3">
              <Each of={parsedTokens().families}>
                {(f) => (
                  <View class="min-w-64 flex-1 gap-1 rounded-lg border border-line bg-side p-3">
                    <Text class="font-mono text-xs font-semibold text-muted">{`--font-${f().id}`}</Text>
                    <Text class="text-sm text-ink">{f().value}</Text>
                    <If when={f().note !== ""}>
                      <Text class="text-xs text-faint">{f().note}</Text>
                    </If>
                  </View>
                )}
              </Each>
            </View>

            <If when={parsedTokens().scale.length > 0}>
              <View class="flex-row flex-wrap gap-2">
                <Each of={parsedTokens().scale}>
                  {(sc) => (
                    <View class="flex-row items-center gap-2 rounded-md border border-line bg-side px-2.5 py-1.5">
                      <Text class="font-mono text-xs font-semibold text-ink">{`--text-${sc().id}`}</Text>
                      <Text class="font-mono text-2xs text-muted tabular-nums">{sc().value}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>

            <View class="gap-3">
              <Each of={parsedTokens().styles}>
                {(st) => {
                  const pxSize = () => parsePx(st().size, 14, 11, 48);
                  return (
                    <View class="gap-1.5 rounded-lg border border-line bg-side p-3">
                      <View class="flex-row items-center justify-between gap-2">
                        <Text class="font-mono text-xs font-medium text-muted">{`.type-${st().id}`}</Text>
                        <Text class="font-mono text-xs text-muted tabular-nums">{`${st().size} · ${st().weight} · lh ${st().lineHeight}`}</Text>
                      </View>
                      <Text class="truncate text-ink" style={{ fontSize: pxSize() }}>
                        {st().sample}
                      </Text>
                    </View>
                  );
                }}
              </Each>
            </View>
          </View>
        </Scroll>
      </If>

      <If when={tab() === "components"}>
        <View testID="ds-components" class="min-h-0 flex-1 flex-row gap-3 p-4">
          <Scroll class="w-48 shrink-0" contentClass="gap-1">
            <Each of={components()}>
              {(comp) => {
                const selected = () => comp().id === activeComponent()?.id;
                return (
                  <View
                    role="button"
                    testID="ds-component-item"
                    accessibilityState={{ selected: selected() }}
                    onPress={() => selectedComponent.set(comp().id)}
                    class={`relative h-7 justify-center rounded-md px-2.5 focus-visible:outline-2 focus-visible:outline-focus ${
                      selected() ? "bg-selected" : "hover:bg-hover"
                    }`}
                  >
                    <If when={selected()}>
                      <ActiveBar />
                    </If>
                    <Text class={`truncate text-xs font-medium ${selected() ? "text-ink" : "text-muted"}`}>{comp().title ?? comp().id}</Text>
                  </View>
                );
              }}
            </Each>
          </Scroll>
          <View class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-page">
            <If when={componentView.html()}>
              {(html) => (
                <WebView
                  testID="ds-component-frame"
                  accessibilityLabel={activeComponent()?.title ?? activeComponent()?.id ?? props.artifact.title}
                  html={html()}
                  incognito
                  class="min-h-0 min-w-0 flex-1"
                  style={props.covered === true ? { opacity: 0 } : undefined}
                />
              )}
            </If>
          </View>
        </View>
      </If>

      <If when={tab() === "tokensJson"}>
        <View testID="ds-tokens-editor" class="min-h-0 flex-1 gap-2.5 p-4">
          <TextArea rows={16} value={draftValue()} onInput={(val) => tokensDraft.set(val)} class="min-h-0 flex-1 font-mono text-xs" />
          <View class="flex-row items-center justify-between gap-2">
            <View class={`h-6 flex-row items-center rounded-full px-2.5 ${draftValid() ? "bg-side" : "bg-bad-soft"}`}>
              <Text class={`font-mono text-xs tabular-nums ${draftValid() ? "text-muted" : "font-medium text-berry"}`}>
                {draftValid() ? `${draftCssLength()} B compiled CSS` : "Invalid JSON"}
              </Text>
            </View>
            <Button tone="primary" testID="ds-save-tokens" disabled={act.busy() || !draftValid()} onPress={saveTokens}>
              {t("web.artifact.designSystem.saveTokens")}
            </Button>
          </View>
        </View>
      </If>
    </View>
  );
}
