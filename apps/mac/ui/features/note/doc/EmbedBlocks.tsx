import { computed, effect, signal, untracked, View, WebView, Text } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import {
  type BaseCellValue,
  type BaseColumn,
  type BaseRow,
  type DocBlock,
  type DocKpiItem,
  type Issue,
  type IssueId,
  type IssueStatus,
  type MediaAnnotation,
  MediaInputKindValues,
  type Note,
  type NoteId,
} from "@vibevalley/protocol";
import { noteId } from "@vibevalley/protocol/schema";

import { Button } from "../../../design/Button";
import { Chart } from "../../../design/code/Chart";
import { Diagram } from "../../../design/code/Diagram";
import { TextArea, TextInput } from "../../../design/Field";
import { useDesignHost } from "../../../design/host";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import type { Picture } from "../../../design/Lightbox";
import { Segmented } from "../../../design/Segmented";
import { Dot } from "../../../design/Tag";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { api, reasonOf } from "../../../infra/api";
import { currentHost } from "../../../infra/host";
import { ready, useQuery, useQueryClient } from "../../../infra/query";
import { VdpAnchor } from "../../../infra/vdpProbe";
import { noteBaseQuery } from "../store";
import { baseCellAsStrings, baseCellAsText, findSelectOption, optionToneLook } from "../views/baseModel";
import { SANDBOX_CSP } from "../views/noteFiles";
import { buildChartSpecJson, filterIssuesForList, ISSUE_STATUS_DOT_TONE, resolveIssueRef, updateKpiItem } from "./docOps";
import { type DocAnnotationRef, severityVisualOf } from "./mediaAnnotationModel";
import { MediaAnnotationStage } from "./MediaAnnotationOverlay";

type KpiBlockData = Extract<DocBlock, { type: "kpi" }>;
type ChartBlockData = Extract<DocBlock, { type: "chart" }>;
type DiagramBlockData = Extract<DocBlock, { type: "diagram" }>;
type CompareBlockData = Extract<DocBlock, { type: "compare" }>;
type MediaBlockData = Extract<DocBlock, { type: "media" }>;
type PreviewBlockData = Extract<DocBlock, { type: "preview" }>;
type BaseEmbedBlockData = Extract<DocBlock, { type: "baseEmbed" }>;
type IssueCardBlockData = Extract<DocBlock, { type: "issueCard" }>;
type IssueListBlockData = Extract<DocBlock, { type: "issueList" }>;

function sandboxHtmlForPreview(entry: string, title?: string): string {
  const safeEntry = entry.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const safeTitle = (title || "Preview").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}" /></head><body style="font-family:system-ui;padding:16px;margin:0;"><div style="font-weight:600;margin-bottom:6px;">${safeTitle}</div><div style="font-family:monospace;font-size:12px;opacity:0.75;">${safeEntry}</div></body></html>`;
}

const statusLabel = (status: IssueStatus): string => t(`shared.status.${status}`);

function kpiToneLook(tone: string | undefined): { readonly bg: string; readonly text: string } {
  switch (tone) {
    case "ok":
    case "good":
      return { bg: "bg-ok-soft", text: "text-ok-ink" };
    case "bad":
    case "danger":
      return { bg: "bg-bad-soft", text: "text-berry" };
    case "warn":
      return { bg: "bg-warn-soft", text: "text-warn-ink" };
    default:
      return { bg: "bg-side", text: "text-muted" };
  }
}

export function KpiBlockView(props: { readonly block: KpiBlockData; readonly onUpdate: (next: KpiBlockData) => void }) {
  const editing = signal(false);

  return (
    <View testID={`doc-kpi-${props.block.id}`} class="relative gap-1.5 py-1">
      <View class="flex-row items-start gap-2.5">
        <View class="min-w-0 flex-1 flex-row flex-wrap gap-2.5">
          <Each of={props.block.items} key={(_, idx) => String(idx)}>
            {(item, idx) => {
              const deltaLook = () => kpiToneLook(item().tone);
              return (
                <View class="min-w-36 flex-1 gap-1 rounded-md border border-line bg-side p-2.5">
                  <If
                    when={editing()}
                    else={
                      <>
                        <Text class="truncate text-2xs font-medium text-muted">{item().label}</Text>
                        <View class="flex-row items-baseline justify-between gap-2">
                          <Text class="text-xl font-semibold text-ink tabular-nums">{item().value}</Text>
                          <If when={item().delta}>
                            {(d) => (
                              <View class={`rounded-xs px-1.5 py-px ${deltaLook().bg}`}>
                                <Text class={`font-mono text-2xs font-medium tabular-nums ${deltaLook().text}`}>{d()}</Text>
                              </View>
                            )}
                          </If>
                        </View>
                      </>
                    }
                  >
                    <View class="gap-1">
                      <Input
                        value={item().label}
                        placeholder={t("web.note.doc.titleOptional")}
                        onChange={(e) => props.onUpdate({ ...props.block, items: updateKpiItem(props.block.items, idx(), { label: e.value }) })}
                        class="h-6 rounded-xs border border-line bg-page px-1.5 text-2xs text-ink"
                      />
                      <Input
                        value={item().value}
                        placeholder="0"
                        onChange={(e) => props.onUpdate({ ...props.block, items: updateKpiItem(props.block.items, idx(), { value: e.value }) })}
                        class="h-6 rounded-xs border border-line bg-page px-1.5 font-mono text-xs text-ink"
                      />
                      <Input
                        value={item().delta ?? ""}
                        placeholder="+0%"
                        onChange={(e) => props.onUpdate({ ...props.block, items: updateKpiItem(props.block.items, idx(), { delta: e.value || undefined }) })}
                        class="h-6 rounded-xs border border-line bg-page px-1.5 font-mono text-2xs text-muted"
                      />
                    </View>
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
        <View
          class={`shrink-0 flex-row items-center gap-0.5 pt-0.5 ${editing() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
        >
          <IconButton
            icon="add"
            size={14}
            label={t("web.note.doc.add")}
            testid={`doc-kpi-add-${props.block.id}`}
            onClick={() => {
              const nextItem: DocKpiItem = { label: t("web.note.doc.slash.kpi.label"), value: "0", delta: "+0%", tone: "good" };
              props.onUpdate({ ...props.block, items: [...props.block.items, nextItem] });
              editing.set(true);
            }}
          />
          <IconButton icon={editing() ? "check" : "edit"} size={14} label={t("web.note.doc.kpiEdit")} onClick={() => editing.set(!editing())} />
        </View>
      </View>
    </View>
  );
}

export function ChartBlockView(props: { readonly block: ChartBlockData; readonly onUpdate: (next: ChartBlockData) => void }) {
  const editing = signal(false);
  const specJson = computed(() => buildChartSpecJson(props.block));

  return (
    <View testID={`doc-chart-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <View class="flex-row items-center justify-between gap-2">
        <Text class="truncate text-xs font-semibold text-ink">{props.block.title || t("web.note.doc.chartTitle")}</Text>
        <View class={`flex-row items-center gap-1 ${editing() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}>
          <Each of={["bar", "line", "area"] as const} key={(kind) => kind}>
            {(kind) => (
              <View
                role="button"
                onPress={() => props.onUpdate({ ...props.block, kind: kind() })}
                class={`rounded-xs px-1.5 py-0.5 ${props.block.kind === kind() ? "bg-selected" : "hover:bg-hover"}`}
              >
                <Text class="font-mono text-2xs text-muted">{kind()}</Text>
              </View>
            )}
          </Each>
          <IconButton icon={editing() ? "show" : "edit"} size={14} label={t("web.note.doc.chartEdit")} onClick={() => editing.set(!editing())} />
        </View>
      </View>
      <If when={editing()}>
        <View class="gap-2 rounded-md border border-line bg-page p-2">
          <TextInput
            value={props.block.title ?? ""}
            placeholder={t("web.note.doc.titleOptional")}
            onInput={(v) => props.onUpdate({ ...props.block, title: v || undefined })}
          />
          <TextInput
            value={props.block.labels.join(", ")}
            placeholder="W1, W2, W3"
            onInput={(v) =>
              props.onUpdate({
                ...props.block,
                labels: v
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </View>
      </If>
      <Chart spec={specJson()} title={props.block.title} class="my-0" />
    </View>
  );
}

export function DiagramBlockView(props: { readonly block: DiagramBlockData; readonly onUpdate: (next: DiagramBlockData) => void }) {
  const editing = signal(untracked(() => props.block.source.trim() === ""));

  return (
    <View testID={`doc-diagram-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <View class="flex-row items-center justify-between gap-2">
        <Text class="truncate text-xs font-semibold text-ink">{props.block.title || t("web.base.rich.diagram")}</Text>
        <View class={editing() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}>
          <Button size="compact" tone="quiet" icon={editing() ? "show" : "edit"} onPress={() => editing.set(!editing())}>
            {editing() ? t("web.base.rich.viewDiagram") : t("web.base.rich.viewSource")}
          </Button>
        </View>
      </View>
      <If when={editing()} else={<Diagram source={props.block.source} interactive class="my-0" />}>
        <View class="gap-2">
          <TextInput
            value={props.block.title ?? ""}
            placeholder={t("web.note.doc.titleOptional")}
            onInput={(v) => props.onUpdate({ ...props.block, title: v || undefined })}
          />
          <TextArea
            rows={4}
            value={props.block.source}
            placeholder="flowchart LR..."
            onInput={(v) => props.onUpdate({ ...props.block, source: v })}
            class="font-mono text-xs"
          />
        </View>
      </If>
    </View>
  );
}

export function CompareBlockView(props: {
  readonly block: CompareBlockData;
  readonly issues?: readonly Issue[] | undefined;
  readonly selectedAnnotationId?: string | undefined;
  readonly onUpdate: (next: CompareBlockData) => void;
  readonly onSelectAnnotation?: ((annId: string | undefined, baseRowId?: string) => void) | undefined;
  readonly onJumpToBaseRow?: ((rowId: string, annId: string) => void) | undefined;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
  readonly onCreateIssueFromAnnotation?: ((ann: MediaAnnotation, blockId: string) => Promise<IssueId | undefined>) | undefined;
  readonly onOpenLightbox?: ((pic: Picture) => void) | undefined;
}) {
  const editing = signal(false);
  const mode = signal<"side" | "focus">("side");
  const allAnnotations = computed(() => props.block.annotations ?? []);
  const beforeAnnotations = computed(() => allAnnotations().filter((a) => a.side === "before"));
  const afterAnnotations = computed(() => allAnnotations().filter((a) => a.side !== "before"));

  const updateSideAnnotations = (side: "before" | "after", nextSide: readonly MediaAnnotation[]) => {
    const tagged = nextSide.map((a) => ({ ...a, side }));
    const others = allAnnotations().filter((a) => (side === "before" ? a.side !== "before" : a.side === "before"));
    props.onUpdate({ ...props.block, annotations: [...others, ...tagged] });
  };

  const handleSelect = (annId: string | undefined) => {
    const found = annId !== undefined ? allAnnotations().find((a) => a.id === annId) : undefined;
    props.onSelectAnnotation?.(annId, found?.baseRowId);
  };

  return (
    <View testID={`doc-compare-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <View class="flex-row items-center justify-between gap-2">
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Icon name="diff" size={14} tone="muted" />
          <Text class="truncate text-xs font-semibold text-ink">{props.block.title || t("web.base.compare.title")}</Text>
        </View>
        <View class={`flex-row items-center gap-1.5 ${editing() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}>
          <Segmented
            label={t("web.base.compare.modeLabel")}
            value={mode()}
            onChange={(m) => mode.set(m)}
            options={[
              { value: "side", label: t("web.base.compare.sideBySide") },
              { value: "focus", label: t("web.base.compare.after") },
            ]}
          />
          <IconButton icon={editing() ? "show" : "edit"} size={14} label={t("web.note.doc.compareEdit")} onClick={() => editing.set(!editing())} />
        </View>
      </View>
      <If when={editing()}>
        <View class="gap-2 rounded-md border border-line bg-page p-2">
          <TextInput
            value={props.block.title ?? ""}
            placeholder={t("web.note.doc.titleOptional")}
            onInput={(v) => props.onUpdate({ ...props.block, title: v || undefined })}
          />
          <View class="flex-row gap-2">
            <TextInput
              wide={false}
              class="flex-1"
              value={props.block.beforeLabel}
              placeholder={t("web.base.compare.before")}
              onInput={(v) => props.onUpdate({ ...props.block, beforeLabel: v })}
            />
            <TextInput
              wide={false}
              class="flex-1"
              value={props.block.beforeAsset}
              placeholder="asset/before.png"
              onInput={(v) => props.onUpdate({ ...props.block, beforeAsset: v })}
            />
          </View>
          <View class="flex-row gap-2">
            <TextInput
              wide={false}
              class="flex-1"
              value={props.block.afterLabel}
              placeholder={t("web.base.compare.after")}
              onInput={(v) => props.onUpdate({ ...props.block, afterLabel: v })}
            />
            <TextInput
              wide={false}
              class="flex-1"
              value={props.block.afterAsset}
              placeholder="asset/after.png"
              onInput={(v) => props.onUpdate({ ...props.block, afterAsset: v })}
            />
          </View>
        </View>
      </If>
      <View class="flex-row gap-2">
        <If when={mode() === "side"}>
          <View class="min-w-0 flex-1 gap-1 rounded-md border border-line bg-page p-2">
            <Text class="text-2xs font-semibold text-muted">{props.block.beforeLabel || t("web.base.compare.before")}</Text>
            <If when={props.block.beforeAsset.trim().length > 0} else={<Text class="text-2xs text-faint">{t("web.note.doc.noBeforeAsset")}</Text>}>
              <MediaAnnotationStage
                scopeId={`${props.block.id}-before`}
                src={props.block.beforeAsset}
                caption={props.block.beforeLabel}
                annotations={beforeAnnotations()}
                stageClass="h-40"
                selectedAnnotationId={props.selectedAnnotationId}
                issues={props.issues}
                onSelectAnnotation={handleSelect}
                onChangeAnnotations={(next) => updateSideAnnotations("before", next)}
                onOpenLightbox={
                  props.onOpenLightbox
                    ? () => props.onOpenLightbox?.({ src: props.block.beforeAsset, name: props.block.beforeLabel || props.block.beforeAsset })
                    : undefined
                }
                onOpenIssue={props.onOpenIssue}
                onCreateIssue={props.onCreateIssueFromAnnotation ? (ann) => props.onCreateIssueFromAnnotation?.(ann, props.block.id) : undefined}
                onJumpToBaseRow={props.onJumpToBaseRow}
              />
            </If>
          </View>
        </If>
        <View class="min-w-0 flex-1 gap-1 rounded-md border border-line bg-page p-2">
          <Text class="text-2xs font-semibold text-ok-ink">{props.block.afterLabel || t("web.base.compare.after")}</Text>
          <If when={props.block.afterAsset.trim().length > 0} else={<Text class="text-2xs text-faint">{t("web.note.doc.noAfterAsset")}</Text>}>
            <MediaAnnotationStage
              scopeId={`${props.block.id}-after`}
              src={props.block.afterAsset}
              caption={props.block.afterLabel}
              annotations={afterAnnotations()}
              stageClass="h-40"
              selectedAnnotationId={props.selectedAnnotationId}
              issues={props.issues}
              onSelectAnnotation={handleSelect}
              onChangeAnnotations={(next) => updateSideAnnotations("after", next)}
              onOpenLightbox={
                props.onOpenLightbox
                  ? () => props.onOpenLightbox?.({ src: props.block.afterAsset, name: props.block.afterLabel || props.block.afterAsset })
                  : undefined
              }
              onOpenIssue={props.onOpenIssue}
              onCreateIssue={props.onCreateIssueFromAnnotation ? (ann) => props.onCreateIssueFromAnnotation?.(ann, props.block.id) : undefined}
              onJumpToBaseRow={props.onJumpToBaseRow}
            />
          </If>
        </View>
      </View>
    </View>
  );
}

export function MediaBlockView(props: {
  readonly block: MediaBlockData;
  readonly issues?: readonly Issue[] | undefined;
  readonly selectedAnnotationId?: string | undefined;
  readonly onUpdate: (next: MediaBlockData) => void;
  readonly onSelectAnnotation?: ((annId: string | undefined, baseRowId?: string) => void) | undefined;
  readonly onJumpToBaseRow?: ((rowId: string, annId: string) => void) | undefined;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
  readonly onCreateIssueFromAnnotation?: ((ann: MediaAnnotation, blockId: string) => Promise<IssueId | undefined>) | undefined;
  readonly onOpenMediaLightbox?: ((blockId: string) => void) | undefined;
  readonly onOpenLightbox?: ((pic: Picture) => void) | undefined;
}) {
  const host = useDesignHost();
  const editing = signal(untracked(() => props.block.src.trim() === ""));
  const annotations = computed(() => props.block.annotations ?? []);

  return (
    <View testID={`doc-media-${props.block.id}`} class="gap-2 rounded-lg border border-line bg-side p-3">
      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-row items-center gap-1.5">
          <Icon name={props.block.mediaKind === "audio" ? "audio" : props.block.mediaKind === "video" ? "video" : "image"} size={14} tone="muted" />
          <Text class="font-mono text-2xs text-muted">{props.block.mediaKind || "image"}</Text>
        </View>
        <View class={editing() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}>
          <IconButton icon={editing() ? "show" : "edit"} size={14} label={t("web.note.doc.mediaEdit")} onClick={() => editing.set(!editing())} />
        </View>
      </View>
      <If when={editing()}>
        <View class="gap-2 rounded-md border border-line bg-page p-2">
          <View class="flex-row gap-1">
            <Each of={MediaInputKindValues} key={(mk) => mk}>
              {(mk) => (
                <Button
                  size="compact"
                  tone={props.block.mediaKind === mk() ? "primary" : "plain"}
                  onPress={() => props.onUpdate({ ...props.block, mediaKind: mk() })}
                >
                  {mk()}
                </Button>
              )}
            </Each>
          </View>
          <TextInput value={props.block.src} placeholder="asset/hero.png or https://..." onInput={(v) => props.onUpdate({ ...props.block, src: v })} />
          <TextInput
            value={props.block.caption ?? ""}
            placeholder={t("web.note.doc.descOptional")}
            onInput={(v) => props.onUpdate({ ...props.block, caption: v || undefined })}
          />
        </View>
      </If>
      <If when={props.block.src.trim().length > 0}>
        <If
          when={props.block.mediaKind === "image" || props.block.mediaKind === ""}
          else={
            <View
              role="button"
              onPress={() => void host.openExternal(props.block.src)}
              class="flex-row items-center gap-2 rounded-md border border-line bg-page px-3 py-2 hover:bg-hover"
            >
              <Icon name={props.block.mediaKind === "audio" ? "audio" : "video"} size={16} tone="accent" />
              <Text class="min-w-0 flex-1 truncate text-xs text-ink">{props.block.caption || props.block.src}</Text>
              <Icon name="open" size={12} tone="muted" />
            </View>
          }
        >
          <MediaAnnotationStage
            scopeId={props.block.id}
            src={props.block.src}
            caption={props.block.caption}
            annotations={annotations()}
            stageClass="h-64"
            selectedAnnotationId={props.selectedAnnotationId}
            issues={props.issues}
            onSelectAnnotation={(annId) => {
              const found = annId !== undefined ? annotations().find((a) => a.id === annId) : undefined;
              props.onSelectAnnotation?.(annId, found?.baseRowId);
            }}
            onChangeAnnotations={(next) => props.onUpdate({ ...props.block, annotations: [...next] })}
            onOpenLightbox={() => {
              if (props.onOpenMediaLightbox) props.onOpenMediaLightbox(props.block.id);
              else props.onOpenLightbox?.({ src: props.block.src, name: props.block.caption || props.block.src });
            }}
            onOpenIssue={props.onOpenIssue}
            onCreateIssue={props.onCreateIssueFromAnnotation ? (ann) => props.onCreateIssueFromAnnotation?.(ann, props.block.id) : undefined}
            onJumpToBaseRow={props.onJumpToBaseRow}
          />
        </If>
      </If>
      <If when={props.block.caption}>{(cap) => <Text class="text-xs text-muted">{cap()}</Text>}</If>
    </View>
  );
}

const COVER_CAPTURE_DELAY_MS = 800;
const COVER_CAPTURE_WIDTH = 640;
const COVER_CAPTURE_HEIGHT = 400;

/** Tracks `${noteId}:${seq}` pairs already attempted this session so failed or no-op captures do not loop. */
const attemptedCoverCaptures = new Set<string>();

export function PreviewBlockView(props: {
  readonly block: PreviewBlockData;
  readonly note?: Note | undefined;
  readonly onUpdate: (next: PreviewBlockData) => void;
}) {
  const queries = useQueryClient();
  const editing = signal(false);
  const frameHeight = () => Math.max(120, Math.min(720, props.block.height ?? 260));
  const html = computed(() => sandboxHtmlForPreview(props.block.entry, props.block.title));

  effect(() => {
    const n = props.note;
    if (!n) return;
    if (n.cover?.seq === n.seq) return;
    const capture = currentHost().captureWebView;
    if (capture === undefined) return;

    const attemptKey = `${n.id}:${n.seq}`;
    if (attemptedCoverCaptures.has(attemptKey)) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      attemptedCoverCaptures.add(attemptKey);
      void (async () => {
        try {
          const captured = await capture({ width: COVER_CAPTURE_WIDTH, height: COVER_CAPTURE_HEIGHT });
          if (cancelled || captured === null) return;
          await api.note.cover.set({
            id: noteId(n.id),
            seq: n.seq,
            mime: captured.mime,
            data: captured.data,
            width: captured.width,
            height: captured.height,
          });
          if (!cancelled) {
            void queries.invalidate({ prefix: ["notes"] });
          }
        } catch {
          // Background auto-cover capture is silent best-effort; never surface errors to the user.
        }
      })();
    }, COVER_CAPTURE_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  return (
    <View testID={`doc-preview-${props.block.id}`} class="overflow-hidden rounded-lg border border-line bg-side">
      <View class="flex-row items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Icon name="web" size={14} tone="muted" />
          <Text class="truncate text-xs font-semibold text-ink">{props.block.title || t("web.note.doc.previewTitle")}</Text>
          <Text class="truncate font-mono text-2xs text-faint">{props.block.entry}</Text>
        </View>
        <View class={editing() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}>
          <IconButton icon={editing() ? "show" : "edit"} size={14} label={t("web.note.doc.previewEdit")} onClick={() => editing.set(!editing())} />
        </View>
      </View>
      <If when={editing()}>
        <View class="gap-2 border-b border-line bg-page p-2">
          <TextInput
            value={props.block.title ?? ""}
            placeholder={t("web.note.doc.titleOptional")}
            onInput={(v) => props.onUpdate({ ...props.block, title: v || undefined })}
          />
          <TextInput value={props.block.entry} placeholder="structure/index.html" onInput={(v) => props.onUpdate({ ...props.block, entry: v })} />
        </View>
      </If>
      <WebView
        testID={`doc-preview-webview-${props.block.id}`}
        accessibilityLabel={props.block.title || props.block.entry}
        html={html()}
        incognito
        class="w-full bg-page"
        style={{ height: frameHeight() }}
      />
    </View>
  );
}

function renderBaseEmbedCell(
  col: BaseColumn,
  cell: BaseCellValue | undefined,
  row: BaseRow,
  ctx: {
    readonly notes: readonly Note[];
    readonly issues: readonly Issue[];
    readonly runningKey: string | undefined;
    readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
    readonly onRunAgentRow?: ((colId: string, rowId: string) => void) | undefined;
  },
) {
  const raw = baseCellAsText(cell);
  if (col.kind === "select") {
    const opt = findSelectOption(col, raw);
    const look = optionToneLook(opt?.color);
    if (!raw) return <Text class="truncate text-2xs text-faint">—</Text>;
    return (
      <View
        class={`h-5 max-w-full flex-row items-center self-start rounded-sm px-1.5 ${look.bgClass}`}
        style={look.mixToken !== undefined ? { backgroundColor: mix(look.mixToken ?? "water", 0.14) } : undefined}
      >
        <Text class={`truncate text-2xs font-medium ${look.textClass}`}>{opt?.label ?? raw}</Text>
      </View>
    );
  }
  if (col.kind === "multiSelect") {
    const items = baseCellAsStrings(cell).map((val) => findSelectOption(col, val)?.label ?? val);
    return <Text class="truncate text-2xs text-ink">{items.join(", ") || "—"}</Text>;
  }
  if (col.kind === "checkbox") {
    const checked = cell?._tag === "bool" && cell.value;
    return <Icon name={checked ? "ticked" : "minus"} size={12} tone={checked ? "ok-ink" : "faint"} />;
  }
  if (col.kind === "issueRef" && cell?._tag === "issueRef" && cell.issueId !== "") {
    const iss = resolveIssueRef(ctx.issues, cell.issueId);
    return (
      <View
        role="button"
        onPress={() => ctx.onOpenIssue?.(iss?.id ?? cell.issueId)}
        class="h-5 max-w-full flex-row items-center gap-1 self-start rounded-sm bg-side px-1.5 hover:bg-hover"
      >
        <Icon name="issues" size={10} tone="accent" />
        <Text class="truncate font-mono text-2xs font-medium text-ink">{iss ? `#${iss.number}` : cell.issueId}</Text>
      </View>
    );
  }
  if (col.kind === "agentAction") {
    const spawnedId = cell?._tag === "agentRun" ? cell.spawnedIssueId : undefined;
    const summary = cell?._tag === "agentRun" ? cell.summary : undefined;
    const isRunning = ctx.runningKey === `${col.id}:${row.id}`;
    if (spawnedId !== undefined && spawnedId !== "") {
      const iss = resolveIssueRef(ctx.issues, spawnedId);
      return (
        <View
          role="button"
          onPress={() => ctx.onOpenIssue?.(iss?.id ?? spawnedId)}
          class="h-5 max-w-full flex-row items-center gap-1 self-start rounded-sm bg-ok-soft px-1.5 hover:opacity-85"
        >
          <Icon name="issues" size={10} tone="ok-ink" />
          <Text class="truncate font-mono text-2xs font-medium text-ok-ink">{iss ? `#${iss.number}` : spawnedId}</Text>
        </View>
      );
    }
    return (
      <View class="flex-row items-center gap-1">
        <If when={ctx.onRunAgentRow !== undefined}>
          <Button
            size="compact"
            tone="quiet"
            icon="play"
            disabled={isRunning}
            testID={`doc-base-embed-agent-${row.id}-${col.id}`}
            onPress={() => ctx.onRunAgentRow?.(col.id, row.id)}
          >
            {isRunning ? t("web.note.base.runningAgentColumn") : t("web.note.base.runAgentColumn")}
          </Button>
        </If>
        <If when={summary !== undefined && summary !== ""}>
          <Text class="min-w-0 flex-1 truncate text-2xs text-muted">{summary}</Text>
        </If>
      </View>
    );
  }
  if (col.kind === "noteRef" && cell?._tag === "noteRef") {
    const found = ctx.notes.find((n) => n.id === cell.noteId);
    return <Text class="truncate text-2xs text-ink">{found?.title ?? (raw || "—")}</Text>;
  }
  return <Text class="truncate text-2xs text-ink">{raw || "—"}</Text>;
}

export function BaseEmbedBlockView(props: {
  readonly block: BaseEmbedBlockData;
  readonly notes: readonly Note[];
  readonly issues?: readonly Issue[] | undefined;
  readonly highlightedRowId?: string | undefined;
  readonly annotationByRowId?: ReadonlyMap<string, DocAnnotationRef> | undefined;
  readonly annotationById?: ReadonlyMap<string, DocAnnotationRef> | undefined;
  readonly onUpdate: (next: BaseEmbedBlockData) => void;
  readonly onOpenNote: (id: NoteId) => void;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
  readonly onSelectReviewRow?: ((rowId: string, ref?: DocAnnotationRef) => void) | undefined;
}) {
  const queries = useQueryClient();
  const baseNotes = computed(() => props.notes.filter((n) => n.noteType === "base"));
  const target = computed(() => props.notes.find((n) => n.id === props.block.noteId));
  const liveSnap = useQuery(
    () =>
      noteBaseQuery({
        id: props.block.noteId,
        ...(props.block.sheetId !== undefined ? { sheetId: props.block.sheetId } : {}),
        ...(props.block.viewId !== undefined ? { viewId: props.block.viewId } : {}),
      }),
    {
      enabled: () => props.block.noteId !== "",
    },
  );
  const editing = signal(false);
  const runningKey = signal<string | undefined>(undefined);
  const snapData = computed(() => ready(liveSnap, undefined));

  const linkedRefOfRow = (row: BaseRow): DocAnnotationRef | undefined => {
    if (row.annotationRef !== undefined) {
      const direct = props.annotationById?.get(row.annotationRef.annotationId);
      if (direct !== undefined) return direct;
    }
    return props.annotationByRowId?.get(row.id);
  };

  const runAgentRow = (columnId: string, rowId: string) => {
    const snap = untracked(snapData);
    const key = `${columnId}:${rowId}`;
    runningKey.set(key);
    void api.note.base
      .runAgentColumn({
        id: props.block.noteId,
        ...(snap?.activeSheetId ? { sheetId: snap.activeSheetId } : {}),
        columnId,
        rowIds: [rowId],
        origin: "user",
      })
      .then((res) => {
        toast(t("web.note.base.agentRanToast", { n: res.executed }));
        void queries.invalidate({ prefix: ["note-base", props.block.noteId] });
      })
      .catch((e) => toast(reasonOf(e), "bad"))
      .finally(() => {
        if (untracked(runningKey) === key) runningKey.set(undefined);
      });
  };

  return (
    <View testID={`doc-base-embed-${props.block.id}`} class="gap-1.5 py-1">
      <View class="flex-row items-center justify-between gap-2">
        <View
          role="button"
          testID={`doc-base-embed-open-${props.block.id}`}
          onPress={() => {
            if (props.block.noteId !== "") props.onOpenNote(props.block.noteId);
          }}
          class="min-w-0 flex-1 flex-row items-center gap-2 rounded-sm hover:opacity-80"
        >
          <Icon name="catalog" size={14} tone="accent" />
          <Text class="truncate text-xs font-semibold text-ink">
            {target()?.title ?? (props.block.noteId !== "" ? props.block.noteId : t("web.note.doc.selectBase"))}
          </Text>
        </View>
        <View class={editing() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}>
          <IconButton icon={editing() ? "check" : "edit"} size={14} label={t("web.note.doc.pickBase")} onClick={() => editing.set(!editing())} />
        </View>
      </View>
      <If when={editing()}>
        <View class="gap-1 rounded-md border border-line bg-page p-2">
          <Each of={baseNotes()} key={(n) => n.id}>
            {(n) => (
              <View
                role="button"
                onPress={() => {
                  props.onUpdate({ ...props.block, noteId: n().id });
                  editing.set(false);
                }}
                class="flex-row items-center justify-between rounded-sm px-2 py-1 hover:bg-hover"
              >
                <Text class="truncate text-xs text-ink">{n().title}</Text>
                <If when={n().id === props.block.noteId}>
                  <Icon name="check" size={12} tone="accent" />
                </If>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If
        when={snapData()}
        else={
          <If when={target()?.preview?._tag === "base" ? target()?.preview : undefined}>
            {(preview) => {
              const basePreview = () => {
                const p = preview();
                return p._tag === "base" ? p : undefined;
              };
              return (
                <If when={basePreview()}>
                  {(bp) => (
                    <View class="overflow-hidden rounded-md border border-line bg-page">
                      <View class="flex-row border-b border-line bg-side px-2.5 py-1.5">
                        <Each of={bp().columns.slice(0, 5)} key={(col) => col}>
                          {(col) => <Text class="min-w-0 flex-1 truncate text-2xs font-semibold text-muted">{col()}</Text>}
                        </Each>
                      </View>
                      <Each of={bp().rows.slice(0, 6)} key={(_, idx) => String(idx)}>
                        {(row) => (
                          <View class="flex-row border-t border-line px-2.5 py-1.5">
                            <Each of={row().slice(0, 5)} key={(_, cIdx) => String(cIdx)}>
                              {(cell) => <Text class="min-w-0 flex-1 truncate text-2xs text-ink">{cell() || "—"}</Text>}
                            </Each>
                          </View>
                        )}
                      </Each>
                    </View>
                  )}
                </If>
              );
            }}
          </If>
        }
      >
        {(snap) => {
          const visibleCols = () =>
            snap()
              .columns.filter((c) => c.kind !== "media")
              .slice(0, 5);
          const hasAnyLinkedPin = () => snap().rows.some((r) => linkedRefOfRow(r) !== undefined);
          return (
            <View class="overflow-hidden rounded-md border border-line bg-page">
              <View class="flex-row items-center gap-2 border-b border-line bg-side px-2.5 py-1.5">
                <If when={hasAnyLinkedPin()}>
                  <View class="w-16 shrink-0">
                    <Text class="font-mono text-2xs font-semibold text-faint">#</Text>
                  </View>
                </If>
                <Each of={visibleCols()} key={(col) => col.id}>
                  {(col) => <Text class="min-w-0 flex-1 truncate text-2xs font-semibold text-muted">{col().name}</Text>}
                </Each>
              </View>
              <Each of={snap().rows.slice(0, 6)} key={(row) => row.id}>
                {(row) => {
                  const linked = () => linkedRefOfRow(row());
                  const isHighlighted = () => props.highlightedRowId === row().id;
                  const pinVisual = () => {
                    const ref = linked();
                    return ref ? severityVisualOf(ref.annotation.severity) : undefined;
                  };
                  const pinResolved = () => linked()?.annotation.status === "resolved";
                  return (
                    <View
                      role="button"
                      testID={`doc-base-embed-row-${props.block.id}-${row().id}`}
                      accessibilityState={{ selected: isHighlighted() }}
                      onPress={() => props.onSelectReviewRow?.(row().id, linked())}
                      class={`relative flex-row items-center gap-2 border-t border-line px-2.5 py-1.5 ${isHighlighted() ? "bg-selected" : "hover:bg-hover"}`}
                    >
                      <If when={isHighlighted()}>
                        <View class="pointer-events-none absolute top-0 bottom-0 left-0 w-0.5 bg-focus" />
                      </If>
                      <VdpAnchor
                        testId={`doc-base-embed-row-${props.block.id}-${row().id}`}
                        role="button"
                        onPress={() => props.onSelectReviewRow?.(row().id, linked())}
                      />
                      <If when={hasAnyLinkedPin()}>
                        <View class="w-16 shrink-0 flex-row items-center">
                          <If when={linked()} else={<Text class="font-mono text-2xs text-faint">—</Text>}>
                            {(ref) => (
                              <View
                                testID={`doc-base-embed-pin-${row().id}`}
                                class={`h-5 flex-row items-center gap-1 rounded-full px-1.5 ${
                                  pinResolved() ? "bg-leaf" : (pinVisual()?.badgeBgClass ?? "bg-accent")
                                }`}
                              >
                                <Text
                                  class={`font-mono text-2xs font-bold tabular-nums ${
                                    pinResolved() ? "text-paper" : (pinVisual()?.badgeTextClass ?? "text-paper")
                                  }`}
                                >
                                  {t("web.note.annotation.jumpToPin", { n: ref().annotation.number })}
                                </Text>
                              </View>
                            )}
                          </If>
                        </View>
                      </If>
                      <Each of={visibleCols()} key={(col) => col.id}>
                        {(col) => (
                          <View class="min-w-0 flex-1">
                            {renderBaseEmbedCell(col(), row().cells[col().id], row(), {
                              notes: props.notes,
                              issues: props.issues ?? [],
                              runningKey: runningKey(),
                              onOpenIssue: props.onOpenIssue,
                              onRunAgentRow: runAgentRow,
                            })}
                          </View>
                        )}
                      </Each>
                    </View>
                  );
                }}
              </Each>
            </View>
          );
        }}
      </If>
    </View>
  );
}

export function IssueCardBlockView(props: {
  readonly block: IssueCardBlockData;
  readonly issues: readonly Issue[];
  readonly onUpdate: (next: IssueCardBlockData) => void;
  readonly onOpenIssue: (id: IssueId) => void;
}) {
  const resolved = computed(() => resolveIssueRef(props.issues, props.block.issueId));
  const picking = signal(false);

  return (
    <View testID={`doc-issue-card-${props.block.id}`} class="gap-1.5 py-0.5">
      <View class="flex-row items-center justify-between gap-2 rounded-md border border-line bg-page px-3 py-2 hover:border-faint">
        <If
          when={resolved()}
          else={
            <View role="button" onPress={() => picking.set(!picking())} class="min-w-0 flex-1 flex-row items-center gap-2">
              <Icon name="issues" size={14} tone="muted" />
              <Text class="truncate text-xs text-muted">{props.block.issueId !== "" ? `#${props.block.issueId}` : t("web.note.doc.selectIssue")}</Text>
            </View>
          }
        >
          {(issue) => (
            <View
              role="button"
              testID={`doc-issue-card-open-${issue().id}`}
              onPress={() => props.onOpenIssue(issue().id)}
              class="min-w-0 flex-1 flex-row items-center gap-2 rounded-sm hover:opacity-80"
            >
              <Dot tone={ISSUE_STATUS_DOT_TONE[issue().status]} size={9} ring={false} />
              <Text class="shrink-0 font-mono text-xs text-muted tabular-nums">{`#${issue().number}`}</Text>
              <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{issue().title}</Text>
              <View class="shrink-0 rounded-sm bg-side px-1.5 py-0.5">
                <Text class="text-2xs font-medium text-muted">{statusLabel(issue().status)}</Text>
              </View>
            </View>
          )}
        </If>
        <View class={picking() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}>
          <IconButton icon="edit" size={14} label={t("web.note.doc.pickIssue")} onClick={() => picking.set(!picking())} />
        </View>
      </View>
      <If when={picking()}>
        <View class="max-h-40 gap-0.5 rounded-md border border-line bg-page p-1.5">
          <Each of={props.issues.slice(0, 12)} key={(iss) => iss.id}>
            {(iss) => (
              <View
                role="button"
                onPress={() => {
                  props.onUpdate({ ...props.block, issueId: iss().id });
                  picking.set(false);
                }}
                class="flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-hover"
              >
                <Dot tone={ISSUE_STATUS_DOT_TONE[iss().status]} size={8} ring={false} />
                <Text class="font-mono text-2xs text-muted">{`#${iss().number}`}</Text>
                <Text class="min-w-0 flex-1 truncate text-xs text-ink">{iss().title}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

export function IssueListBlockView(props: {
  readonly block: IssueListBlockData;
  readonly issues: readonly Issue[];
  readonly onUpdate: (next: IssueListBlockData) => void;
  readonly onOpenIssue: (id: IssueId) => void;
}) {
  const editing = signal(false);
  const matched = computed(() =>
    filterIssuesForList(props.issues, {
      repo: props.block.repo,
      status: props.block.status,
      tag: props.block.tag,
      limit: props.block.limit,
    }),
  );

  return (
    <View testID={`doc-issue-list-${props.block.id}`} class="gap-1.5 py-1">
      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-row items-center gap-1.5">
          <Icon name="issues" size={14} tone="muted" />
          <Text class="text-xs font-semibold text-ink">{t("web.note.doc.issuesTitle", { n: matched().length })}</Text>
          <If when={props.block.repo}>{(r) => <Text class="font-mono text-2xs text-faint">{r()}</Text>}</If>
          <If when={props.block.status}>{(s) => <Text class="font-mono text-2xs text-faint">{s()}</Text>}</If>
          <If when={props.block.tag}>{(tg) => <Text class="font-mono text-2xs text-faint">{`#${tg()}`}</Text>}</If>
        </View>
        <View class={editing() ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}>
          <IconButton icon={editing() ? "check" : "filter"} size={14} label={t("web.note.doc.filterIssues")} onClick={() => editing.set(!editing())} />
        </View>
      </View>
      <If when={editing()}>
        <View class="flex-row gap-2 rounded-md border border-line bg-page p-2">
          <TextInput
            wide={false}
            class="flex-1"
            value={props.block.repo ?? ""}
            placeholder={t("web.note.doc.repoFilter")}
            onInput={(v) => props.onUpdate({ ...props.block, repo: v || undefined })}
          />
          <TextInput
            wide={false}
            class="flex-1"
            value={props.block.status ?? ""}
            placeholder={t("web.note.doc.statusFilter")}
            onInput={(v) => props.onUpdate({ ...props.block, status: v || undefined })}
          />
          <TextInput
            wide={false}
            class="flex-1"
            value={props.block.tag ?? ""}
            placeholder={t("web.note.doc.tagFilter")}
            onInput={(v) => props.onUpdate({ ...props.block, tag: v || undefined })}
          />
        </View>
      </If>
      <If when={matched().length > 0} else={<Text class="text-xs text-faint">{t("web.base.table.empty")}</Text>}>
        <View class="overflow-hidden rounded-md border border-line bg-page">
          <Each of={matched()} key={(iss) => iss.id}>
            {(iss) => (
              <View
                role="button"
                testID={`doc-issue-list-row-${iss().id}`}
                onPress={() => props.onOpenIssue(iss().id)}
                class="flex-row items-center gap-2 border-b border-line px-2.5 py-1.5 last:border-b-0 hover:bg-hover"
              >
                <Dot tone={ISSUE_STATUS_DOT_TONE[iss().status]} size={8} ring={false} />
                <Text class="shrink-0 font-mono text-2xs text-muted tabular-nums">{`#${iss().number}`}</Text>
                <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{iss().title}</Text>
                <Text class="shrink-0 text-2xs text-faint">{statusLabel(iss().status)}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
