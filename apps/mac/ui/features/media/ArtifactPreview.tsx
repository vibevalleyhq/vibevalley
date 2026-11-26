import { colorScheme, computed, Image, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Artifact, ArtifactCover, ArtifactPreview as ArtifactPreviewData } from "@vibevalley/protocol";

import { Icon } from "../../design/Icon";
import { mix } from "../../design/tone";
import { fileUrl } from "../../infra/attachmentFile";
import { artifactIcon } from "../artifact";

type PreviewByTag<Tag extends ArtifactPreviewData["_tag"]> = Extract<ArtifactPreviewData, { readonly _tag: Tag }>;

function coverImageSrc(cover: ArtifactCover | undefined): string | undefined {
  if (cover === undefined) return undefined;
  if (cover.path !== "") return fileUrl(cover.path);
  return cover.url !== "" ? cover.url : undefined;
}

function frameImageSrc(framePath: string | undefined): string | undefined {
  return framePath !== undefined && framePath !== "" ? fileUrl(framePath) : undefined;
}

function DocsPreview(props: { readonly data: PreviewByTag<"docs"> }) {
  const hasHeading = () => props.data.heading !== undefined && props.data.heading !== "";
  const hasExcerpt = () => props.data.excerpt !== "";
  return (
    <View class="flex-1 overflow-hidden px-3 pt-3">
      <View class="flex-1 gap-1 overflow-hidden rounded-t-md border border-b-0 border-line bg-page px-3 pt-2.5 pb-2">
        <If when={hasHeading()}>
          <Text class="truncate text-xs font-semibold text-ink">{props.data.heading ?? ""}</Text>
        </If>
        <If
          when={hasExcerpt()}
          else={
            <If when={!hasHeading()}>
              <View class="gap-1.5 pt-1">
                <View class="h-1.5 w-2/3 rounded-xs bg-hover" />
                <View class="h-1.5 w-full rounded-xs bg-hover" />
                <View class="h-1.5 w-4/5 rounded-xs bg-hover" />
              </View>
            </If>
          }
        >
          <Text class={`text-2xs leading-relaxed text-muted ${hasHeading() ? "line-clamp-4" : "line-clamp-5"}`}>{props.data.excerpt}</Text>
        </If>
      </View>
    </View>
  );
}

function OutlinePreview(props: { readonly data: PreviewByTag<"outline"> }) {
  const rows = computed(() => props.data.items.slice(0, 4));
  const allDone = () => props.data.todoTotal > 0 && props.data.todoDone >= props.data.todoTotal;
  return (
    <View class="flex-1 justify-between overflow-hidden p-3">
      <If
        when={rows().length > 0}
        else={
          <View class="gap-2 pt-1">
            <View class="h-1.5 w-1/2 rounded-xs bg-hover" />
            <View class="h-1.5 w-3/4 rounded-xs bg-hover" />
            <View class="h-1.5 w-2/3 rounded-xs bg-hover" />
          </View>
        }
      >
        <View class="gap-1.5 overflow-hidden">
          <Each of={rows()} key="index">
            {(item) => {
              const padLeft = () => Math.min(3, Math.max(0, item().depth)) * 10;
              const isTodo = () => item().kind === "todo";
              const isHeading = () => item().kind === "heading";
              const checked = () => item().checked === true;
              return (
                <View class="flex-row items-center gap-1.5" style={{ paddingLeft: padLeft() }}>
                  <If
                    when={isTodo()}
                    else={
                      <If when={isHeading()} else={<View class="size-1 shrink-0 rounded-full bg-faint" />}>
                        <View class="size-1.5 shrink-0 rounded-full bg-accent" />
                      </If>
                    }
                  >
                    <View
                      class={`size-3 shrink-0 items-center justify-center rounded-xs border ${
                        checked() ? "border-accent bg-ok-soft" : "border-line-strong bg-page"
                      }`}
                    >
                      <If when={checked()}>
                        <Icon name="check" size={10} />
                      </If>
                    </View>
                  </If>
                  <Text class={`min-w-0 flex-1 truncate text-2xs ${isHeading() ? "font-semibold text-ink" : checked() ? "text-faint" : "text-muted"}`}>
                    {item().text}
                  </Text>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
      <If when={props.data.todoTotal > 0}>
        <View class="flex-row justify-end">
          <View class={`rounded-xs border border-line px-1.5 py-px ${allDone() ? "bg-ok-soft" : "bg-page"}`}>
            <Text class={`font-mono text-2xs tabular-nums ${allDone() ? "text-ok-ink" : "text-muted"}`}>
              {`${props.data.todoDone}/${props.data.todoTotal}`}
            </Text>
          </View>
        </View>
      </If>
    </View>
  );
}

function DesignSystemPreview(props: { readonly data: PreviewByTag<"design-system"> }) {
  const swatches = computed(() => props.data.swatches.slice(0, 6));
  const fontLine = computed(() => props.data.fonts.slice(0, 2).join(" · "));
  return (
    <View class="flex-1 justify-between gap-2.5 overflow-hidden p-3">
      <If
        when={swatches().length > 0}
        else={
          <View class="flex-1 flex-row overflow-hidden rounded-md border border-line bg-page">
            <View class="flex-1 bg-side" />
            <View class="flex-1 bg-accent" />
            <View class="flex-1 bg-wheat" />
            <View class="flex-1 bg-water" />
          </View>
        }
      >
        <View class="flex-1 flex-row overflow-hidden rounded-md border border-line bg-page">
          <Each of={swatches()} key="index">
            {(swatch) => {
              const fill = () => {
                const dark = colorScheme() === "dark";
                return dark && swatch().dark !== undefined && swatch().dark !== "" ? swatch().dark : swatch().light;
              };
              return <View class="flex-1" style={{ backgroundColor: fill() }} />;
            }}
          </Each>
        </View>
      </If>
      <View class="flex-row items-baseline justify-between gap-2">
        <Text class="shrink-0 text-base font-semibold text-ink">Aa</Text>
        <If when={fontLine() !== ""}>
          <Text class="min-w-0 flex-1 truncate text-right font-mono text-2xs text-muted">{fontLine()}</Text>
        </If>
      </View>
    </View>
  );
}

function DashboardPreview(props: { readonly data: PreviewByTag<"dashboard"> }) {
  const kpis = computed(() => props.data.kpis.slice(0, 3));
  const series = computed(() => props.data.series.slice(0, 12));
  return (
    <View class="flex-1 justify-between gap-2 overflow-hidden p-3">
      <If when={kpis().length > 0}>
        <View class="flex-row gap-1.5">
          <Each of={kpis()} key="index">
            {(kpi) => (
              <View class="min-w-0 flex-1 gap-0.5 rounded-sm border border-line bg-page px-2 py-1.5">
                <Text class="truncate text-2xs text-faint">{kpi().label}</Text>
                <Text class="truncate font-mono text-xs font-semibold text-ink tabular-nums">{kpi().value}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={series().length > 0}>
        <View class="h-11 flex-row items-end gap-1 rounded-sm border border-line bg-page px-2 pt-2 pb-1.5">
          <Each of={series()} key="index">
            {(val, idx) => {
              const barHeight = () => Math.max(3, Math.round(Math.min(1, Math.max(0, val())) * 28));
              const barColor = () => {
                colorScheme();
                return mix("accent", idx() === series().length - 1 ? 0.85 : 0.3);
              };
              return <View class="flex-1 rounded-xs" style={{ height: barHeight(), backgroundColor: barColor() }} />;
            }}
          </Each>
        </View>
      </If>
    </View>
  );
}

function SheetPreview(props: { readonly data: PreviewByTag<"sheet"> }) {
  const cols = computed(() => props.data.columns.slice(0, 4));
  const rows = computed(() => props.data.rows.slice(0, 3));
  const hasCounts = () => props.data.totalRows > 0 || props.data.totalCols > 0;
  return (
    <View class="flex-1 justify-between gap-1.5 overflow-hidden p-2.5">
      <View class="flex-1 overflow-hidden rounded-sm border border-line bg-page">
        <If when={cols().length > 0}>
          <View class="flex-row border-b border-line bg-side">
            <Each of={cols()} key="index">
              {(col, idx) => (
                <View class={`min-w-0 flex-1 px-1.5 py-1 ${idx() < cols().length - 1 ? "border-r border-line" : ""}`}>
                  <Text class="truncate font-mono text-2xs font-medium text-muted">{col()}</Text>
                </View>
              )}
            </Each>
          </View>
        </If>
        <Each of={rows()} key="index">
          {(row, rIdx) => {
            const cells = computed(() => {
              const count = Math.max(cols().length, Math.min(4, row().length));
              return row().slice(0, count);
            });
            return (
              <View class={`flex-row ${rIdx() < rows().length - 1 ? "border-b border-line" : ""}`}>
                <Each of={cells()} key="index">
                  {(cell, cIdx) => (
                    <View class={`min-w-0 flex-1 px-1.5 py-1 ${cIdx() < cells().length - 1 ? "border-r border-line" : ""}`}>
                      <Text class="truncate text-2xs text-ink tabular-nums">{cell()}</Text>
                    </View>
                  )}
                </Each>
              </View>
            );
          }}
        </Each>
      </View>
      <If when={hasCounts() || (props.data.sheetName !== undefined && props.data.sheetName !== "")}>
        <View class="flex-row items-center justify-between gap-2 px-0.5">
          <Text class="min-w-0 flex-1 truncate text-2xs text-faint">{props.data.sheetName ?? ""}</Text>
          <If when={hasCounts()}>
            <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{`${props.data.totalRows}×${props.data.totalCols}`}</Text>
          </If>
        </View>
      </If>
    </View>
  );
}

function SlidesPreview(props: { readonly data: PreviewByTag<"slides">; readonly fallbackTitle: string }) {
  const slideTitle = () => (props.data.firstTitle !== undefined && props.data.firstTitle !== "" ? props.data.firstTitle : props.fallbackTitle);
  const subtitle = () => props.data.firstSubtitle ?? "";
  return (
    <View class="flex-1 overflow-hidden p-3">
      <View class="relative flex-1 justify-center gap-1 overflow-hidden rounded-sm border border-line bg-page px-3.5 py-2.5">
        <View class="h-0.5 w-6 rounded-full bg-accent" />
        <Text class="line-clamp-2 text-xs font-semibold text-ink">{slideTitle()}</Text>
        <If when={subtitle() !== ""}>
          <Text class="truncate text-2xs text-muted">{subtitle()}</Text>
        </If>
        <If when={props.data.slideCount > 0}>
          <View class="absolute right-2 bottom-1.5">
            <Text class="font-mono text-2xs text-faint tabular-nums">{t("web.artifact.preview.slides", { n: props.data.slideCount })}</Text>
          </View>
        </If>
      </View>
    </View>
  );
}

function WhiteboardPreview(props: { readonly data: PreviewByTag<"whiteboard">; readonly width: number; readonly height: number }) {
  const shapes = computed(() => props.data.shapes.slice(0, 24));
  const innerW = computed(() => Math.max(40, props.width - 24));
  const innerH = computed(() => Math.max(30, props.height - 24));
  return (
    <View class="relative flex-1 overflow-hidden p-3">
      <View class="relative flex-1">
        <Each of={shapes()} key="index">
          {(shape) => {
            const left = () => Math.round(Math.min(0.95, Math.max(0, shape().x)) * innerW());
            const top = () => Math.round(Math.min(0.92, Math.max(0, shape().y)) * innerH());
            const w = () => Math.max(14, Math.min(innerW() - left(), Math.round(Math.max(0.06, shape().w) * innerW())));
            const h = () => Math.max(8, Math.min(innerH() - top(), Math.round(Math.max(0.06, shape().h) * innerH())));
            const kind = () => shape().kind;
            const boxClass = () => {
              if (kind() === "sticky") return "rounded-xs border border-line bg-warn-soft";
              if (kind() === "container") return "rounded-sm border border-dashed border-line-strong";
              if (kind() === "text") return "rounded-xs bg-hover";
              return "rounded-xs border border-line bg-page";
            };
            const showLabel = () => shape().label !== undefined && shape().label !== "" && w() >= 44 && h() >= 16;
            return (
              <View
                class={`absolute overflow-hidden ${kind() === "container" ? "justify-start pt-0.5" : "justify-center"} ${boxClass()}`}
                style={{ left: left(), top: top(), width: w(), height: h() }}
              >
                <If when={showLabel()}>
                  <Text class="truncate px-1 text-2xs text-muted">{shape().label ?? ""}</Text>
                </If>
              </View>
            );
          }}
        </Each>
      </View>
      <If when={props.data.nodeCount > 0}>
        <View class="absolute right-2.5 bottom-1.5 rounded-xs bg-side px-1">
          <Text class="font-mono text-2xs text-faint tabular-nums">{t("web.artifact.whiteboard.elements", { n: props.data.nodeCount })}</Text>
        </View>
      </If>
    </View>
  );
}

function DiagramPreview(props: { readonly data: PreviewByTag<"diagram"> }) {
  const nodes = computed(() => props.data.nodes.slice(0, 6));
  const countsText = computed(() => {
    const parts: string[] = [];
    if (props.data.nodeCount > 0) parts.push(t("web.artifact.preview.nodes", { n: props.data.nodeCount }));
    if (props.data.edgeCount > 0) parts.push(t("web.artifact.preview.edges", { n: props.data.edgeCount }));
    return parts.join(" · ");
  });
  return (
    <View class="flex-1 justify-between gap-2 overflow-hidden p-3">
      <View class="flex-1 justify-center overflow-hidden">
        <View class="flex-row flex-wrap items-center gap-1.5">
          <Each of={nodes()} key="index">
            {(label, idx) => (
              <View class="flex-row items-center gap-1.5">
                <View class="max-w-28 rounded-sm border border-line bg-page px-2 py-0.5">
                  <Text class="truncate text-2xs font-medium text-ink">{label()}</Text>
                </View>
                <If when={idx() < nodes().length - 1}>
                  <View class="h-px w-2 bg-line-strong" />
                </If>
              </View>
            )}
          </Each>
        </View>
      </View>
      <View class="flex-row items-center justify-between gap-2">
        <Text class="min-w-0 flex-1 truncate font-mono text-2xs text-faint">{props.data.kind ?? ""}</Text>
        <If when={countsText() !== ""}>
          <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{countsText()}</Text>
        </If>
      </View>
    </View>
  );
}

function DesignPreview(props: { readonly data: PreviewByTag<"design">; readonly width: number; readonly height: number; readonly id: string }) {
  const imgSrc = computed(() => frameImageSrc(props.data.framePath));
  const isPortrait = () => props.data.width !== undefined && props.data.height !== undefined && props.data.width < props.data.height;
  const dims = () => (props.data.width !== undefined && props.data.height !== undefined ? `${props.data.width}×${props.data.height}` : "");
  const topNodes = computed(() => props.data.nodes.slice(0, 3));
  return (
    <If
      when={imgSrc()}
      else={
        <View class="flex-1 items-center justify-between gap-1.5 overflow-hidden p-3">
          <View class={`flex-1 overflow-hidden rounded-sm border border-line bg-page ${isPortrait() ? "w-20" : "w-4/5"}`}>
            <View class="h-3 border-b border-line bg-side" />
            <If
              when={topNodes().length > 0}
              else={
                <View class="flex-1 gap-1.5 p-2">
                  <View class="h-2 w-1/2 rounded-xs bg-hover" />
                  <View class="h-5 w-full rounded-xs bg-side" />
                </View>
              }
            >
              <View class="flex-1 gap-1 p-2">
                <Each of={topNodes()} key="index">
                  {(node) => (
                    <View class="rounded-xs bg-side px-1.5 py-0.5">
                      <Text class="truncate text-2xs text-muted">{node()}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </View>
          <View class="w-full flex-row items-center justify-between gap-2">
            <Text class="min-w-0 flex-1 truncate text-2xs text-muted">{props.data.artboard ?? ""}</Text>
            <If when={dims() !== ""}>
              <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{dims()}</Text>
            </If>
          </View>
        </View>
      }
    >
      {(src) => <Image testID={`library-artifact-frame-${props.id}`} src={src()} style={{ width: props.width, height: props.height, objectFit: "cover" }} />}
    </If>
  );
}

function StoryboardPreview(props: { readonly data: PreviewByTag<"storyboard">; readonly width: number; readonly height: number; readonly id: string }) {
  const imgSrc = computed(() => frameImageSrc(props.data.framePath));
  const summary = () => props.data.firstShot ?? "";
  return (
    <If
      when={imgSrc()}
      else={
        <View class="flex-1 justify-between gap-2 overflow-hidden p-3">
          <View class="flex-1 justify-center rounded-sm border border-line bg-page px-3 py-2">
            <If
              when={summary() !== ""}
              else={
                <View class="items-center justify-center">
                  <Icon name="image" size={16} tone="faint" />
                </View>
              }
            >
              <Text class="line-clamp-3 text-2xs leading-relaxed text-ink">{summary()}</Text>
            </If>
          </View>
          <View class="flex-row items-center justify-between gap-2">
            <Text class="font-mono text-2xs text-faint tabular-nums">
              {props.data.shotCount > 0 ? t("web.artifact.preview.shots", { n: props.data.shotCount }) : ""}
            </Text>
            <If when={props.data.durationSec !== undefined && props.data.durationSec > 0}>
              <Text class="font-mono text-2xs text-faint tabular-nums">{`${(props.data.durationSec ?? 0).toFixed(1)}s`}</Text>
            </If>
          </View>
        </View>
      }
    >
      {(src) => <Image testID={`library-artifact-frame-${props.id}`} src={src()} style={{ width: props.width, height: props.height, objectFit: "cover" }} />}
    </If>
  );
}

function MotionPreview(props: { readonly data: PreviewByTag<"motion">; readonly width: number; readonly height: number; readonly id: string }) {
  const imgSrc = computed(() => frameImageSrc(props.data.framePath));
  const sceneName = () => props.data.firstScene ?? "";
  const metaText = computed(() => {
    const parts: string[] = [];
    if (props.data.sceneCount > 0) parts.push(t("web.artifact.preview.scenes", { n: props.data.sceneCount }));
    if (props.data.durationSec !== undefined && props.data.durationSec > 0) parts.push(`${props.data.durationSec.toFixed(1)}s`);
    return parts.join(" · ");
  });
  return (
    <If
      when={imgSrc()}
      else={
        <View class="flex-1 justify-between gap-2 overflow-hidden p-3">
          <View class="flex-1 flex-row items-center justify-center gap-2 rounded-sm border border-line bg-page px-3 py-2">
            <Icon name="play" size={14} tone="muted" />
            <If when={sceneName() !== ""}>
              <Text class="min-w-0 truncate text-xs font-medium text-ink">{sceneName()}</Text>
            </If>
          </View>
          <View class="flex-row items-center gap-2">
            <View class="h-1 flex-1 overflow-hidden rounded-full bg-hover">
              <View class="h-full w-1/3 rounded-full bg-accent" />
            </View>
            <If when={metaText() !== ""}>
              <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{metaText()}</Text>
            </If>
          </View>
        </View>
      }
    >
      {(src) => <Image testID={`library-artifact-frame-${props.id}`} src={src()} style={{ width: props.width, height: props.height, objectFit: "cover" }} />}
    </If>
  );
}

function PrototypeFallbackPreview(props: { readonly data: PreviewByTag<"prototype">; readonly fallbackTitle: string }) {
  const heading = () => (props.data.heading !== undefined && props.data.heading !== "" ? props.data.heading : props.fallbackTitle);
  const subtitle = () => props.data.subtitle ?? "";
  return (
    <View class="flex-1 overflow-hidden px-3 pt-3">
      <View class="flex-1 overflow-hidden rounded-t-md border border-b-0 border-line bg-page">
        <View class="h-4 flex-row items-center gap-1 border-b border-line bg-side px-2">
          <View class="size-1 rounded-full bg-line-strong" />
          <View class="size-1 rounded-full bg-line-strong" />
          <View class="size-1 rounded-full bg-line-strong" />
        </View>
        <View class="flex-1 justify-center gap-1 px-3 py-2">
          <Text class="truncate text-xs font-semibold text-ink">{heading()}</Text>
          <If when={subtitle() !== ""}>
            <Text class="line-clamp-2 text-2xs leading-relaxed text-muted">{subtitle()}</Text>
          </If>
        </View>
      </View>
    </View>
  );
}

function StructuredPreview(props: { readonly preview: ArtifactPreviewData; readonly artifact: Artifact; readonly width: number; readonly height: number }) {
  return (
    <View testID={`library-artifact-preview-${props.artifact.id}`} class="flex-1 overflow-hidden">
      <If when={props.preview._tag === "docs" ? props.preview : undefined}>{(d) => <DocsPreview data={d()} />}</If>
      <If when={props.preview._tag === "outline" ? props.preview : undefined}>{(d) => <OutlinePreview data={d()} />}</If>
      <If when={props.preview._tag === "design-system" ? props.preview : undefined}>{(d) => <DesignSystemPreview data={d()} />}</If>
      <If when={props.preview._tag === "dashboard" ? props.preview : undefined}>{(d) => <DashboardPreview data={d()} />}</If>
      <If when={props.preview._tag === "sheet" ? props.preview : undefined}>{(d) => <SheetPreview data={d()} />}</If>
      <If when={props.preview._tag === "slides" ? props.preview : undefined}>{(d) => <SlidesPreview data={d()} fallbackTitle={props.artifact.title} />}</If>
      <If when={props.preview._tag === "whiteboard" ? props.preview : undefined}>
        {(d) => <WhiteboardPreview data={d()} width={props.width} height={props.height} />}
      </If>
      <If when={props.preview._tag === "diagram" ? props.preview : undefined}>{(d) => <DiagramPreview data={d()} />}</If>
      <If when={props.preview._tag === "design" ? props.preview : undefined}>
        {(d) => <DesignPreview data={d()} width={props.width} height={props.height} id={props.artifact.id} />}
      </If>
      <If when={props.preview._tag === "storyboard" ? props.preview : undefined}>
        {(d) => <StoryboardPreview data={d()} width={props.width} height={props.height} id={props.artifact.id} />}
      </If>
      <If when={props.preview._tag === "motion" ? props.preview : undefined}>
        {(d) => <MotionPreview data={d()} width={props.width} height={props.height} id={props.artifact.id} />}
      </If>
      <If when={props.preview._tag === "prototype" ? props.preview : undefined}>
        {(d) => <PrototypeFallbackPreview data={d()} fallbackTitle={props.artifact.title} />}
      </If>
    </View>
  );
}

export function ArtifactPreview(props: { readonly artifact: Artifact; readonly width: number; readonly height: number }) {
  const coverSrc = computed(() => coverImageSrc(props.artifact.cover));
  return (
    <If
      when={coverSrc()}
      else={
        <If
          when={props.artifact.preview}
          else={
            <View testID={`library-artifact-preview-${props.artifact.id}`} class="flex-1 items-center justify-center">
              <Icon name={artifactIcon(props.artifact)} size={20} tone="faint" />
            </View>
          }
        >
          {(preview) => <StructuredPreview preview={preview()} artifact={props.artifact} width={props.width} height={props.height} />}
        </If>
      }
    >
      {(src) => (
        <Image testID={`library-artifact-cover-${props.artifact.id}`} src={src()} style={{ width: props.width, height: props.height, objectFit: "cover" }} />
      )}
    </If>
  );
}
