import { computed, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { CompareUploadDialog, type CompareUploadResult } from "./compare/CompareUploadDialog";
import { CompareLegend, ComparePanel, CompareSliderView } from "./compare/CompareViews";
import { useResolvedImage, type CompareMode } from "./compare/shared";
import { isDualCompare, type CompareSpec } from "./compareModel";
import { Icon } from "./Icon";
import { Lightbox, type Picture } from "./Lightbox";
import { motionClass } from "./motion";
import { Segmented } from "./Segmented";

export { CompareUploadDialog, type CompareUploadResult };

export interface CompareProps {
  readonly spec: CompareSpec;
  readonly class?: string | undefined;
  readonly testid?: string | undefined;
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

      <CompareLegend
        annotations={annotations()}
        dual={dual()}
        activeAnnotation={activeAnnotation()}
        onHover={(n) => activeAnnotation.set(n)}
        onToggle={(n) => activeAnnotation.set(untracked(activeAnnotation) === n ? undefined : n)}
      />
    </View>
  );
}
