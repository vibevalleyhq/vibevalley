import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";

import { CanvasFilterValues, CanvasPaletteValues } from "@vibevalley/artifact/shell";
import { t } from "@vibevalley/i18n";
import type { ArtifactHtmlEdit, HtmlShellCommand } from "@vibevalley/protocol";

import { Keyed, aria } from "#/base/dom.tsx";
import { api } from "#/infra/api.ts";
import { useQueryClient } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Field, Select, TextArea } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import type { IconName } from "#/ui/icons.ts";
import { toast } from "#/ui/toasts.ts";

import { artifactHref } from "./ArtifactCard";
import { type Controls, sendTo, type Shown } from "./frame";

type CanvasState = NonNullable<NonNullable<Shown["ready"]>["canvas"]>;
type CanvasLayer = CanvasState["layers"][number];
type CanvasPalette = CanvasState["palette"];
type CanvasFilter = CanvasLayer["filter"];
type CanvasPatch = NonNullable<ArtifactHtmlEdit["canvas"]>;
type CanvasLayerPatch = CanvasPatch["layers"][number];
type CanvasBoardPatch = NonNullable<CanvasPatch["board"]>;

const paletteLabels: Record<CanvasPalette, () => string> = {
  workbench: () => t("web.artifact.canvasEditor.paletteWorkbench"),
  "brutalist-red": () => t("web.artifact.canvasEditor.paletteBrutalistRed"),
  newsprint: () => t("web.artifact.canvasEditor.paletteNewsprint"),
  blueprint: () => t("web.artifact.canvasEditor.paletteBlueprint"),
};

const filterLabels: Record<CanvasFilter, () => string> = {
  none: () => t("web.artifact.canvasEditor.filterNone"),
  "sticker-cutout": () => t("web.artifact.canvasEditor.filterSticker"),
  "torn-paper": () => t("web.artifact.canvasEditor.filterTorn"),
  halftone: () => t("web.artifact.canvasEditor.filterHalftone"),
  shadow: () => t("web.artifact.canvasEditor.filterShadow"),
  grain: () => t("web.artifact.canvasEditor.filterGrain"),
};

const toggledFlipX = (flip: CanvasLayer["flip"]): CanvasLayer["flip"] => {
  switch (flip) {
    case "none":
      return "x";
    case "x":
      return "none";
    case "y":
      return "xy";
    case "xy":
      return "y";
  }
};

const diffLayer = (prev: CanvasLayer, cur: CanvasLayer): CanvasLayerPatch | undefined => {
  const patch: CanvasLayerPatch = {
    id: cur.id,
    ...(cur.x !== prev.x ? { x: cur.x } : {}),
    ...(cur.y !== prev.y ? { y: cur.y } : {}),
    // Positive w/h prevents sending 0 when a layer without explicit dimensions is hidden.
    ...(cur.w !== prev.w && cur.w > 0 ? { w: cur.w } : {}),
    ...(cur.h !== prev.h && cur.h > 0 ? { h: cur.h } : {}),
    ...(cur.rotate !== prev.rotate ? { rotate: cur.rotate } : {}),
    ...(cur.z !== prev.z ? { z: cur.z } : {}),
    ...(cur.opacity !== prev.opacity ? { opacity: cur.opacity } : {}),
    ...(cur.flip !== prev.flip ? { flip: cur.flip } : {}),
    ...(cur.filter !== prev.filter ? { filter: cur.filter } : {}),
    ...(cur.locked !== prev.locked ? { locked: cur.locked } : {}),
    ...(cur.hidden !== prev.hidden ? { hidden: cur.hidden } : {}),
    ...(cur.text !== prev.text ? { text: cur.text } : {}),
  };
  return Object.keys(patch).length > 1 ? patch : undefined;
};

const restoreLayer = (prev: CanvasLayer, lp: CanvasLayerPatch): CanvasLayerPatch => ({
  id: prev.id,
  ...(lp.x !== undefined ? { x: prev.x } : {}),
  ...(lp.y !== undefined ? { y: prev.y } : {}),
  ...(lp.w !== undefined && prev.w > 0 ? { w: prev.w } : {}),
  ...(lp.h !== undefined && prev.h > 0 ? { h: prev.h } : {}),
  ...(lp.rotate !== undefined ? { rotate: prev.rotate } : {}),
  ...(lp.z !== undefined ? { z: prev.z } : {}),
  ...(lp.opacity !== undefined ? { opacity: prev.opacity } : {}),
  ...(lp.flip !== undefined ? { flip: prev.flip } : {}),
  ...(lp.filter !== undefined ? { filter: prev.filter } : {}),
  ...(lp.locked !== undefined ? { locked: prev.locked } : {}),
  ...(lp.hidden !== undefined ? { hidden: prev.hidden } : {}),
  ...(lp.text !== undefined ? { text: prev.text } : {}),
});

const diffCanvas = (base: CanvasState | undefined, current: CanvasState | undefined): CanvasPatch | undefined => {
  if (!base || !current) return undefined;
  const board: CanvasBoardPatch = {};
  if (current.palette !== base.palette) board.palette = current.palette;
  if (current.grain !== base.grain) board.grain = current.grain;
  const baseById = new Map(base.layers.map((layer) => [layer.id, layer]));
  const layers: CanvasLayerPatch[] = [];
  for (const layer of current.layers) {
    if (!layer.id) continue;
    const prev = baseById.get(layer.id);
    if (!prev) continue;
    const diff = diffLayer(prev, layer);
    if (diff) layers.push(diff);
  }
  const hasBoard = Object.keys(board).length > 0;
  if (!hasBoard && layers.length === 0) return undefined;
  return hasBoard ? { board, layers } : { layers };
};

const roundDisplay = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return String(r === 0 ? 0 : r);
};

const layerIcon = (layer: CanvasLayer): IconName => {
  if (layer.kind === "group") return "catalog";
  if (layer.hasAsset) return "image";
  if (layer.text !== "") return "edit";
  return "appearance";
};

function createCanvasController(props: Controls) {
  const queries = useQueryClient();
  const router = useRouter();
  const act = createAct();

  const baseline = () => props.shown().ready?.canvas;
  const canvas = () => props.shown().at?.canvas ?? props.shown().ready?.canvas;
  const latest = () => props.version === props.artifact.version;
  const send = (cmd: HtmlShellCommand) => sendTo(props.frame())(cmd);

  const canvasPatch = createMemo(() => diffCanvas(baseline(), canvas()));
  const hasChanges = () => {
    const patch = canvasPatch();
    return patch !== undefined && (patch.board !== undefined || patch.layers.length > 0);
  };
  const selectedLayer = createMemo(() => {
    const c = canvas();
    return c && c.selectedId !== null ? c.layers.find((layer) => layer.id === c.selectedId) : undefined;
  });

  const save = async () => {
    const patch = canvasPatch();
    if (!patch || !latest() || act.busy()) return;
    const { id } = props.artifact;
    const version = props.version;
    const made = await act.run(() => api.artifact.html.edit({ id, version, canvas: patch }));
    if (!made) return;
    void queries.invalidate({ prefix: ["artifacts"] });
    router.navigate(artifactHref(id), { replace: true });
    toast(t("web.artifact.edit.saved", { version: made.version }));
  };

  const reset = () => {
    const base = baseline();
    const patch = canvasPatch();
    if (!base || !patch) return;
    if (patch.board !== undefined) {
      const board: CanvasBoardPatch = {};
      if (patch.board.palette !== undefined) board.palette = base.palette;
      if (patch.board.grain !== undefined) board.grain = base.grain;
      send({ vibevalley: "setBoard", board });
    }
    const baseById = new Map(base.layers.map((layer) => [layer.id, layer]));
    for (const lp of patch.layers) {
      const prev = baseById.get(lp.id);
      if (prev) send({ vibevalley: "patchLayer", patch: restoreLayer(prev, lp) });
    }
  };

  return { baseline, canvas, latest, send, hasChanges, selectedLayer, save, reset, busy: act.busy };
}

function LayerActionButtons(props: { layer: CanvasLayer; latest: boolean; send: (cmd: HtmlShellCommand) => void }) {
  const lockedOrOld = () => props.layer.locked || !props.latest;
  return (
    <div class="flex items-center gap-0.5">
      <IconButton
        icon="shuffle"
        label={t("web.artifact.canvasEditor.flipX")}
        testid="canvas-flip-x"
        disabled={lockedOrOld()}
        pressed={props.layer.flip === "x" || props.layer.flip === "xy"}
        onClick={() => props.send({ vibevalley: "patchLayer", patch: { id: props.layer.id, flip: toggledFlipX(props.layer.flip) } })}
      />
      <IconButton
        icon="moveUp"
        label={t("web.artifact.canvasEditor.bringForward")}
        testid="canvas-forward"
        disabled={lockedOrOld()}
        onClick={() => props.send({ vibevalley: "patchLayer", patch: { id: props.layer.id, z: props.layer.z + 1 } })}
      />
      <IconButton
        icon="moveDown"
        label={t("web.artifact.canvasEditor.sendBackward")}
        testid="canvas-backward"
        disabled={lockedOrOld()}
        onClick={() => props.send({ vibevalley: "patchLayer", patch: { id: props.layer.id, z: props.layer.z - 1 } })}
      />
      <IconButton
        icon="key"
        label={props.layer.locked ? t("web.artifact.canvasEditor.unlock") : t("web.artifact.canvasEditor.lock")}
        testid="canvas-lock"
        disabled={!props.latest}
        pressed={props.layer.locked}
        onClick={() => props.send({ vibevalley: "patchLayer", patch: { id: props.layer.id, locked: !props.layer.locked } })}
      />
      <IconButton
        icon={props.layer.hidden ? "show" : "hide"}
        label={props.layer.hidden ? t("web.artifact.canvasEditor.show") : t("web.artifact.canvasEditor.hide")}
        testid="canvas-visibility"
        disabled={lockedOrOld()}
        pressed={props.layer.hidden}
        onClick={() => props.send({ vibevalley: "patchLayer", patch: { id: props.layer.id, hidden: !props.layer.hidden } })}
      />
    </div>
  );
}

function NumericPropInput(props: {
  label: string;
  value: number;
  testid: string;
  min?: number | undefined;
  max?: number | undefined;
  disabled?: boolean | undefined;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = createSignal(roundDisplay(untrack(() => props.value)));
  const [focused, setFocused] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  createEffect(
    () => props.value,
    (next) => {
      if (!untrack(focused)) setDraft(roundDisplay(next));
    },
  );
  const commit = (raw: string) => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    if (props.min !== undefined && parsed < props.min) return;
    if (props.max !== undefined && parsed > props.max) return;
    if (Math.abs(parsed - props.value) > 0.001) props.onCommit(parsed);
  };
  return (
    <label class="flex min-w-0 flex-col gap-0.5">
      <span class="text-2xs font-medium text-muted">{props.label}</span>
      <input
        type="number"
        step="1"
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        data-testid={props.testid}
        value={draft()}
        onFocus={() => setFocused(true)}
        onInput={(e) => {
          const val = e.currentTarget.value;
          setDraft(val);
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(() => commit(val), 150);
        }}
        onBlur={(e) => {
          setFocused(false);
          const trimmed = e.currentTarget.value.trim();
          if (trimmed === "" || !Number.isFinite(Number(trimmed))) {
            setDraft(roundDisplay(props.value));
            return;
          }
          commit(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(e.currentTarget.value);
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            if (timer !== undefined) clearTimeout(timer);
            setDraft(roundDisplay(props.value));
            e.currentTarget.blur();
          }
        }}
        class="h-7 w-full rounded-md border border-line bg-page px-2 font-mono text-xs tabular-nums text-ink outline-none focus:border-focus disabled:cursor-default disabled:opacity-50"
      />
    </label>
  );
}

function LayerTextEditor(props: { value: string; disabled?: boolean | undefined; onInput: (next: string) => void }) {
  const [draft, setDraft] = createSignal(untrack(() => props.value));
  const [focused, setFocused] = createSignal(false);
  createEffect(
    () => props.value,
    (next) => {
      if (!untrack(focused)) setDraft(next);
    },
  );
  return (
    <Field label={t("web.artifact.canvasEditor.textContent")}>
      <TextArea
        data-testid="canvas-layer-text"
        rows={3}
        disabled={props.disabled}
        value={draft()}
        onFocus={() => setFocused(true)}
        onInput={(e) => {
          const next = e.currentTarget.value;
          setDraft(next);
          props.onInput(next);
        }}
        onBlur={() => setFocused(false)}
      />
      <span class="text-2xs text-muted">{t("web.artifact.canvasEditor.textHint")}</span>
    </Field>
  );
}

export function CanvasControls(props: Controls) {
  const ctrl = createCanvasController(props);
  const paletteOptions = () => CanvasPaletteValues.map((value) => ({ value, label: paletteLabels[value]() }));
  const inlineStrip = () => props.externalInspector !== true && props.onOpenInspector === undefined;

  return (
    <Show when={ctrl.canvas()}>
      {(c) => (
        <div
          data-testid="canvas-controls"
          data-palette={c().palette}
          data-issues={c().issues.length}
          data-selected={c().selectedId ?? ""}
          class="flex shrink-0 flex-col gap-2 border-t border-line bg-side px-3 py-2"
        >
          <div class="flex flex-wrap items-center gap-2">
            <Select
              testid="canvas-palette"
              size="control"
              text="xs"
              label={t("web.artifact.canvasEditor.palette")}
              value={c().palette}
              options={paletteOptions()}
              onChange={(palette) => ctrl.send({ vibevalley: "setBoard", board: { palette } })}
            />
            <span class="hidden h-7 items-center rounded-md border border-line bg-page px-2 font-mono text-xs tabular-nums text-muted sm:inline-flex">
              {c().width} × {c().height}
            </span>
            <span
              data-testid="canvas-lint"
              data-issues={c().issues.length}
              title={
                c().issues.length > 0
                  ? c()
                      .issues.map((issue) => issue.message)
                      .join("\n")
                  : undefined
              }
              class={[
                "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium",
                c().issues.length === 0 ? "bg-ok-soft text-ok-ink" : "bg-bad-soft text-berry",
              ]}
            >
              <Icon name={c().issues.length === 0 ? "check" : "warn"} size={14} />
              {c().issues.length === 0 ? t("web.artifact.canvasEditor.lintClean") : t("web.artifact.canvasEditor.lintIssues", { count: c().issues.length })}
            </span>
            <Show when={c().issues.length > 0 && ctrl.latest()}>
              <Button data-testid="canvas-autofix" icon="generate" onClick={() => ctrl.send({ vibevalley: "autoFix" })}>
                {t("web.artifact.canvasEditor.autoFix")}
              </Button>
            </Show>
            <Show when={props.externalInspector !== true && props.onOpenInspector !== undefined}>
              <Button data-testid="canvas-open-inspector" icon="catalog" onClick={() => props.onOpenInspector?.()}>
                {ctrl.selectedLayer()?.name ?? t("web.artifact.canvasEditor.inspectorOpen")}
              </Button>
            </Show>
            <Show when={inlineStrip() ? ctrl.selectedLayer() : undefined}>
              {(layer) => (
                <div class="flex items-center gap-1 border-l border-line pl-2">
                  <span class="max-w-36 truncate text-xs font-medium text-ink">{layer().name}</span>
                  <LayerActionButtons layer={layer()} latest={ctrl.latest()} send={ctrl.send} />
                </div>
              )}
            </Show>
            <div class="ml-auto flex items-center gap-1.5">
              <IconButton
                icon="download"
                label={t("web.artifact.canvasEditor.exportSvg")}
                testid="canvas-export"
                onClick={() => ctrl.send({ vibevalley: "exportSvg" })}
              />
              <Show when={ctrl.hasChanges() && ctrl.latest()}>
                <Button data-testid="canvas-reset" icon="undo" onClick={ctrl.reset}>
                  {t("web.artifact.canvasEditor.resetChanges")}
                </Button>
                <Button tone="primary" data-testid="canvas-save" disabled={ctrl.busy()} onClick={() => void ctrl.save()}>
                  {t("web.artifact.canvasEditor.saveChanges")}
                </Button>
              </Show>
            </div>
          </div>
          <Show when={inlineStrip() && c().layers.length > 0}>
            <div
              role="group"
              aria-label={t("web.artifact.canvasEditor.layers")}
              data-testid="canvas-layers"
              class="flex items-center gap-1.5 overflow-x-auto px-0.5 py-1"
            >
              <For each={c().layers} keyed={(layer) => layer.id}>
                {(layer) => {
                  const selected = () => c().selectedId === layer().id;
                  const hasIssue = () => c().issues.some((issue) => issue.layerId === layer().id);
                  return (
                    <button
                      type="button"
                      data-testid="canvas-layer"
                      data-layer-id={layer().id}
                      aria-pressed={aria(selected())}
                      onClick={() => ctrl.send({ vibevalley: "selectLayer", id: layer().id })}
                      class={[
                        "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium text-ink transition-[background-color,border-color] duration-120 ease-out",
                        selected() ? "bg-selected outline-solid outline-2 outline-accent outline-offset-1" : "bg-page hover:bg-hover",
                        hasIssue() ? "border-berry" : "border-line hover:border-faint",
                        layer().hidden && "opacity-65",
                      ]}
                    >
                      <Show when={hasIssue()}>
                        <span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-berry" />
                      </Show>
                      <span class="max-w-36 truncate">{layer().name || layer().id}</span>
                      <Show when={layer().locked}>
                        <Icon name="key" size={10} class="text-muted" />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

export function CanvasInspector(props: Controls) {
  const ctrl = createCanvasController(props);
  const filterOptions = () => CanvasFilterValues.map((value) => ({ value, label: filterLabels[value]() }));
  const baselineLayer = (id: string) => ctrl.baseline()?.layers.find((layer) => layer.id === id);

  return (
    <Show when={ctrl.canvas()}>
      {(c) => {
        const sortedLayers = () => [...c().layers].toSorted((a, b) => b.z - a.z);
        return (
          <div data-testid="canvas-inspector" class="flex flex-col gap-4">
            <Show
              when={ctrl.selectedLayer()}
              fallback={
                <p class="rounded-lg border border-dashed border-line bg-side px-3 py-3 text-xs leading-relaxed text-muted">
                  {t("web.artifact.canvasEditor.inspectorEmpty")}
                </p>
              }
            >
              {(layer) => (
                <Keyed key={layer().id}>
                  {() => {
                    const hasEditableText = () => layer().kind === "layer" && ((baselineLayer(layer().id)?.text ?? "") !== "" || layer().text !== "");
                    const readOnly = () => layer().locked || !ctrl.latest();
                    return (
                      <section
                        data-testid="canvas-inspector-selected"
                        data-layer-id={layer().id}
                        class="flex flex-col gap-3 rounded-lg border border-line bg-side p-3"
                      >
                        <div class="flex flex-col gap-1.5 border-b border-line pb-2.5">
                          <div class="flex items-center justify-between gap-2">
                            <span class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{layer().name || layer().id}</span>
                            <span class="shrink-0 rounded-sm bg-selected px-1.5 py-0.5 font-mono text-2xs tabular-nums text-muted">z:{layer().z}</span>
                          </div>
                          <div class="flex items-center justify-between gap-2">
                            <span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted">{layer().id}</span>
                            <LayerActionButtons layer={layer()} latest={ctrl.latest()} send={ctrl.send} />
                          </div>
                        </div>
                        <div class="flex flex-col gap-1.5">
                          <span class="text-xs font-medium text-muted">{t("web.artifact.canvasEditor.positionAndSize")}</span>
                          <div class="grid grid-cols-2 gap-1.5">
                            <NumericPropInput
                              label={t("web.artifact.canvasEditor.propX")}
                              testid="canvas-prop-x"
                              value={layer().x}
                              disabled={readOnly()}
                              onCommit={(x) => ctrl.send({ vibevalley: "patchLayer", patch: { id: layer().id, x } })}
                            />
                            <NumericPropInput
                              label={t("web.artifact.canvasEditor.propY")}
                              testid="canvas-prop-y"
                              value={layer().y}
                              disabled={readOnly()}
                              onCommit={(y) => ctrl.send({ vibevalley: "patchLayer", patch: { id: layer().id, y } })}
                            />
                          </div>
                          <div class="grid grid-cols-3 gap-1.5">
                            <NumericPropInput
                              label={t("web.artifact.canvasEditor.propW")}
                              testid="canvas-prop-w"
                              value={layer().w}
                              min={1}
                              disabled={readOnly()}
                              onCommit={(w) => ctrl.send({ vibevalley: "patchLayer", patch: { id: layer().id, w } })}
                            />
                            <NumericPropInput
                              label={t("web.artifact.canvasEditor.propH")}
                              testid="canvas-prop-h"
                              value={layer().h}
                              min={1}
                              disabled={readOnly()}
                              onCommit={(h) => ctrl.send({ vibevalley: "patchLayer", patch: { id: layer().id, h } })}
                            />
                            <NumericPropInput
                              label={t("web.artifact.canvasEditor.propRotate")}
                              testid="canvas-prop-rotate"
                              value={layer().rotate}
                              min={-3600}
                              max={3600}
                              disabled={readOnly()}
                              onCommit={(rotate) => ctrl.send({ vibevalley: "patchLayer", patch: { id: layer().id, rotate } })}
                            />
                          </div>
                        </div>
                        <Field label={t("web.artifact.canvasEditor.filter")}>
                          <Select
                            testid="canvas-filter"
                            size="control"
                            text="xs"
                            label={t("web.artifact.canvasEditor.filter")}
                            value={layer().filter}
                            disabled={readOnly()}
                            options={filterOptions()}
                            onChange={(filter) => ctrl.send({ vibevalley: "patchLayer", patch: { id: layer().id, filter } })}
                          />
                        </Field>
                        <Show when={hasEditableText()}>
                          <LayerTextEditor
                            value={layer().text}
                            disabled={readOnly()}
                            onInput={(text) => ctrl.send({ vibevalley: "patchLayer", patch: { id: layer().id, text } })}
                          />
                        </Show>
                      </section>
                    );
                  }}
                </Keyed>
              )}
            </Show>

            <Show when={c().issues.length > 0}>
              <section class="flex flex-col gap-1.5 rounded-lg border border-berry bg-bad-soft p-2.5">
                <div class="flex items-center justify-between gap-2">
                  <span class="flex items-center gap-1.5 text-xs font-semibold text-berry">
                    <Icon name="warn" size={14} />
                    {t("web.artifact.canvasEditor.lintDetails")}
                  </span>
                </div>
                <ul class="flex flex-col gap-1">
                  <For each={c().issues}>
                    {(issue) => (
                      <li>
                        <button
                          type="button"
                          onClick={() => ctrl.send({ vibevalley: "selectLayer", id: issue.layerId })}
                          class="w-full cursor-pointer rounded-sm px-1.5 py-1 text-left text-xs text-ink transition-[background-color] duration-120 ease-out hover:bg-page"
                        >
                          {issue.message}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            <Show when={c().layers.length > 0}>
              <section class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between px-0.5">
                  <h2 class="text-xs font-semibold text-muted">{t("web.artifact.canvasEditor.layers")}</h2>
                  <span class="font-mono text-2xs tabular-nums text-muted">{c().layers.length}</span>
                </div>
                <div role="group" aria-label={t("web.artifact.canvasEditor.layers")} data-testid="canvas-layers" class="flex flex-col gap-1">
                  <For each={sortedLayers()} keyed={(layer) => layer.id}>
                    {(layer) => {
                      const selected = () => c().selectedId === layer().id;
                      const hasIssue = () => c().issues.some((issue) => issue.layerId === layer().id);
                      return (
                        <button
                          type="button"
                          data-testid="canvas-layer"
                          data-layer-id={layer().id}
                          aria-pressed={aria(selected())}
                          onClick={() => ctrl.send({ vibevalley: "selectLayer", id: layer().id })}
                          class={[
                            "flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-[background-color,border-color] duration-120 ease-out",
                            selected() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover",
                            hasIssue() && !selected() && "border-berry",
                            layer().hidden && "opacity-65",
                          ]}
                        >
                          <Icon name={layerIcon(layer())} size={14} class="shrink-0 text-muted" />
                          <span class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{layer().name || layer().id}</span>
                          <Show when={hasIssue()}>
                            <span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-berry" />
                          </Show>
                          <Show when={layer().locked}>
                            <Icon name="key" size={10} class="shrink-0 text-muted" />
                          </Show>
                          <Show when={layer().hidden}>
                            <Icon name="hide" size={10} class="shrink-0 text-muted" />
                          </Show>
                          <span class="shrink-0 font-mono text-2xs tabular-nums text-muted">z{layer().z}</span>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </section>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
