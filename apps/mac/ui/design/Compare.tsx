import { computed, effect, Image, PanResponder, Picker, signal, Text, untracked, View, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Attachment } from "@vibevalley/protocol";

import { api, reasonOf } from "../infra/api";
import { attachmentData } from "../infra/attachment";
import { fileUrl, importLocalAttachment, useAttachmentFile, useAttachmentUrl } from "../infra/attachmentFile";
import { Button } from "./Button";
import {
  formatCompareBlock,
  isDualCompare,
  type CompareAnnotation,
  type CompareAnnotationSide,
  type CompareAnnotationTone,
  type CompareImage,
  type CompareSpec,
} from "./compareModel";
import { Dialog } from "./Dialog";
import { Field, Select, TextInput } from "./Field";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { Lightbox, type Picture } from "./Lightbox";
import { motionClass } from "./motion";
import { readFiles } from "./picked";
import { Segmented } from "./Segmented";
import { Slider } from "./Slider";
import { toast } from "./toasts";
import { mix, tone } from "./tone";

type CompareMode = "side" | "slider";
type OverlaySide = "before" | "after" | "single";
type SemanticToken = "berry" | "leaf" | "water";

export interface CompareProps {
  readonly spec: CompareSpec;
  readonly class?: string | undefined;
  readonly testid?: string | undefined;
}

export interface CompareUploadResult {
  readonly spec: CompareSpec;
  readonly block: string;
  readonly attachments: readonly Attachment[];
}

export interface CompareUploadDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (result: CompareUploadResult) => void | Promise<void>;
  readonly testid?: string | undefined;
}

const SPLIT_PRESETS = [25, 50, 75] as const;

function annotationToken(kind: CompareAnnotationTone | undefined): SemanticToken {
  switch (kind) {
    case "issue":
      return "berry";
    case "fixed":
      return "leaf";
    case "note":
    case undefined:
      return "water";
  }
}

function sideLabel(side: CompareAnnotationSide | undefined): string {
  switch (side) {
    case "before":
      return t("web.base.compare.before");
    case "after":
      return t("web.base.compare.after");
    case "both":
    case undefined:
      return t("web.base.compare.sideBoth");
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function useResolvedImage(image: () => CompareImage | undefined) {
  const file = useAttachmentFile(() => image()?.attachment ?? "");
  const src = computed(() => {
    const img = image();
    if (!img) return undefined;
    if (img.url !== undefined && img.url !== "") return img.url;
    const f = file();
    return f ? fileUrl(f.path) : undefined;
  });
  const path = computed(() => file()?.path);
  return { src, path };
}

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

function ComparePanel(props: {
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

function CompareSliderView(props: {
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

/** Standalone before/after visual comparison and annotation viewer. */
export function Compare(props: CompareProps) {
  const mode = signal<CompareMode>("side");
  const showAnnotations = signal(true);
  const activeAnnotation = signal<number | undefined>(undefined);
  const splitPercent = signal(50);
  const lightboxAt = signal<number | undefined>(undefined);

  const dual = computed(() => isDualCompare(props.spec));
  const annotations = computed(() => props.spec.annotations ?? []);
  const singleImage = computed(() => props.spec.image ?? props.spec.before ?? props.spec.after);

  const before = useResolvedImage(() => props.spec.before);
  const after = useResolvedImage(() => props.spec.after);
  const single = useResolvedImage(() => (dual() ? undefined : singleImage()));

  const beforeLabel = computed(() => props.spec.before?.label || t("web.base.compare.before"));
  const afterLabel = computed(() => props.spec.after?.label || t("web.base.compare.after"));
  const singleLabel = computed(() => singleImage()?.label || props.spec.title || t("web.base.compare.title"));

  const modeOptions = computed(() => [
    { value: "side" as const, label: t("web.base.compare.sideBySide") },
    { value: "slider" as const, label: t("web.base.compare.slider") },
  ]);

  const pictures = computed<readonly Picture[]>(() => {
    const out: Picture[] = [];
    if (dual()) {
      const bSrc = before.src();
      if (bSrc !== undefined) {
        const bPath = before.path();
        out.push({ src: bSrc, name: beforeLabel(), ...(bPath !== undefined ? { path: bPath } : {}) });
      }
      const aSrc = after.src();
      if (aSrc !== undefined) {
        const aPath = after.path();
        out.push({ src: aSrc, name: afterLabel(), ...(aPath !== undefined ? { path: aPath } : {}) });
      }
      return out;
    }
    const sSrc = single.src();
    if (sSrc !== undefined) {
      const sPath = single.path();
      out.push({ src: sSrc, name: singleLabel(), ...(sPath !== undefined ? { path: sPath } : {}) });
    }
    return out;
  });

  const openZoom = (src: string | undefined) => {
    if (src === undefined) return;
    const idx = pictures().findIndex((p) => p.src === src);
    if (idx >= 0) lightboxAt.set(idx);
  };

  return (
    <View testID={props.testid ?? "compare-card"} class={`min-w-0 overflow-hidden rounded-lg border border-line bg-page ${props.class ?? ""}`}>
      <Lightbox pictures={pictures()} at={lightboxAt()} onAt={(at) => lightboxAt.set(at)} />

      <View class="flex-row flex-wrap items-center justify-between gap-2 border-b border-line bg-side px-3 py-2">
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Icon name="diff" size={14} tone="muted" />
          <Text testID="compare-title" class="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
            {props.spec.title || t("web.base.compare.title")}
          </Text>
        </View>
        <View class="shrink-0 flex-row items-center gap-1.5">
          <If when={annotations().length > 0}>
            <View
              role="button"
              testID="compare-annotations-toggle"
              accessibilityLabel={t("web.base.compare.annotations")}
              accessibilityState={{ selected: showAnnotations() }}
              onPress={() => showAnnotations.set(!untracked(showAnnotations))}
              class={`h-6 flex-row items-center gap-1 rounded-md border px-2 ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px ${
                showAnnotations() ? "border-line bg-page shadow-raise" : "border-transparent hover:bg-hover"
              }`}
            >
              <Icon name={showAnnotations() ? "show" : "hide"} size={12} tone={showAnnotations() ? "ink" : "muted"} />
              <Text class={`text-xs font-medium ${showAnnotations() ? "text-ink" : "text-muted"}`}>{t("web.base.compare.annotations")}</Text>
              <Text class="font-mono text-2xs text-muted tabular-nums">{String(annotations().length)}</Text>
            </View>
          </If>
          <If when={dual()}>
            <Segmented
              testid="compare-mode"
              label={t("web.base.compare.modeLabel")}
              value={mode()}
              options={modeOptions()}
              onChange={(next) => mode.set(next)}
            />
          </If>
        </View>
      </View>

      <If
        when={dual()}
        else={
          <View testID="compare-single" class="p-2.5">
            <ComparePanel
              side="single"
              label={singleLabel()}
              src={single.src()}
              annotations={annotations()}
              showAnnotations={showAnnotations()}
              activeAnnotation={activeAnnotation()}
              onZoom={() => openZoom(single.src())}
            />
          </View>
        }
      >
        <If
          when={mode() === "side"}
          else={
            <CompareSliderView
              beforeSrc={before.src()}
              afterSrc={after.src()}
              beforeLabel={beforeLabel()}
              afterLabel={afterLabel()}
              annotations={annotations()}
              showAnnotations={showAnnotations()}
              activeAnnotation={activeAnnotation()}
              split={splitPercent()}
              onSplit={(v) => splitPercent.set(v)}
              onZoomBefore={() => openZoom(before.src())}
              onZoomAfter={() => openZoom(after.src())}
            />
          }
        >
          <View testID="compare-side-by-side" class="flex-row gap-2 p-2.5">
            <ComparePanel
              side="before"
              label={beforeLabel()}
              src={before.src()}
              annotations={annotations()}
              showAnnotations={showAnnotations()}
              activeAnnotation={activeAnnotation()}
              onZoom={() => openZoom(before.src())}
            />
            <ComparePanel
              side="after"
              label={afterLabel()}
              src={after.src()}
              annotations={annotations()}
              showAnnotations={showAnnotations()}
              activeAnnotation={activeAnnotation()}
              onZoom={() => openZoom(after.src())}
            />
          </View>
        </If>
      </If>

      <If when={annotations().length > 0}>
        <View testID="compare-legend" class="gap-1 border-t border-line bg-side px-3 py-2">
          <Each of={annotations()} key={(item) => `${item.n}:${item.side ?? "both"}:${item.note}`}>
            {(item) => {
              const color = () => annotationToken(item().tone);
              const isActive = () => activeAnnotation() === item().n;
              return (
                <View
                  role="button"
                  testID={`compare-legend-${item().n}`}
                  accessibilityState={{ selected: isActive() }}
                  onMouseEnter={() => activeAnnotation.set(item().n)}
                  onMouseLeave={() => activeAnnotation.set(undefined)}
                  onPress={() => activeAnnotation.set(untracked(activeAnnotation) === item().n ? undefined : item().n)}
                  class={`flex-row items-start gap-2 rounded-md border px-2 py-1 ${
                    isActive() ? "border-line bg-elevated shadow-raise" : "border-transparent hover:bg-hover"
                  }`}
                >
                  <View class="mt-0.5 shrink-0 rounded-full px-1.5 py-px" style={{ backgroundColor: tone(color()) }}>
                    <Text class="font-mono text-2xs font-semibold text-page tabular-nums">{`#${item().n}`}</Text>
                  </View>
                  <If when={dual() && item().side !== undefined && item().side !== "both"}>
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
    </View>
  );
}

interface DraftAnnotationRow {
  readonly id: number;
  readonly side: CompareAnnotationSide;
  readonly tone: CompareAnnotationTone;
  readonly note: string;
}

function defaultAnnotationRect(index: number): [number, number, number, number] {
  const row = index % 4;
  const col = Math.floor(index / 4) % 2;
  const x = Number((0.08 + col * 0.44).toFixed(2));
  const y = Number((0.1 + row * 0.2).toFixed(2));
  return [x, y, 0.36, 0.16];
}

function UploadSlot(props: {
  readonly side: "before" | "after";
  readonly title: string;
  readonly attachment: Attachment | undefined;
  readonly uploading: boolean;
  readonly onPick: () => void;
  readonly onDropUri: (uri: string) => void;
  readonly onClear: () => void;
}) {
  const dragOver = signal(false);
  const thumbUrl = useAttachmentUrl(() => props.attachment?.id ?? "");

  return (
    <View
      testID={`compare-slot-${props.side}`}
      onFileDragEnter={() => dragOver.set(true)}
      onFileDragLeave={() => dragOver.set(false)}
      onFileDrop={(e) => {
        dragOver.set(false);
        const uri = e.uris[0];
        if (uri !== undefined) props.onDropUri(uri);
      }}
      class="min-w-0 flex-1 gap-1.5"
    >
      <View class="flex-row items-center justify-between gap-2">
        <Text class="text-xs font-medium text-muted">{props.title}</Text>
        <If when={props.attachment !== undefined}>
          <View class="flex-row items-center gap-0.5">
            <IconButton
              icon="upload"
              size={12}
              label={t("web.base.compare.replace")}
              disabled={props.uploading}
              onClick={() => props.onPick()}
              testid={`compare-replace-${props.side}`}
            />
            <IconButton
              icon="close"
              size={12}
              label={t("web.base.compare.clear")}
              disabled={props.uploading}
              onClick={() => props.onClear()}
              testid={`compare-clear-${props.side}`}
            />
          </View>
        </If>
      </View>

      <If
        when={props.attachment}
        else={
          <View
            role="button"
            testID={`compare-pick-${props.side}`}
            accessibilityLabel={props.title}
            disabled={props.uploading}
            onPress={() => props.onPick()}
            class={`h-36 items-center justify-center gap-1.5 rounded-md border border-dashed px-3 ${
              dragOver() ? "border-accent bg-selected" : "border-line bg-side hover:border-faint hover:bg-hover"
            } ${props.uploading ? "opacity-50" : ""}`}
          >
            <Icon name="image" size={20} tone={dragOver() ? "accent" : "muted"} />
            <Text class="text-xs font-medium text-ink">{props.uploading ? t("web.base.compare.uploading") : t("web.base.compare.pickHint")}</Text>
          </View>
        }
      >
        {(att) => (
          <View class="overflow-hidden rounded-md border border-line bg-page">
            <View class="h-28 w-full items-center justify-center bg-side">
              <If when={thumbUrl()} else={<Icon name="image" size={20} tone="muted" />}>
                {(src) => (
                  <Image testID={`compare-slot-thumb-${props.side}`} src={src()} accessibilityLabel={att().name} class="h-full w-full object-contain" />
                )}
              </If>
            </View>
            <View class="border-t border-line px-2 py-1">
              <Text testID={`compare-slot-name-${props.side}`} class="truncate text-2xs font-medium text-ink">
                {att().name}
              </Text>
            </View>
          </View>
        )}
      </If>
    </View>
  );
}

/** Modal dialog for uploading Before/After images and optional annotations into a ` ```compare ` block. */
export function CompareUploadDialog(props: CompareUploadDialogProps) {
  const title = signal("");
  const before = signal<Attachment | undefined>(undefined);
  const after = signal<Attachment | undefined>(undefined);
  const uploadingBefore = signal(false);
  const uploadingAfter = signal(false);
  const submitting = signal(false);
  const error = signal<string | undefined>(undefined);
  const rows = signal<readonly DraftAnnotationRow[]>([]);
  let nextRowId = 1;

  effect(() => {
    if (!props.open) return;
    title.set("");
    before.set(undefined);
    after.set(undefined);
    uploadingBefore.set(false);
    uploadingAfter.set(false);
    submitting.set(false);
    error.set(undefined);
    rows.set([]);
  });

  const setSlot = (side: "before" | "after", att: Attachment | undefined) => {
    if (side === "before") before.set(att);
    else after.set(att);
  };
  const setUploading = (side: "before" | "after", busy: boolean) => {
    if (side === "before") uploadingBefore.set(busy);
    else uploadingAfter.set(busy);
  };

  const uploadPickedFile = async (side: "before" | "after") => {
    const picked = await Picker.pickFiles({ multiple: false });
    const files = readFiles(picked);
    const file = files.at(0);
    if (file === undefined) return;
    setUploading(side, true);
    error.set(undefined);
    try {
      const data = await attachmentData(file);
      const made = await api.attachment.create({
        name: file.name || `${side}.png`,
        type: file.type || "image/png",
        data,
      });
      setSlot(side, made);
    } catch (e: unknown) {
      const reason = reasonOf(e);
      error.set(reason);
      toast(t("web.base.compare.uploadFailed", { why: reason }), "bad");
    } finally {
      setUploading(side, false);
    }
  };

  const uploadDroppedUri = async (side: "before" | "after", uri: string) => {
    setUploading(side, true);
    error.set(undefined);
    try {
      const made = await importLocalAttachment(uri);
      setSlot(side, made);
    } catch (e: unknown) {
      const reason = reasonOf(e);
      error.set(reason);
      toast(t("web.base.compare.uploadFailed", { why: reason }), "bad");
    } finally {
      setUploading(side, false);
    }
  };

  const addAnnotationRow = () => {
    rows.set([...untracked(rows), { id: nextRowId++, side: "both", tone: "note", note: "" }]);
  };

  const updateRow = (id: number, patch: Partial<Omit<DraftAnnotationRow, "id">>) => {
    rows.set(untracked(rows).map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRow = (id: number) => {
    rows.set(untracked(rows).filter((r) => r.id !== id));
  };

  const busy = computed(() => uploadingBefore() || uploadingAfter() || submitting());
  const canSubmit = computed(() => !busy() && (before() !== undefined || after() !== undefined));

  const toneOptions = computed(() => [
    { value: "issue" as const, label: t("web.base.compare.toneIssue") },
    { value: "fixed" as const, label: t("web.base.compare.toneFixed") },
    { value: "note" as const, label: t("web.base.compare.toneNote") },
  ]);

  const sideOptions = computed(() => [
    { value: "both" as const, label: t("web.base.compare.sideBoth") },
    { value: "before" as const, label: t("web.base.compare.before") },
    { value: "after" as const, label: t("web.base.compare.after") },
  ]);

  const submit = async () => {
    const b = untracked(before);
    const a = untracked(after);
    if (!b && !a) return;
    submitting.set(true);
    error.set(undefined);
    try {
      const cleanTitle = untracked(title).trim();
      const nonEmptyAnnotations: CompareAnnotation[] = untracked(rows)
        .map((r) => ({ ...r, note: r.note.trim() }))
        .filter((r) => r.note !== "")
        .map((r, idx) => ({
          n: idx + 1,
          ...(b && a ? { side: r.side } : {}),
          rect: defaultAnnotationRect(idx),
          tone: r.tone,
          note: r.note,
        }));

      const spec: CompareSpec =
        b && a
          ? {
              ...(cleanTitle !== "" ? { title: cleanTitle } : {}),
              before: { attachment: b.id },
              after: { attachment: a.id },
              ...(nonEmptyAnnotations.length > 0 ? { annotations: nonEmptyAnnotations } : {}),
            }
          : {
              ...(cleanTitle !== "" ? { title: cleanTitle } : {}),
              image: {
                attachment: (b ?? a)!.id,
                label: b ? t("web.base.compare.before") : t("web.base.compare.after"),
              },
              ...(nonEmptyAnnotations.length > 0 ? { annotations: nonEmptyAnnotations } : {}),
            };

      const attachments: Attachment[] = [];
      if (b) attachments.push(b);
      if (a && a.id !== b?.id) attachments.push(a);

      await props.onSubmit({ spec, block: formatCompareBlock(spec), attachments });
    } catch (e: unknown) {
      const reason = reasonOf(e);
      error.set(reason);
      toast(reason, "bad");
    } finally {
      submitting.set(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t("web.base.compare.dialogTitle")}
      size="md"
      testid={props.testid ?? "compare-upload-dialog"}
      footer={
        <View class="flex-row items-center justify-end gap-2">
          <Button testID="compare-upload-cancel" tone="plain" disabled={submitting()} onPress={() => props.onClose()}>
            {t("web.base.compare.cancel")}
          </Button>
          <Button testID="compare-upload-submit" tone="primary" icon="diff" disabled={!canSubmit()} onPress={() => void submit()}>
            {t("web.base.compare.submit")}
          </Button>
        </View>
      }
    >
      <View class="gap-4">
        <Field label={t("web.base.compare.titleLabel")}>
          <TextInput
            testID="compare-upload-title"
            value={title()}
            placeholder={t("web.base.compare.titlePlaceholder")}
            accessibilityLabel={t("web.base.compare.titleLabel")}
            onInput={(v) => title.set(v)}
          />
        </Field>

        <View class="flex-row gap-3">
          <UploadSlot
            side="before"
            title={t("web.base.compare.before")}
            attachment={before()}
            uploading={uploadingBefore()}
            onPick={() => void uploadPickedFile("before")}
            onDropUri={(uri) => void uploadDroppedUri("before", uri)}
            onClear={() => before.set(undefined)}
          />
          <UploadSlot
            side="after"
            title={t("web.base.compare.after")}
            attachment={after()}
            uploading={uploadingAfter()}
            onPick={() => void uploadPickedFile("after")}
            onDropUri={(uri) => void uploadDroppedUri("after", uri)}
            onClear={() => after.set(undefined)}
          />
        </View>

        <If when={error()}>
          {(err) => (
            <Text role="alert" testID="compare-upload-error" class="text-xs text-berry">
              {t("web.base.compare.uploadFailed", { why: err() })}
            </Text>
          )}
        </If>

        <View class="gap-2 border-t border-line pt-3">
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-xs font-medium text-muted">{t("web.base.compare.annotations")}</Text>
            <Button size="compact" tone="quiet" icon="add" testID="compare-add-annotation" onPress={addAnnotationRow}>
              {t("web.base.compare.addAnnotation")}
            </Button>
          </View>
          <If when={rows().length > 0}>
            <View class="gap-2">
              <Each of={rows()} key={(r) => r.id}>
                {(row, i) => (
                  <View testID={`compare-draft-annotation-${i() + 1}`} class="flex-row items-center gap-1.5">
                    <Text class="w-6 shrink-0 font-mono text-xs text-muted tabular-nums">{`#${i() + 1}`}</Text>
                    <Select
                      testid={`compare-draft-tone-${i() + 1}`}
                      size="control"
                      text="xs"
                      class="w-24 shrink-0"
                      label={t("web.base.compare.toneLabel")}
                      value={row().tone}
                      options={toneOptions()}
                      onChange={(next) => updateRow(row().id, { tone: next })}
                    />
                    <Select
                      testid={`compare-draft-side-${i() + 1}`}
                      size="control"
                      text="xs"
                      class="w-20 shrink-0"
                      label={t("web.base.compare.sideLabel")}
                      value={row().side}
                      options={sideOptions()}
                      onChange={(next) => updateRow(row().id, { side: next })}
                    />
                    <TextInput
                      testID={`compare-draft-note-${i() + 1}`}
                      class="h-7 min-w-0 flex-1"
                      wide={false}
                      value={row().note}
                      placeholder={t("web.base.compare.annotationNotePlaceholder")}
                      accessibilityLabel={t("web.base.compare.annotationNote")}
                      onInput={(v) => updateRow(row().id, { note: v })}
                    />
                    <IconButton
                      icon="delete"
                      size={12}
                      label={t("web.base.compare.removeAnnotation")}
                      onClick={() => removeRow(row().id)}
                      testid={`compare-draft-remove-${i() + 1}`}
                    />
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>
      </View>
    </Dialog>
  );
}
