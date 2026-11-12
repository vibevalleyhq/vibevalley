import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";

import { Slider } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";

import { aria } from "#/base/dom.tsx";
import { numberText } from "#/base/format.ts";
import { useTimeout } from "#/base/timer.ts";
import { useRouter } from "#/infra/router.ts";
import { Button } from "#/ui/Button.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Card, Toggle } from "#/ui/layout.tsx";
import { Segmented } from "#/ui/Segmented.tsx";

import { framesOf, type Picture, remakeOf } from "./shelves";

const groundStyles = {
  grass: "bg-catalog-grass bg-none bg-auto",
  night: "bg-catalog-night bg-none bg-auto",
  check: "bg-catalog-paper bg-[image:repeating-conic-gradient(var(--color-catalog-check)_0%_25%,_transparent_0%_50%)] [background-size:12px_12px]",
};

export type Ground = "check" | "grass" | "night";
export const grounds: { value: Ground; label: string }[] = [
  { value: "check", label: t("web.catalog.ground.check") },
  { value: "grass", label: t("web.catalog.ground.grass") },
  { value: "night", label: t("web.catalog.ground.night") },
];

export const groundStyle = (g: Ground): JSX.ClassValue => groundStyles[g];

/** Whole steps, so its pixels stay square. */
export const fitScale = (p: Picture, box: number) => {
  const k = box / Math.max(p.w, p.h);
  return k >= 1 ? Math.floor(k) : k;
};

export function Img(props: { p: Picture; scale: number }) {
  return (
    <img
      src={`/pixel/${props.p.name}.png`}
      alt=""
      draggable="false"
      class="max-w-none [image-rendering:pixelated]"
      style={{ width: `${Math.round(props.p.w * props.scale)}px`, height: `${Math.round(props.p.h * props.scale)}px` }}
    />
  );
}

const headOf = (p: { readonly hx?: number | undefined; readonly hy?: number | undefined }) =>
  p.hx !== undefined && p.hy !== undefined ? { x: p.hx, y: p.hy } : undefined;

function Copy(props: { text: string }) {
  const [done, setDone] = createSignal(false);
  const later = useTimeout();
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      later(() => setDone(false), 1200);
    } catch (e) {
      // No clipboard here: the text is on show to copy by hand.
      if (!(e instanceof DOMException) && !(e instanceof TypeError)) throw e;
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy(props.text)}
      class="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted hover:bg-hover"
    >
      <Icon name={done() ? "check" : "copy"} size={12} />
      {done() ? t("web.catalog.copied") : t("web.catalog.copy")}
    </button>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex gap-2 text-sm">
      <span class="w-16 shrink-0 text-muted">{props.label}</span>
      <span class="flex min-w-0 flex-1 items-center gap-1">{props.children}</span>
    </div>
  );
}

function Code(props: { text: string }) {
  return (
    <>
      <code title={props.text} class="min-w-0 truncate rounded-sm bg-hover px-1.5 py-px font-mono text-2xs">
        {props.text}
      </code>
      <Copy text={props.text} />
    </>
  );
}

export function Detail(props: { picture: Picture; has: (n: string) => boolean; byName: Map<string, Picture>; ground: Ground }) {
  const router = useRouter();
  const [scale, setScale] = createSignal(untrack(() => Math.min(8, Math.max(1, Math.floor(260 / Math.max(props.picture.w, props.picture.h))))));
  const [marks, setMarks] = createSignal(true);
  const [playing, setPlaying] = createSignal(true);
  const [fps, setFps] = createSignal(6);
  const [frame, setFrame] = createSignal(0);
  const frames = createMemo(() => framesOf(props.picture.name, props.has));
  createEffect(
    () => [frames()?.join(), playing(), fps()] as const,
    ([names, on, perSecond]) => {
      if (!names || !on || perSecond <= 0) return;
      const t = setInterval(() => setFrame((f) => f + 1), 1000 / perSecond);
      return () => clearInterval(t);
    },
  );
  const shown = () => {
    const f = frames();
    const frameName = f && playing() ? f[frame() % f.length] : undefined;
    return (frameName ? props.byName.get(frameName) : undefined) ?? props.picture;
  };
  const remake = () => remakeOf(props.picture);
  const scales = () => [...new Set([1, 2, 4, 8, scale()])].toSorted((a, b) => a - b);
  return (
    <Card title={props.picture.name} action={<Copy text={props.picture.name} />} testid="picture-detail" item={props.picture.name}>
      <div class={["flex max-h-88 min-h-40 items-center justify-center overflow-auto rounded-md p-3", groundStyle(props.ground)]}>
        <span class="relative" style={{ width: `${shown().w * scale()}px`, height: `${shown().h * scale()}px` }}>
          <Img p={shown()} scale={scale()} />
          <Show when={marks()}>
            <span
              title={t("web.catalog.anchor")}
              class="w-3 h-3 bg-[image:linear-gradient(var(--color-berry-500),var(--color-berry-500)),_linear-gradient(var(--color-berry-500),var(--color-berry-500))] [background-position:center,_center] [background-size:100%_2px,_2px_100%] bg-no-repeat absolute"
              style={{
                left: `${shown().ax * scale() - 6}px`,
                top: `${shown().ay * scale() - 6}px`,
              }}
            />
            <Show when={headOf(shown())}>
              {(head) => (
                <span
                  title={t("web.catalog.head")}
                  class="w-2.5 h-2.5 absolute border-2 border-water"
                  style={{ left: `${head().x * scale() - 5}px`, top: `${head().y * scale() - 5}px` }}
                />
              )}
            </Show>
          </Show>
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Segmented
          label={t("web.catalog.zoom")}
          value={String(scale())}
          options={scales().map((s) => ({ value: String(s), label: `${s < 1 ? s.toFixed(2).replace(/0$/u, "") : numberText(s)}×` }))}
          onChange={(v) => setScale(Number(v))}
        />
        <Toggle label={t("web.catalog.marks")} checked={marks()} onChange={setMarks} />
      </div>
      <Show when={frames()}>
        {(f) => (
          <div class="flex flex-col gap-1.5 rounded-lg bg-hover p-2">
            <div class="flex items-center gap-2">
              <Button data-testid="play" aria-pressed={aria(playing())} onClick={() => setPlaying(!playing())}>
                {playing() ? t("web.catalog.stop") : t("web.catalog.play")}
              </Button>
              <span class="text-xs text-muted">{t("web.catalog.frames", { n: f().length })}</span>
              <span class="flex-1" />
              <Slider.Root min={1} max={12} value={fps()} onValueChange={setFps} class="w-24">
                <Slider.Control class="relative flex h-4 cursor-pointer items-center">
                  <Slider.Track class="relative h-1 w-full rounded-full bg-selected">
                    <Slider.Indicator class="h-full rounded-full bg-leaf" />
                    <Slider.Thumb
                      aria-label={t("web.catalog.fps")}
                      class="top-1/2 w-3 h-3 -translate-y-1/2 rounded-full border border-leaf bg-page shadow-raise outline-none focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-focus"
                    />
                  </Slider.Track>
                </Slider.Control>
              </Slider.Root>
              <span class="w-14 text-xs text-muted">{t("web.catalog.perSecond", { n: fps() })}</span>
            </div>
            <div class="flex flex-wrap gap-1">
              <For each={f()}>
                {(name, i) => (
                  <Show when={props.byName.get(name)}>
                    {(p) => (
                      <button
                        type="button"
                        title={name}
                        aria-label={name}
                        onClick={() => router.navigate(`/catalog/${encodeURIComponent(name)}`)}
                        class={[
                          "flex w-11 h-11 cursor-pointer items-center justify-center overflow-hidden rounded-sm",
                          playing() && i() === frame() % f().length ? "[box-shadow:0_0_0_2px_var(--color-focus)]" : "",
                          groundStyle(props.ground),
                        ]}
                      >
                        <Img p={p()} scale={fitScale(p(), 38)} />
                      </button>
                    )}
                  </Show>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
      <div class="flex flex-col gap-1.5">
        <Row label={t("web.catalog.size")}>{t("web.catalog.pixels", { w: numberText(props.picture.w), h: numberText(props.picture.h) })}</Row>
        <Row label={t("web.catalog.anchor")}>{`(${numberText(props.picture.ax)}, ${numberText(props.picture.ay)})`}</Row>
        <Show when={headOf(props.picture)}>{(head) => <Row label={t("web.catalog.head")}>{`(${numberText(head().x)}, ${numberText(head().y)})`}</Row>}</Show>
        <Row label={t("web.catalog.from")}>
          <Show when={props.picture.sheet} fallback={<span class="text-xs text-muted">{t("web.catalog.unrecorded")}</span>}>
            {(sheet) => <Code text={sheet()} />}
          </Show>
        </Row>
        <Show when={remake()}>
          {(r) => (
            <>
              <Row label={t("web.catalog.redraw")}>
                <Code text={r().draw} />
              </Row>
              <Row label={t("web.catalog.recut")}>
                <Code text={r().cut} />
              </Row>
            </>
          )}
        </Show>
      </div>
    </Card>
  );
}

export function CursorTile(props: { name: string; hx: number; hy: number; ground: Ground }) {
  const [natural, setNatural] = createSignal<{ w: number; h: number }>();
  const height = 40;
  const k = () => {
    const n = natural();
    return n ? height / n.h : undefined;
  };
  const widthPx = () => {
    const n = natural();
    const ratio = k();
    return n && ratio != null && ratio !== 0 ? n.w * ratio : height;
  };
  return (
    <div data-testid="cursor" data-key={props.name} class="flex flex-col items-center gap-1 p-1">
      <span class={["flex h-16 w-full items-center justify-center rounded-md", groundStyle(props.ground)]}>
        <span class="relative" style={{ height: `${height}px`, width: `${widthPx()}px` }}>
          <img
            src={`/cursors/${props.name}@2x.png`}
            alt=""
            class="h-10 [image-rendering:pixelated]"
            onError={(e) => (e.currentTarget.src = `/cursors/${props.name}.png`)}
          />
          <img
            src={`/cursors/${props.name}.png`}
            alt=""
            class="hidden"
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          <Show when={k()}>
            {(ratio) => (
              <span
                class="absolute w-2 h-2 rounded-full border border-bark-900 bg-berry"
                style={{ left: `${props.hx * ratio() - 4}px`, top: `${props.hy * ratio() - 4}px` }}
              />
            )}
          </Show>
        </span>
      </span>
      <span class="font-mono text-xs text-muted">{props.name}</span>
    </div>
  );
}
