import { Clipboard, computed, effect, Scroll, signal, Text, View, windowSize } from "nsh";
import { Dialog as Base } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { CodeBlock } from "./code/CodeBlock";
import { Diagram } from "./code/Diagram";
import { IconButton } from "./IconButton";
import { fadeAnimation } from "./motion";
import { Segmented } from "./Segmented";
import { Bubble } from "./Tip";

export type RichPreviewPayload = {
  readonly kind: "mermaid";
  readonly source: string;
};

type RichPreviewMode = "diagram" | "source";

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 25;
const ZOOM_DEFAULT = 100;

export interface RichPreviewModalProps {
  payload: RichPreviewPayload | undefined;
  onClose: () => void;
}

/** Modal viewer for rich message previews (Mermaid diagram + source toggle + zoom). */
export function RichPreviewModal(props: RichPreviewModalProps) {
  const mode = signal<RichPreviewMode>("diagram");
  const zoom = signal(ZOOM_DEFAULT);
  const copied = signal(false);
  let copySeq = 0;

  effect(() => {
    const _current = props.payload;
    void _current;
    mode.set("diagram");
    zoom.set(ZOOM_DEFAULT);
    copied.set(false);
  });

  const modalWidth = computed(() => Math.min(1080, windowSize().width * 0.92));
  const modalHeight = computed(() => windowSize().height * 0.88);
  const maxDiagramWidth = computed(() => Math.max(320, Math.round((modalWidth() - 64) * (zoom() / 100))));
  const canZoomOut = computed(() => zoom() > ZOOM_MIN);
  const canZoomIn = computed(() => zoom() < ZOOM_MAX);
  const zoomLabel = computed(() => `${zoom()}%`);

  const zoomOut = () => zoom.set(Math.max(ZOOM_MIN, zoom() - ZOOM_STEP));
  const zoomIn = () => zoom.set(Math.min(ZOOM_MAX, zoom() + ZOOM_STEP));
  const zoomReset = () => zoom.set(ZOOM_DEFAULT);

  const copySource = (source: string) => {
    void Clipboard.writeText(source).then(
      () => {
        const seq = ++copySeq;
        copied.set(true);
        setTimeout(() => {
          if (copySeq === seq) copied.set(false);
        }, 1500);
      },
      () => undefined,
    );
  };

  return (
    <Base
      open={props.payload !== undefined}
      testID="rich-preview-modal"
      accessibilityLabel={t("web.base.rich.diagram")}
      animation={fadeAnimation()}
      onOpenChange={(e) => !e.open && props.onClose()}
      backdropClass="bg-scrim"
      class="m-auto flex-col overflow-hidden rounded-lg border border-line bg-elevated shadow-float"
      style={{ width: modalWidth(), maxHeight: modalHeight() }}
    >
      <If when={props.payload}>
        {(item) => (
          <>
            <View class="min-h-12 shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
              <View class="min-w-0 flex-row items-center gap-3">
                <Text role="header" class="truncate text-base font-semibold text-ink">
                  {t("web.base.rich.diagram")}
                </Text>
                <Segmented
                  testid="rich-preview-tab"
                  label={t("web.base.rich.diagram")}
                  value={mode()}
                  onChange={(next) => mode.set(next)}
                  options={[
                    { value: "diagram", label: t("web.base.rich.viewDiagram") },
                    { value: "source", label: t("web.base.rich.viewSource") },
                  ]}
                />
              </View>
              <View class="shrink-0 flex-row items-center gap-1">
                <If when={mode() === "diagram"}>
                  <View class="mr-1 flex-row items-center gap-0.5 rounded-md border border-line bg-side p-0.5">
                    <IconButton
                      icon="minus"
                      size={12}
                      label={t("web.base.rich.zoomOut")}
                      disabled={!canZoomOut()}
                      onClick={zoomOut}
                      testid="rich-preview-zoom-out"
                    />
                    <View
                      role="button"
                      testID="rich-preview-zoom-reset"
                      accessibilityLabel={t("web.base.rich.zoomReset")}
                      tooltip={<Bubble text={t("web.base.rich.zoomReset")} />}
                      onPress={zoomReset}
                      class="h-7 min-w-12 items-center justify-center rounded-sm px-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <Text testID="rich-preview-zoom-label" class="font-mono text-xs font-medium text-ink tabular-nums">
                        {zoomLabel()}
                      </Text>
                    </View>
                    <IconButton icon="add" size={12} label={t("web.base.rich.zoomIn")} disabled={!canZoomIn()} onClick={zoomIn} testid="rich-preview-zoom-in" />
                  </View>
                </If>
                <IconButton
                  icon={copied() ? "check" : "copy"}
                  size={14}
                  label={copied() ? t("web.base.rich.copied") : t("web.base.rich.copy")}
                  onClick={() => copySource(item().source)}
                  testid="rich-preview-copy"
                />
                <IconButton icon="close" size={14} label={t("web.base.lightbox.close")} onClick={() => props.onClose()} testid="rich-preview-close" />
              </View>
            </View>
            <If
              when={mode() === "diagram"}
              else={
                <Scroll class="min-h-0 flex-1" contentClass="p-5">
                  <View testID="rich-preview-source-pane">
                    <CodeBlock code={item().source} language="mermaid" foldLines={0} />
                  </View>
                </Scroll>
              }
            >
              <Scroll class="min-h-0 flex-1" contentClass="items-center justify-center p-5">
                <View testID="rich-preview-diagram-pane" class="max-w-full">
                  <Scroll horizontal class="max-w-full">
                    <Diagram source={item().source} maxWidth={maxDiagramWidth()} interactive={false} />
                  </Scroll>
                </View>
              </Scroll>
            </If>
          </>
        )}
      </If>
    </Base>
  );
}
