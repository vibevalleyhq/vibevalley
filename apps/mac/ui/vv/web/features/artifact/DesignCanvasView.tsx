import { Scroll, Text, View } from "nsh";
import { z } from "zod";

import { type StorePropDef, storeMessageOf, writePropsIntoDcHtml } from "@vibevalley/artifact/viewers";
import { t } from "@vibevalley/i18n";

import { createMemo, createSignal } from "../../../solid";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { Select, TextInput } from "../../ui/Field";
import { Segmented } from "../../ui/Segmented";
import { Slider } from "../../ui/Slider";
import { toast } from "../../ui/toasts";
import type { Frame } from "./frame";
import { HtmlFrame } from "./HtmlFrame";
import { useReportViewContext, useStoreEntries } from "./store";
import type { StoreViewerProps } from "./StoreArtifactView";

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

export function DesignCanvasView(props: StoreViewerProps) {
  const { client, snapshot } = useStoreEntries(() => props.artifact.id);
  const act = createAct();

  const [mode, setMode] = createSignal<"canvas" | "focus">("focus");
  const [selectedId, setSelectedId] = createSignal<string>();
  const [focusFrame, setFocusFrame] = createSignal<Frame>();
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

  const handleMessage = (raw: unknown) => {
    const msg = storeMessageOf(raw);
    if (msg?.vibevalley !== "store-props") return;
    setPropDefs(msg.props);
    const vals: Record<string, string | number | boolean> = {};
    for (const p of msg.props) vals[p.name] = p.value;
    setPropValues(vals);
  };

  const updateProp = (name: string, val: string | number | boolean) => {
    const next = { ...propValues(), [name]: val };
    setPropValues(next);
    focusFrame()?.send({ vibevalley: "set-props", values: next });
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
    <View testID="design-canvas-view" class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-side">
      <View class="min-h-11 shrink-0 flex-row flex-wrap items-center gap-2 border-b border-line bg-page px-3 py-2">
        <Segmented
          label={t("web.artifact.design.canvas")}
          testid="design-mode"
          value={mode()}
          onChange={setMode}
          options={[
            { value: "canvas", label: t("web.artifact.design.canvas") },
            { value: "focus", label: t("web.artifact.design.focus") },
          ]}
        />

        <View class="flex-row flex-wrap items-center gap-1">
          <Each of={artboards()}>
            {(ab) => {
              const active = () => ab().id === activeArtboard()?.id;
              return (
                <View
                  role="button"
                  testID="design-artboard-pill"
                  accessibilityState={{ selected: active() }}
                  onPress={() => {
                    setSelectedId(ab().id);
                    setMode("focus");
                  }}
                  class={`h-7 flex-row items-center rounded-md border px-2.5 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${
                    active() ? "border-accent bg-selected" : "border-line bg-page hover:border-faint hover:bg-hover"
                  }`}
                >
                  <Text class={`text-xs ${active() ? "font-semibold text-ink" : "text-muted"}`}>{ab().title}</Text>
                </View>
              );
            }}
          </Each>
        </View>

        <View class="ml-auto flex-row items-center gap-2">
          <Text class="font-mono text-xs text-muted tabular-nums">{t("web.artifact.design.artboards", { n: artboards().length })}</Text>
          <Button icon="add" testID="design-add-artboard" disabled={act.busy()} onPress={addArtboard}>
            {t("web.artifact.design.addArtboard")}
          </Button>
        </View>
      </View>

      <If when={snapshot().error}>
        {(err) => (
          <View class="border-b border-line bg-bad-soft px-3 py-2">
            <Text class="text-xs font-medium text-berry">{err()}</Text>
          </View>
        )}
      </If>

      <If
        when={mode() === "focus"}
        else={
          <Scroll testID="design-artboards-grid" class="min-h-0 flex-1" contentClass="gap-4 p-4">
            <Each of={artboards()}>
              {(ab) => (
                <View testID="design-artboard-card" class="overflow-hidden rounded-lg border border-line bg-page shadow-raise">
                  <View class="flex-row items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
                    <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{ab().title}</Text>
                    <View class="rounded-xs bg-side px-1.5 py-0.5">
                      <Text class="font-mono text-2xs text-muted tabular-nums">{`${ab().width}×${ab().height}`}</Text>
                    </View>
                    <Button
                      size="compact"
                      onPress={() => {
                        setSelectedId(ab().id);
                        setMode("focus");
                      }}
                    >
                      {t("web.artifact.design.focus")}
                    </Button>
                  </View>
                  <View class="h-72 overflow-hidden bg-page">
                    <HtmlFrame
                      artifact={props.artifact}
                      version={seq()}
                      viewSeq={seq()}
                      viewPath={resolveArtboardPath(ab().file)}
                      title={ab().title}
                      frameClass="h-72 w-full bg-page"
                      hideControls
                      covered={props.covered}
                    />
                  </View>
                </View>
              )}
            </Each>
          </Scroll>
        }
      >
        <View class="min-h-0 flex-1 lg:flex-row">
          <HtmlFrame
            artifact={props.artifact}
            version={seq()}
            viewSeq={seq()}
            viewPath={activePath()}
            title={activeArtboard()?.title ?? props.artifact.title}
            testId="design-focus-frame"
            frameClass={props.frameClass ?? "min-h-0 w-full flex-1 bg-page"}
            hideControls
            covered={props.covered}
            onFrame={(f) => setFocusFrame(f)}
            onMessage={handleMessage}
            onPresent={props.onPresent}
          />

          <View testID="design-props-panel" class="max-h-80 shrink-0 border-t border-line bg-page lg:max-h-none lg:w-72 lg:border-t-0 lg:border-l">
            <View class="shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-side px-3 py-2">
              <Text class="text-xs font-semibold text-muted">{t("web.artifact.design.props")}</Text>
              <If when={propDefs().length > 0}>
                <View class="rounded-full bg-hover px-1.5 py-px">
                  <Text class="font-mono text-2xs text-muted tabular-nums">{String(propDefs().length)}</Text>
                </View>
              </If>
            </View>
            <Scroll class="min-h-0 flex-1" contentClass="gap-3 p-3">
              <If
                when={propDefs().length > 0}
                else={
                  <View class="rounded-md bg-side px-3 py-2.5">
                    <Text class="text-xs leading-relaxed text-faint">{t("web.artifact.design.noProps")}</Text>
                  </View>
                }
              >
                <View class="gap-3">
                  <Each of={propDefs()}>
                    {(def) => {
                      const current = () => propValues()[def().name] ?? def().value;
                      const label = () => def().label ?? def().name;
                      return (
                        <View testID="design-prop-control" class="gap-1">
                          <Text class="text-xs font-medium text-muted">{label()}</Text>
                          <If when={def().type === "select"}>
                            <Select
                              label={label()}
                              value={String(current())}
                              onChange={(val) => updateProp(def().name, val)}
                              options={(def().options ?? []).map((opt) => ({ value: opt, label: opt }))}
                              size="field"
                              text="xs"
                            />
                          </If>
                          <If when={def().type === "boolean"}>
                            <Checkbox checked={Boolean(current())} onChange={(checked) => updateProp(def().name, checked)} label={label()} />
                          </If>
                          <If when={def().type === "number"}>
                            <View class="flex-row items-center gap-2">
                              <Slider
                                min={def().min ?? 0}
                                max={def().max ?? 100}
                                step={def().step ?? 1}
                                value={Number(current())}
                                onChange={(val) => updateProp(def().name, val)}
                                label={label()}
                                class="flex-1"
                              />
                              <View class="min-w-9 items-end">
                                <Text class="font-mono text-xs text-muted tabular-nums">{String(current())}</Text>
                              </View>
                            </View>
                          </If>
                          <If when={def().type === "text" || def().type === "color"}>
                            <View class="flex-row items-center gap-1.5">
                              <If when={def().type === "color"}>
                                <View class="size-6 shrink-0 rounded-sm border border-line" style={{ backgroundColor: String(current()) }} />
                              </If>
                              <TextInput
                                value={String(current())}
                                onInput={(val) => updateProp(def().name, val)}
                                accessibilityLabel={label()}
                                class={`min-w-0 flex-1 text-xs ${def().type === "color" ? "font-mono" : ""}`}
                              />
                            </View>
                          </If>
                        </View>
                      );
                    }}
                  </Each>
                  <Button tone="primary" testID="design-save-props" disabled={act.busy()} onPress={savePropDefaults}>
                    {t("web.artifact.design.saveProps")}
                  </Button>
                </View>
              </If>
            </Scroll>
          </View>
        </View>
      </If>
    </View>
  );
}
