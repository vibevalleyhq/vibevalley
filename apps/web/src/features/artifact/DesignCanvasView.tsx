import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { z } from "zod";

import { type StorePropDef, storeMessageOf, storeViewUrl, writePropsIntoDcHtml } from "@vibevalley/artifact/viewers";
import { Slider } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";
import type { Artifact } from "@vibevalley/protocol";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { shownTheme } from "#/state/prefs.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { Select } from "#/ui/Field.tsx";
import { toast } from "#/ui/toasts.ts";

import { useReportViewContext, useStoreEntries } from "./store";

const ArtboardSchema = z.object({
  id: z.string(),
  title: z.exactOptional(z.string()),
  name: z.exactOptional(z.string()),
  file: z.string(),
  x: z.exactOptional(z.number()),
  y: z.exactOptional(z.number()),
  width: z.exactOptional(z.number()),
  height: z.exactOptional(z.number()),
  w: z.exactOptional(z.number()),
  h: z.exactOptional(z.number()),
});

const CanvasJsonSchema = z.object({
  title: z.exactOptional(z.string()),
  artboards: z.exactOptional(z.array(ArtboardSchema)),
});

function resolveArtboardPath(file: string): string {
  return file.startsWith("project/") ? file : `project/${file}`;
}

export function DesignCanvasView(props: { artifact: Artifact }) {
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const act = createAct();

  const [mode, setMode] = createSignal<"canvas" | "focus">("focus");
  const [selectedId, setSelectedId] = createSignal<string>();
  const [focusFrame, setFocusFrame] = createSignal<HTMLIFrameElement>();
  const [propDefs, setPropDefs] = createSignal<readonly StorePropDef[]>([]);
  const [propValues, setPropValues] = createSignal<Readonly<Record<string, string | number | boolean>>>({});

  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.artifact.seq);

  const artboards = createMemo(() => {
    const raw = snapshot().entries.get("project/canvas.json")?.value;
    if (raw) {
      try {
        const parsed = CanvasJsonSchema.safeParse(JSON.parse(raw));
        if (parsed.success && parsed.data.artboards && parsed.data.artboards.length > 0) {
          return parsed.data.artboards.map((a) => ({
            id: a.id,
            title: a.title ?? a.name ?? a.id,
            file: a.file,
            width: a.width ?? a.w ?? 1280,
            height: a.height ?? a.h ?? 800,
          }));
        }
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
    return [...snapshot().entries.keys()]
      .filter((p) => p.endsWith(".dc.html") || (p.startsWith("project/") && p.endsWith(".html")))
      .toSorted()
      .map((p, idx) => ({
        id: `ab-${idx + 1}`,
        title:
          p
            .split("/")
            .at(-1)
            ?.replace(/\.dc\.html$|\.html$/u, "") ?? p,
        file: p,
        width: 1280,
        height: 800,
      }));
  });

  const activeArtboard = () => {
    const id = selectedId();
    const all = artboards();
    return (id ? all.find((a) => a.id === id) : undefined) ?? all[0];
  };
  const activePath = () => {
    const ab = activeArtboard();
    return ab ? resolveArtboardPath(ab.file) : "project/main.dc.html";
  };

  useReportViewContext(
    () => props.artifact.id,
    () => {
      const ab = activeArtboard();
      return {
        artifactType: "design",
        title: props.artifact.title,
        seq: seq(),
        ...(ab ? { activeArtboard: ab.id } : {}),
      };
    },
  );

  onSettled(() => {
    const heard = (e: MessageEvent) => {
      if (e.source === null || e.source !== focusFrame()?.contentWindow) return;
      const msg = storeMessageOf(e.data);
      if (msg?.vibevalley !== "store-props") return;
      setPropDefs(msg.props);
      const vals: Record<string, string | number | boolean> = {};
      for (const p of msg.props) vals[p.name] = p.value;
      setPropValues(vals);
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  });

  const updateProp = (name: string, val: string | number | boolean) => {
    const next = { ...propValues(), [name]: val };
    setPropValues(next);
    focusFrame()?.contentWindow?.postMessage({ vibevalley: "set-props", values: next }, "*");
  };

  const savePropDefaults = () => {
    const path = activePath();
    const raw = snapshot().entries.get(path)?.value;
    if (!raw || propDefs().length === 0) return;
    const nextHtml = writePropsIntoDcHtml(raw, propValues());
    void act.run(async () => {
      await client.batch([{ op: "set", path, kind: "text", value: nextHtml }]);
      toast(t("web.artifact.design.savedProps"));
    });
  };

  const addArtboard = () => {
    const all = artboards();
    const idx = all.length + 1;
    const id = `screen-${idx}`;
    const file = `project/${id}.dc.html`;
    const deckTitle = props.artifact.title;
    const nextArtboards = [...all, { id, title: `Screen ${idx}`, file, width: 390, height: 844 }];
    void act.run(async () => {
      await client.batch([
        {
          op: "set",
          path: file,
          kind: "text",
          value: `<x-dc data-props='[{"name":"headline","label":"Headline","type":"text","value":"Screen ${idx}"}]'><main style="padding:32px"><h1 data-prop-text="headline">Screen ${idx}</h1></main></x-dc>`,
        },
        {
          op: "set",
          path: "project/canvas.json",
          kind: "json",
          value: JSON.stringify({ title: deckTitle, artboards: nextArtboards }),
        },
      ]);
      setSelectedId(id);
      setMode("focus");
    });
  };

  return (
    <div data-testid="design-canvas-view" class="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-line bg-side overflow-hidden">
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-page px-3 py-2">
        <div class="flex items-center gap-1">
          <button
            type="button"
            data-testid="design-mode-canvas"
            aria-pressed={mode() === "canvas" ? "true" : "false"}
            onClick={() => setMode("canvas")}
            class={[
              "cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium",
              mode() === "canvas" ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink",
            ]}
          >
            {t("web.artifact.design.canvas")}
          </button>
          <button
            type="button"
            data-testid="design-mode-focus"
            aria-pressed={mode() === "focus" ? "true" : "false"}
            onClick={() => setMode("focus")}
            class={[
              "cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium",
              mode() === "focus" ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink",
            ]}
          >
            {t("web.artifact.design.focus")}
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-1">
          <For each={artboards()}>
            {(ab) => (
              <button
                type="button"
                data-testid="design-artboard-pill"
                data-key={ab.id}
                onClick={() => {
                  setSelectedId(ab.id);
                  setMode("focus");
                }}
                class={[
                  "cursor-pointer rounded-full border px-2.5 py-0.5 text-xs",
                  ab.id === activeArtboard()?.id ? "border-accent bg-selected font-medium text-ink" : "border-line bg-page text-muted hover:text-ink",
                ]}
              >
                {ab.title}
              </button>
            )}
          </For>
        </div>

        <div class="ml-auto flex items-center gap-2">
          <span class="tabular-nums text-xs text-muted">{t("web.artifact.design.artboards", { n: artboards().length })}</span>
          <Button icon="add" data-testid="design-add-artboard" disabled={act.busy()} onClick={addArtboard}>
            {t("web.artifact.design.addArtboard")}
          </Button>
        </div>
      </div>

      <Show
        when={mode() === "focus"}
        fallback={
          <div data-testid="design-artboards-grid" class="grid min-h-[54vh] flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:grid-cols-2">
            <For each={artboards()}>
              {(ab) => {
                const path = resolveArtboardPath(ab.file);
                return (
                  <div data-testid="design-artboard-card" data-key={ab.id} class="flex flex-col gap-2 rounded-lg border border-line bg-page p-3 shadow-raise">
                    <div class="flex items-center justify-between gap-2">
                      <span class="truncate text-sm font-semibold">{ab.title}</span>
                      <span class="tabular-nums text-2xs text-muted">
                        {ab.width}×{ab.height}
                      </span>
                      <Button
                        onClick={() => {
                          setSelectedId(ab.id);
                          setMode("focus");
                        }}
                      >
                        {t("web.artifact.design.focus")}
                      </Button>
                    </div>
                    <iframe
                      title={ab.title ?? ab.id}
                      src={storeViewUrl(props.artifact.id, { theme: shownTheme(), seq: seq(), path })}
                      sandbox={htmlSandbox}
                      referrerpolicy="no-referrer"
                      loading="lazy"
                      class="h-72 w-full rounded-md border border-line bg-page"
                    />
                  </div>
                );
              }}
            </For>
          </div>
        }
      >
        <div class="flex min-h-[54vh] xl:min-h-0 flex-1 flex-col lg:flex-row">
          <iframe
            ref={setFocusFrame}
            data-testid="design-focus-frame"
            title={activeArtboard()?.title ?? props.artifact.title}
            src={storeViewUrl(props.artifact.id, { theme: shownTheme(), seq: seq(), path: activePath() })}
            sandbox={htmlSandbox}
            referrerpolicy="no-referrer"
            class="min-h-[48vh] xl:min-h-0 w-full flex-1 border-0 bg-page"
          />

          <aside
            data-testid="design-props-panel"
            class="flex w-full lg:w-72 shrink-0 flex-col gap-3 overflow-y-auto border-t lg:border-t-0 lg:border-l border-line bg-page p-3"
          >
            <h3 class="text-xs font-semibold text-muted">{t("web.artifact.design.props")}</h3>
            <Show when={propDefs().length > 0} fallback={<p class="text-xs text-faint">{t("web.artifact.design.noProps")}</p>}>
              <div class="flex flex-col gap-2.5">
                <For each={propDefs()}>
                  {(def) => {
                    const current = () => propValues()[def.name] ?? def.value;
                    return (
                      <div data-testid="design-prop-control" data-key={def.name} class="flex flex-col gap-1">
                        <label class="text-xs font-medium text-ink">{def.label ?? def.name}</label>
                        <Show when={def.type === "select"}>
                          <Select
                            label={def.label ?? def.name}
                            value={String(current())}
                            onChange={(val) => updateProp(def.name, val)}
                            options={(def.options ?? []).map((opt) => ({ value: opt, label: opt }))}
                            size="field"
                            text="xs"
                          />
                        </Show>
                        <Show when={def.type === "boolean"}>
                          <Checkbox checked={Boolean(current())} onChange={(checked) => updateProp(def.name, checked)} label={def.label ?? def.name} />
                        </Show>
                        <Show when={def.type === "number"}>
                          <div class="flex items-center gap-2">
                            <Slider.Root
                              min={def.min ?? 0}
                              max={def.max ?? 100}
                              step={def.step ?? 1}
                              value={Number(current())}
                              onValueChange={(val) => updateProp(def.name, val)}
                              class="flex-1"
                            >
                              <Slider.Control class="relative flex h-5 cursor-pointer items-center">
                                <Slider.Track class="relative h-1.5 w-full rounded-full bg-selected">
                                  <Slider.Indicator class="h-full rounded-full bg-accent" />
                                  <Slider.Thumb
                                    aria-label={def.label ?? def.name}
                                    class="absolute top-[calc(50%_-_0.375rem)] h-3 w-3 rounded-full border border-line bg-page shadow-raise"
                                  />
                                </Slider.Track>
                              </Slider.Control>
                            </Slider.Root>
                            <span class="min-w-8 text-right tabular-nums text-xs text-muted">{String(current())}</span>
                          </div>
                        </Show>
                        <Show when={def.type === "text" || def.type === "color"}>
                          <input
                            type="text"
                            value={String(current())}
                            onInput={(e) => updateProp(def.name, e.currentTarget.value)}
                            class="h-8 rounded-md border border-line bg-side px-2 text-xs text-ink outline-none focus:border-focus"
                          />
                        </Show>
                      </div>
                    );
                  }}
                </For>
                <Button tone="primary" data-testid="design-save-props" disabled={act.busy()} onClick={savePropDefaults}>
                  {t("web.artifact.design.saveProps")}
                </Button>
              </div>
            </Show>
          </aside>
        </div>
      </Show>
    </div>
  );
}
