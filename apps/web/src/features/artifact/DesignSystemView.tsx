import { createMemo, createSignal, For, Show } from "solid-js";
import { z } from "zod";

import { contrastRatio, parseTokensSpec } from "@vibevalley/artifact/tokens";
import { storeViewUrl } from "@vibevalley/artifact/viewers";
import { t } from "@vibevalley/i18n";
import type { Artifact } from "@vibevalley/protocol";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { api } from "#/infra/api.ts";
import { useQueryClient } from "#/infra/query.ts";
import { shownTheme } from "#/state/prefs.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { TextArea } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Markdown } from "#/ui/Markdown.tsx";
import { Tabs } from "#/ui/Tabs.tsx";
import { toast } from "#/ui/toasts.ts";

import { useReportViewContext, useStoreEntries } from "./store";

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

export function DesignSystemView(props: { artifact: Artifact }) {
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const queries = useQueryClient();
  const act = createAct();

  const [tab, setTab] = createSignal<DsTab>("overview");
  const [previewTheme, setPreviewTheme] = createSignal<"light" | "dark">(shownTheme());
  const [selectedComponent, setSelectedComponent] = createSignal<string>();
  const [tokensDraft, setTokensDraft] = createSignal<string>();

  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.artifact.seq);
  const tokensRaw = () => snapshot().entries.get("project/tokens.json")?.value ?? "{}";
  const parsedTokens = createMemo(() => parseTokensSpec(tokensRaw()));
  const readmeText = () => snapshot().entries.get("project/README.md")?.value ?? `# ${props.artifact.title}`;

  const components = createMemo(() => {
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
    return (id ? all.find((c) => c.id === id) : undefined) ?? all[0];
  };

  useReportViewContext(
    () => props.artifact.id,
    () => ({
      artifactType: "design-system",
      title: props.artifact.title,
      seq: seq(),
      activeTab: tab(),
    }),
  );

  const surfaceLight = () => parsedTokens().colors.find((c) => c.id === "surface" || c.id === "page")?.light;
  const surfaceDark = () => parsedTokens().colors.find((c) => c.id === "surface" || c.id === "page")?.dark;

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
      setTokensDraft(undefined);
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

  return (
    <div data-testid="design-system-view" class="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-line bg-page overflow-hidden">
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-side px-3 py-2">
        <Tabs label={props.artifact.title} value={tab()} onChange={setTab} items={tabItems} />
        <div class="ml-auto flex flex-wrap items-center gap-1.5">
          <Show when={props.artifact.isDefault}>
            <span data-testid="ds-default-badge" class="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-medium text-ok-ink">
              <Icon name="check" size={12} />
              {t("web.artifact.types.defaultBadge")}
            </span>
          </Show>
          <Button icon="appearance" data-testid="ds-toggle-default" disabled={act.busy()} onClick={toggleDefault}>
            {props.artifact.isDefault ? t("web.artifact.types.unsetDefault") : t("web.artifact.types.setDefault")}
          </Button>
          <Button
            icon={previewTheme() === "light" ? "themeLight" : "themeDark"}
            data-testid="ds-toggle-theme"
            onClick={() => setPreviewTheme((th) => (th === "light" ? "dark" : "light"))}
          >
            {previewTheme() === "light" ? t("web.artifact.designSystem.themeLight") : t("web.artifact.designSystem.themeDark")}
          </Button>
        </div>
      </div>

      <div class="flex min-h-[52vh] xl:min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <Show when={tab() === "overview"}>
          <div class="mx-auto w-full max-w-3xl">
            <Markdown text={readmeText()} />
          </div>
        </Show>

        <Show when={tab() === "colors"}>
          <div data-testid="ds-colors-grid" class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <For each={parsedTokens().colors}>
              {(c) => {
                const chosenBg = () => (previewTheme() === "dark" ? surfaceDark() : surfaceLight());
                const chosenHex = () => (previewTheme() === "dark" ? c.dark : c.light);
                const ratio = () => {
                  const bg = chosenBg();
                  if (!bg || c.id === "surface" || c.id === "page") return undefined;
                  return contrastRatio(chosenHex(), bg);
                };
                return (
                  <div data-testid="ds-color-swatch" data-key={c.id} class="flex flex-col gap-2 rounded-lg border border-line bg-side p-3">
                    <div class="grid grid-cols-2 gap-2">
                      <div style={{ "--swatch": c.light }} class="h-14 rounded-md border border-line bg-(--swatch)" title={`light: ${c.light}`} />
                      <div style={{ "--swatch": c.dark }} class="h-14 rounded-md border border-line bg-(--swatch)" title={`dark: ${c.dark}`} />
                    </div>
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-mono text-xs font-semibold text-ink">--color-{c.id}</span>
                      <span class="rounded-sm bg-hover px-1.5 py-0.5 text-2xs text-muted">{c.group}</span>
                    </div>
                    <div class="flex items-center justify-between font-mono text-2xs text-muted">
                      <span>L: {c.light}</span>
                      <span>D: {c.dark}</span>
                    </div>
                    <Show when={c.note}>
                      <span class="text-xs text-muted">{c.note}</span>
                    </Show>
                    <Show when={ratio()}>
                      {(r) => (
                        <span
                          data-testid="ds-contrast-badge"
                          class={["self-start rounded-full px-2 py-0.5 text-2xs font-medium", r() >= 4.5 ? "bg-ok-soft text-ok-ink" : "bg-bad-soft text-berry"]}
                        >
                          {r() >= 4.5
                            ? t("web.artifact.designSystem.contrastPass", { ratio: r() })
                            : t("web.artifact.designSystem.contrastLow", { ratio: r() })}
                        </span>
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={tab() === "typography"}>
          <div data-testid="ds-typography" class="flex flex-col gap-4">
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <For each={parsedTokens().families}>
                {(f) => (
                  <div class="flex flex-col gap-1 rounded-lg border border-line bg-side p-3">
                    <span class="font-mono text-xs font-semibold text-muted">--font-{f.id}</span>
                    <span class="text-sm text-ink">{f.value}</span>
                    <Show when={f.note}>
                      <span class="text-xs text-faint">{f.note}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <div class="flex flex-col gap-3">
              <For each={parsedTokens().styles}>
                {(st) => (
                  <div class="flex flex-col gap-1.5 rounded-lg border border-line bg-side p-3">
                    <div class="flex items-center justify-between font-mono text-xs text-muted">
                      <span>.type-{st.id}</span>
                      <span>
                        {st.size} · {st.weight} · lh {st.lineHeight}
                      </span>
                    </div>
                    <p
                      style={{
                        "--st-size": st.size,
                        "--st-weight": st.weight,
                        "--st-lh": st.lineHeight,
                      }}
                      class="truncate text-[length:var(--st-size)] font-[var(--st-weight)] leading-[var(--st-lh)] text-ink"
                    >
                      {st.sample}
                    </p>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={tab() === "components"}>
          <div data-testid="ds-components" class="flex min-h-[46vh] flex-1 flex-col gap-3 lg:flex-row">
            <div class="flex shrink-0 flex-row lg:w-48 lg:flex-col gap-1 overflow-x-auto">
              <For each={components()}>
                {(comp) => (
                  <button
                    type="button"
                    data-testid="ds-component-item"
                    data-key={comp.id}
                    onClick={() => setSelectedComponent(comp.id)}
                    class={[
                      "cursor-pointer rounded-md px-2.5 py-1.5 text-left text-xs font-medium",
                      comp.id === activeComponent()?.id ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink",
                    ]}
                  >
                    {comp.title ?? comp.id}
                  </button>
                )}
              </For>
            </div>
            <Show when={activeComponent()}>
              {(comp) => (
                <iframe
                  data-testid="ds-component-frame"
                  title={comp().title ?? comp().id}
                  src={storeViewUrl(props.artifact.id, {
                    theme: previewTheme(),
                    seq: seq(),
                    path: comp().preview,
                  })}
                  sandbox={htmlSandbox}
                  referrerpolicy="no-referrer"
                  class="min-h-[42vh] flex-1 rounded-lg border border-line bg-page"
                />
              )}
            </Show>
          </div>
        </Show>

        <Show when={tab() === "tokensJson"}>
          <div data-testid="ds-tokens-editor" class="flex flex-1 flex-col gap-2">
            <TextArea rows={16} value={tokensDraft() ?? tokensRaw()} onInput={(e) => setTokensDraft(e.currentTarget.value)} class="flex-1 font-mono text-xs" />
            <div class="flex justify-end">
              <Button tone="primary" data-testid="ds-save-tokens" disabled={act.busy()} onClick={saveTokens}>
                {t("web.artifact.designSystem.saveTokens")}
              </Button>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
