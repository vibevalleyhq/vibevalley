import { computed, Image, PanResponder, signal, Text, untracked, View, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";

import type { CompareAnnotation } from "../compareModel";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";
import { Slider } from "../Slider";
import { mix, tone } from "../tone";
import { annotationToken, clamp, sideLabel, SPLIT_PRESETS, type OverlaySide } from "./shared";

function AnnotationOverlay(props: {
  readonly annotations: readonly CompareAnnotation[];
  readonly side: OverlaySide;
  readonly visible: boolean;
  readonly width: number;
  readonly height: number;
  readonly active: number | undefined;
}) {
  const matched = computed(() => {
    if (!props.visible) return [];
    return props.annotations.filter((item) => {
      if (props.side === "single") return true;
      const target = item.side ?? "both";
      return target === "both" || target === props.side;
    });
  });
  const boxWidth = () => (props.width > 0 ? props.width : 320);
  const boxHeight = () => (props.height > 0 ? props.height : 224);

  return (
    <If when={matched().length > 0}>
      <View testID={`compare-overlay-${props.side}`} class="pointer-events-none absolute inset-0">
        <Each of={matched()} key={(a) => `${props.side}:${a.n}:${a.rect.join(",")}`}>
          {(a) => {
            const color = () => annotationToken(a().tone);
            const isActive = () => props.active === a().n;
            const dimmed = () => props.active !== undefined && props.active !== a().n;
            const left = () => Math.round(a().rect[0] * boxWidth());
            const top = () => Math.round(a().rect[1] * boxHeight());
            const width = () => Math.max(18, Math.round(a().rect[2] * boxWidth()));
            const height = () => Math.max(18, Math.round(a().rect[3] * boxHeight()));
            return (
              <View
                testID={`compare-callout-${props.side}-${a().n}`}
                accessibilityState={{ selected: isActive() }}
                class="pointer-events-none absolute rounded-xs border-2"
                style={{
                  left: left(),
                  top: top(),
                  width: width(),
                  height: height(),
                  borderColor: tone(color()),
                  backgroundColor: mix(color(), isActive() ? 0.24 : 0.1),
                  opacity: dimmed() ? 0.4 : 1,
                }}
              >
                <View class="absolute -top-2.5 -left-1 rounded-full px-1.5 py-px shadow-raise" style={{ backgroundColor: tone(color()) }}>
                  <Text class="font-mono text-2xs font-semibold text-page tabular-nums">{String(a().n)}</Text>
                </View>
              </View>
            );
          }}
        </Each>
      </View>
    </If>
  );
}

export function ComparePanel(props: {
  readonly side: OverlaySide;
  readonly label: string;
  readonly src: string | undefined;
  readonly annotations: readonly CompareAnnotation[];
  readonly showAnnotations: boolean;
  readonly activeAnnotation: number | undefined;
  readonly onZoom: () => void;
}) {
  const bounds = signal({ width: 0, height: 0 });
  return (
    <View testID={`compare-panel-${props.side}`} class="min-w-0 flex-1 overflow-hidden rounded-md border border-line bg-side">
      <View class="flex-row items-center justify-between gap-2 border-b border-line bg-page px-2.5 py-1">
        <Text class="min-w-0 flex-1 truncate text-2xs font-medium text-muted">{props.label}</Text>
        <If when={props.src !== undefined}>
          <IconButton
            icon="enlarge"
            size={12}
            label={t("web.base.compare.zoom", { label: props.label })}
            onClick={() => props.onZoom()}
            testid={`compare-zoom-${props.side}`}
          />
        </If>
      </View>
      <View
        role="button"
        testID={`compare-stage-${props.side}`}
        accessibilityLabel={t("web.base.compare.zoom", { label: props.label })}
        disabled={props.src === undefined}
        onPress={() => props.src !== undefined && props.onZoom()}
        onLayout={(e) => bounds.set({ width: e.bounds.size.width, height: e.bounds.size.height })}
        class="relative h-56 w-full overflow-hidden bg-side"
      >
        <If
          when={props.src}
          else={
            <View class="h-full w-full items-center justify-center">
              <Icon name="image" size={20} tone="faint" />
            </View>
          }
        >
          {(url) => <Image testID={`compare-image-${props.side}`} src={url()} accessibilityLabel={props.label} class="h-full w-full object-contain" />}
        </If>
        <AnnotationOverlay
          annotations={props.annotations}
          side={props.side}
          visible={props.showAnnotations}
          width={bounds().width}
          height={bounds().height}
          active={props.activeAnnotation}
        />
      </View>
    </View>
  );
}

export function CompareSliderView(props: {
  readonly beforeSrc: string | undefined;
  readonly afterSrc: string | undefined;
  readonly beforeLabel: string;
  readonly afterLabel: string;
  readonly annotations: readonly CompareAnnotation[];
  readonly showAnnotations: boolean;
  readonly activeAnnotation: number | undefined;
  readonly split: number;
  readonly onSplit: (percent: number) => void;
  readonly onZoomBefore: () => void;
  readonly onZoomAfter: () => void;
}) {
  const stageWidth = signal(0);
  const stageHeight = signal(0);
  let stageRef: ViewRef | undefined;
  let stageLeft = 0;
  let stageSpan = 0;

  const emitAtX = (pageX: number) => {
    const w = stageSpan > 0 ? stageSpan : untracked(stageWidth);
    if (w <= 0) return;
    const next = Math.round(clamp((pageX - stageLeft) / w, 0, 1) * 100);
    if (next !== untracked(() => props.split)) props.onSplit(next);
  };

  const refreshBounds = (after?: () => void) => {
    void stageRef?.measure().then(
      (measured) => {
        if (measured) {
          stageLeft = measured.pagePosition.x;
          stageSpan = measured.bounds.size.width;
          after?.();
        }
      },
      () => {},
    );
  };

  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (_e, g) => {
      if (stageSpan > 0) emitAtX(g.x0);
      refreshBounds(() => emitAtX(g.x0));
    },
    onPanResponderMove: (_e, g) => {
      emitAtX(g.moveX);
    },
  });

  const effectiveWidth = () => (stageWidth() > 0 ? stageWidth() : 480);
  const clipWidth = () => Math.round((props.split / 100) * effectiveWidth());

  return (
    <View testID="compare-slider" class="gap-2 p-2.5">
      <View
        ref={(r) => {
          stageRef = r;
        }}
        {...pan.panHandlers}
        testID="compare-slider-stage"
        onLayout={(e) => {
          stageWidth.set(e.bounds.size.width);
          stageHeight.set(e.bounds.size.height);
          refreshBounds();
        }}
        class="relative h-64 w-full overflow-hidden rounded-md border border-line bg-side"
      >
        <If
          when={props.afterSrc}
          else={
            <View class="absolute inset-0 items-center justify-center">
              <Icon name="image" size={20} tone="faint" />
            </View>
          }
        >
          {(url) => (
            <Image testID="compare-slider-after" src={url()} accessibilityLabel={props.afterLabel} class="absolute inset-0 h-full w-full object-contain" />
          )}
        </If>
        <AnnotationOverlay
          annotations={props.annotations}
          side="after"
          visible={props.showAnnotations}
          width={stageWidth()}
          height={stageHeight()}
          active={props.activeAnnotation}
        />

        <View testID="compare-slider-clip" class="absolute top-0 bottom-0 left-0 overflow-hidden" style={{ width: clipWidth() }}>
          <View class="relative h-full" style={{ width: effectiveWidth() }}>
            <If when={props.beforeSrc}>
              {(url) => (
                <Image
                  testID="compare-slider-before"
                  src={url()}
                  accessibilityLabel={props.beforeLabel}
                  class="absolute inset-0 h-full w-full object-contain"
                />
              )}
            </If>
            <AnnotationOverlay
              annotations={props.annotations}
              side="before"
              visible={props.showAnnotations}
              width={stageWidth()}
              height={stageHeight()}
              active={props.activeAnnotation}
            />
          </View>
        </View>

        <View
          testID="compare-slider-divider"
          class="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-paper shadow-raise"
          style={{ left: Math.max(0, clipWidth() - 1) }}
        >
          <View class="absolute top-1/2 -left-3 -mt-3 size-6 items-center justify-center rounded-full border border-line bg-elevated shadow-float">
            <Icon name="diff" size={12} tone="ink" />
          </View>
        </View>

        <View
          testID="compare-slider-before-pill"
          class="pointer-events-none absolute top-2 left-2 rounded-sm border border-line px-2 py-0.5"
          style={{ backgroundColor: mix("elevated", 0.9) }}
        >
          <Text class="text-2xs font-medium text-ink">{props.beforeLabel}</Text>
        </View>
        <View
          testID="compare-slider-after-pill"
          class="pointer-events-none absolute top-2 right-2 rounded-sm border border-line px-2 py-0.5"
          style={{ backgroundColor: mix("elevated", 0.9) }}
        >
          <Text class="text-2xs font-medium text-ink">{props.afterLabel}</Text>
        </View>
      </View>

      <View class="flex-row items-center gap-2">
        <View class="flex-row items-center gap-1">
          <Each of={SPLIT_PRESETS} key={(p) => p}>
            {(preset) => (
              <View
                role="button"
                testID={`compare-split-${preset()}`}
                accessibilityState={{ selected: props.split === preset() }}
                onPress={() => props.onSplit(preset())}
                class={`h-6 items-center justify-center rounded-sm border px-2 ${
                  props.split === preset() ? "border-line bg-elevated shadow-raise" : "border-transparent hover:bg-hover"
                }`}
              >
                <Text class={`font-mono text-2xs tabular-nums ${props.split === preset() ? "font-medium text-ink" : "text-muted"}`}>{`${preset()}%`}</Text>
              </View>
            )}
          </Each>
        </View>
        <Slider
          testid="compare-split-slider"
          value={props.split}
          min={0}
          max={100}
          step={1}
          label={t("web.base.compare.sliderPosition")}
          onChange={props.onSplit}
          class="min-w-0 flex-1"
        />
        <Text testID="compare-split-value" class="w-9 shrink-0 text-right font-mono text-2xs text-muted tabular-nums">
          {`${props.split}%`}
        </Text>
        <If when={props.beforeSrc !== undefined}>
          <IconButton
            icon="enlarge"
            size={12}
            label={t("web.base.compare.zoom", { label: props.beforeLabel })}
            onClick={() => props.onZoomBefore()}
            testid="compare-slider-zoom-before"
          />
        </If>
        <If when={props.afterSrc !== undefined}>
          <IconButton
            icon="enlarge"
            size={12}
            label={t("web.base.compare.zoom", { label: props.afterLabel })}
            onClick={() => props.onZoomAfter()}
            testid="compare-slider-zoom-after"
          />
        </If>
      </View>
    </View>
  );
}

export function CompareLegend(props: {
  readonly annotations: readonly CompareAnnotation[];
  readonly dual: boolean;
  readonly activeAnnotation: number | undefined;
  readonly onHover: (n: number | undefined) => void;
  readonly onToggle: (n: number) => void;
}) {
  return (
    <If when={props.annotations.length > 0}>
      <View testID="compare-legend" class="gap-1 border-t border-line bg-side px-3 py-2">
        <Each of={props.annotations} key={(item) => `${item.n}:${item.side ?? "both"}:${item.note}`}>
          {(item) => {
            const color = () => annotationToken(item().tone);
            const isActive = () => props.activeAnnotation === item().n;
            return (
              <View
                role="button"
                testID={`compare-legend-${item().n}`}
                accessibilityState={{ selected: isActive() }}
                onMouseEnter={() => props.onHover(item().n)}
                onMouseLeave={() => props.onHover(undefined)}
                onPress={() => props.onToggle(item().n)}
                class={`flex-row items-start gap-2 rounded-md border px-2 py-1 ${
                  isActive() ? "border-line bg-elevated shadow-raise" : "border-transparent hover:bg-hover"
                }`}
              >
                <View class="mt-0.5 shrink-0 rounded-full px-1.5 py-px" style={{ backgroundColor: tone(color()) }}>
                  <Text class="font-mono text-2xs font-semibold text-page tabular-nums">{`#${item().n}`}</Text>
                </View>
                <If when={props.dual && item().side !== undefined && item().side !== "both"}>
                  <View class="mt-0.5 shrink-0 rounded-sm border border-line bg-page px-1.5 py-px">
                    <Text class="text-2xs font-medium text-muted">{sideLabel(item().side)}</Text>
                  </View>
                </If>
                <Text class="min-w-0 flex-1 text-xs text-ink">{item().note}</Text>
              </View>
            );
          }}
        </Each>
      </View>
    </If>
  );
}
