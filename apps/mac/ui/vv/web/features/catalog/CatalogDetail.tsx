// Ported from VibeValley apps/web/src/features/catalog/CatalogDetail.tsx:
// the grounds, a picture at whole-step zoom, one picture's detail (anchor
// and head marks, frames played at a chosen rate, where it was cut from and
// the commands that make it again), a cursor's tile. Pictures are nsh
// Images of the app's art (ui/pixel/atlas.ts). The check ground is drawn
// on a Canvas (CSS's repeating conic gradient) behind the large picture and
// the frames; a grid tile is on the plain paper. The fps slider is nsh's.
import { Canvas, Clipboard, colorScheme, Image, signal, Text, View, type JSX, type ViewStyle } from "nsh";
import { Slider } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { createEffect, createMemo, untrack } from "../../../solid";
import { numberText } from "../../base/format";
import { useTimeout } from "../../base/timer";
import { useRouter } from "../../infra/router";
import { Button, Words } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { Card, Toggle } from "../../ui/layout";
import { useCursorUrl, useSpriteUrl } from "../../ui/pixel/atlas";
import { Segmented } from "../../ui/Segmented";
import { Bubble } from "../../ui/Tip";
import { tone } from "../../ui/tone";
import { framesOf, type Picture, remakeOf } from "./shelves";

export type Ground = "check" | "grass" | "night";
export const grounds: { value: Ground; label: string }[] = [
  { value: "check", label: t("web.catalog.ground.check") },
  { value: "grass", label: t("web.catalog.ground.grass") },
  { value: "night", label: t("web.catalog.ground.night") },
];

const groundClass: Record<Ground, string> = { grass: "bg-catalog-grass", night: "bg-catalog-night", check: "bg-catalog-paper" };

/** A box on a ground; `checked` draws the check's squares (12 px tiles of four 6 px squares). */
export function GroundBox(props: { ground: Ground; class?: string; style?: ViewStyle; checked?: boolean; children: JSX.Element }) {
  return (
    <View class={`overflow-hidden ${groundClass[props.ground]} ${props.class ?? ""}`} style={props.style}>
      <If when={props.ground === "check" && props.checked === true}>
        <Canvas
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
          draw={(ctx) => {
            colorScheme();
            ctx.fillStyle = tone("catalog-check");
            const { width, height } = ctx.canvas;
            for (let y = 0; y < height; y += 6) for (let x = (y / 6) % 2 === 0 ? 0 : 6; x < width; x += 12) ctx.fillRect(x, y, 6, 6);
          }}
        />
      </If>
      {props.children}
    </View>
  );
}

/** Whole steps, so its pixels stay square. */
export const fitScale = (p: Picture, box: number) => {
  const k = box / Math.max(p.w, p.h);
  return k >= 1 ? Math.floor(k) : k;
};

export function Img(props: { p: Picture; scale: number }) {
  const url = useSpriteUrl();
  const w = () => Math.round(props.p.w * props.scale);
  const h = () => Math.round(props.p.h * props.scale);
  return (
    <If when={url(props.p.name)} else={<View style={{ width: w(), height: h() }} />}>
      {(src) => <Image src={src()} style={{ width: w(), height: h() }} />}
    </If>
  );
}

const headOf = (p: { readonly hx?: number | undefined; readonly hy?: number | undefined }) =>
  p.hx !== undefined && p.hy !== undefined ? { x: p.hx, y: p.hy } : undefined;

function Copy(props: { text: string }) {
  const done = signal(false);
  const later = useTimeout();
  const copy = async () => {
    await Clipboard.writeText(props.text);
    done.set(true);
    later(() => done.set(false), 1200);
  };
  const label = () => (done() ? t("web.catalog.copied") : t("web.catalog.copy"));
  return (
    <View
      role="button"
      accessibilityLabel={label()}
      tooltip={<Bubble text={label()} />}
      onPress={() => void copy()}
      class={`h-6 shrink-0 flex-row items-center gap-1 rounded-md px-1.5 transition duration-120 ease-out active:translate-y-px ${
        done() ? "bg-ok-soft" : "hover:bg-hover"
      }`}
    >
      <Icon name={done() ? "check" : "copy"} size={12} tone="muted" />
      <Text class={`text-xs ${done() ? "font-medium text-ok-ink" : "text-muted"}`}>{label()}</Text>
    </View>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <View class="min-h-6 flex-row items-center gap-2.5">
      <Text class="w-16 shrink-0 text-xs font-medium text-muted">{props.label}</Text>
      <View class="min-w-0 flex-1 flex-row items-center gap-1.5">{props.children}</View>
    </View>
  );
}

function Code(props: { text: string }) {
  return (
    <>
      <View tooltip={<Bubble text={props.text} />} class="min-w-0 flex-1 rounded-sm border border-line bg-side px-2 py-0.5">
        <Text class="truncate font-mono text-2xs text-ink">{props.text}</Text>
      </View>
      <Copy text={props.text} />
    </>
  );
}

function Mark(props: { at: { x: number; y: number }; scale: number; head?: boolean }) {
  return (
    <If
      when={props.head === true}
      else={
        <View style={{ position: "absolute", left: props.at.x * props.scale - 6, top: props.at.y * props.scale - 6, width: 12, height: 12 }}>
          <View class="bg-berry-500" style={{ position: "absolute", left: 0, top: 5, width: 12, height: 2 }} />
          <View class="bg-berry-500" style={{ position: "absolute", left: 5, top: 0, width: 2, height: 12 }} />
        </View>
      }
    >
      <View
        class="border-2 border-water"
        style={{ position: "absolute", left: props.at.x * props.scale - 5, top: props.at.y * props.scale - 5, width: 10, height: 10 }}
      />
    </If>
  );
}

export function Detail(props: { picture: Picture; has: (n: string) => boolean; byName: Map<string, Picture>; ground: Ground }) {
  const router = useRouter();
  const scale = signal(untrack(() => Math.min(8, Math.max(1, Math.floor(260 / Math.max(props.picture.w, props.picture.h))))));
  const marks = signal(true);
  const playing = signal(true);
  const fps = signal(6);
  const frame = signal(0);
  const frames = createMemo(() => framesOf(props.picture.name, props.has));
  createEffect(
    () => [frames()?.join(), playing(), fps()] as const,
    ([names, on, perSecond]) => {
      if (!names || !on || perSecond <= 0) return;
      const timer = setInterval(() => frame.set(frame() + 1), 1000 / perSecond);
      return () => clearInterval(timer);
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
    <Card
      title={
        <View tooltip={<Bubble text={props.picture.name} />} class="min-w-0">
          <Text role="header" class="truncate font-mono text-sm font-semibold text-ink">
            {props.picture.name}
          </Text>
        </View>
      }
      action={
        <View class="shrink-0 flex-row items-center gap-1">
          <Copy text={props.picture.name} />
          <IconButton icon="close" size={14} label={t("web.base.lightbox.close")} onClick={() => router.navigate("/catalog")} />
        </View>
      }
      testid="picture-detail"
      item={props.picture.name}
    >
      <GroundBox ground={props.ground} checked class="max-h-88 min-h-44 items-center justify-center rounded-md border border-line p-4">
        <View style={{ width: shown().w * scale(), height: shown().h * scale() }}>
          <Img p={shown()} scale={scale()} />
          <If when={marks()}>
            <Mark at={{ x: shown().ax, y: shown().ay }} scale={scale()} />
            <If when={headOf(shown())}>{(head) => <Mark at={head()} scale={scale()} head />}</If>
          </If>
        </View>
      </GroundBox>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <Segmented
          label={t("web.catalog.zoom")}
          value={String(scale())}
          options={scales().map((s) => ({ value: String(s), label: `${s < 1 ? s.toFixed(2).replace(/0$/u, "") : numberText(s)}×` }))}
          onChange={(v) => scale.set(Number(v))}
        />
        <Toggle label={t("web.catalog.marks")} checked={marks()} onChange={(on) => marks.set(on)} />
      </View>
      <If when={frames()}>
        {(f) => (
          <View class="gap-2 rounded-lg border border-line bg-side p-2.5">
            <View class="flex-row items-center gap-2">
              <Button icon={playing() ? "stop" : "play"} testID="play" onPress={() => playing.set(!playing())}>
                <Words>{playing() ? t("web.catalog.stop") : t("web.catalog.play")}</Words>
              </Button>
              <Text class="text-xs text-muted tabular-nums">{t("web.catalog.frames", { n: f().length })}</Text>
              <View class="flex-1" />
              <Slider
                min={1}
                max={12}
                value={fps()}
                onChange={(e) => typeof e.value === "number" && fps.set(e.value)}
                accessibilityLabel={t("web.catalog.fps")}
                class="w-22"
                trackClass="h-6 justify-center"
                indicatorClass="h-1.5 rounded-full bg-selected"
                rangeClass="rounded-full bg-accent"
                thumbClass="size-3.5 rounded-full border border-accent bg-paper shadow-raise focus-visible:outline-2 focus-visible:outline-focus"
              />
              <Text class="w-14 shrink-0 text-right font-mono text-xs text-muted tabular-nums">{t("web.catalog.perSecond", { n: fps() })}</Text>
            </View>
            <View class="flex-row flex-wrap gap-1.5">
              <Each of={f()}>
                {(name, i) => (
                  <If when={props.byName.get(name())}>
                    {(p) => {
                      const active = () => playing() && i() === frame() % f().length;
                      return (
                        <View
                          role="button"
                          accessibilityLabel={name()}
                          tooltip={<Bubble text={name()} />}
                          onPress={() => router.navigate(`/catalog/${encodeURIComponent(name())}`)}
                          class={`rounded-md border-2 p-px transition duration-120 ease-out ${active() ? "border-accent" : "border-transparent hover:border-line"}`}
                        >
                          <GroundBox ground={props.ground} checked class="h-11 w-11 items-center justify-center rounded-sm">
                            <Img p={p()} scale={fitScale(p(), 38)} />
                          </GroundBox>
                        </View>
                      );
                    }}
                  </If>
                )}
              </Each>
            </View>
          </View>
        )}
      </If>
      <View class="gap-1.5">
        <Row label={t("web.catalog.size")}>
          <Text class="font-mono text-xs text-ink tabular-nums">
            {t("web.catalog.pixels", { w: numberText(props.picture.w), h: numberText(props.picture.h) })}
          </Text>
        </Row>
        <Row label={t("web.catalog.anchor")}>
          <Text class="font-mono text-xs text-ink tabular-nums">{`(${numberText(props.picture.ax)}, ${numberText(props.picture.ay)})`}</Text>
        </Row>
        <If when={headOf(props.picture)}>
          {(head) => (
            <Row label={t("web.catalog.head")}>
              <Text class="font-mono text-xs text-ink tabular-nums">{`(${numberText(head().x)}, ${numberText(head().y)})`}</Text>
            </Row>
          )}
        </If>
        <View class="my-1 border-t border-line" />
        <Row label={t("web.catalog.from")}>
          <If when={props.picture.sheet} else={<Text class="text-xs text-faint">{t("web.catalog.unrecorded")}</Text>}>
            {(sheet) => <Code text={sheet()} />}
          </If>
        </Row>
        <If when={remake()}>
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
        </If>
      </View>
    </Card>
  );
}

/** A cursor at 40 px high (its @2x drawing where there is one), its hot spot marked. */
export function CursorTile(props: { name: string; hx: number; hy: number; ground: Ground }) {
  const url = useCursorUrl();
  const natural = signal<{ w: number; h: number } | undefined>(undefined);
  const height = 40;
  const k = () => {
    const n = natural();
    return n ? height / n.h : undefined;
  };
  const widthPx = () => {
    const n = natural();
    const ratio = k();
    return n && ratio !== undefined && ratio !== 0 ? n.w * ratio : height;
  };
  return (
    <View
      testID="cursor"
      tooltip={<Bubble text={`${props.name} · (${numberText(props.hx)}, ${numberText(props.hy)})`} />}
      class="group w-26 items-center gap-1.5 rounded-lg p-1.5 transition duration-120 ease-out hover:bg-hover"
    >
      <GroundBox ground={props.ground} checked class="h-16 w-full items-center justify-center rounded-md border border-line">
        <View style={{ height, width: widthPx() }}>
          <If when={url(props.name)}>
            {(src) => <Image src={src()} style={{ height, width: widthPx() }} onLoad={(e) => natural.set({ w: e.size.width, h: e.size.height })} />}
          </If>
          <If when={k()}>
            {(ratio) => (
              <View
                class="h-2 w-2 rounded-full border border-bark-900 bg-berry"
                style={{ position: "absolute", left: props.hx * ratio() - 4, top: props.hy * ratio() - 4 }}
              />
            )}
          </If>
        </View>
      </GroundBox>
      <Text class="w-full truncate text-center font-mono text-2xs text-muted group-hover:text-ink">{props.name}</Text>
    </View>
  );
}
