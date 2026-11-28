import { colorScheme, computed, Image, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Issue, Note, NoteCover, NotePreview as NotePreviewData } from "@vibevalley/protocol";

import { Icon } from "../../design/Icon";
import { mix } from "../../design/tone";
import { fileUrl } from "../../infra/attachmentFile";
import { noteIcon } from "../note";

type PreviewByTag<Tag extends NotePreviewData["_tag"]> = Extract<NotePreviewData, { readonly _tag: Tag }>;

export interface PreviewTextContext {
  readonly notesById?: ReadonlyMap<string, Pick<Note, "title">> | undefined;
  readonly issuesById?: ReadonlyMap<string, Pick<Issue, "number" | "title">> | undefined;
}

const DATA_URI_RE = /^\s*data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/iu;

function resolveIssueLabel(rawId: string, ctx?: PreviewTextContext): string {
  const trimmed = rawId.trim();
  const found = ctx?.issuesById?.get(trimmed);
  if (found !== undefined) return `#${found.number}`;
  const numMatch = /^i(\d+)$/iu.exec(trimmed) ?? /^#?(\d+)$/u.exec(trimmed);
  if (numMatch?.[1] !== undefined) return `#${numMatch[1]}`;
  return `#${trimmed}`;
}

function resolveNoteLabel(rawId: string, ctx?: PreviewTextContext): string {
  const trimmed = rawId.trim();
  const found = ctx?.notesById?.get(trimmed);
  if (found?.title) return found.title;
  if (/^(?:note_|art-|n-)/iu.test(trimmed)) return t("web.note.types.doc");
  return trimmed;
}

/** Strips raw Markdown syntax and resolves/cleans wikilinks for card preview snippets. */
export function cleanPreviewText(raw: string, ctx?: PreviewTextContext): string {
  if (!raw || DATA_URI_RE.test(raw)) return "";
  return raw
    .replace(/!?\[\[note:([^|\]]+)\|([^\]]+)\]\]/gu, (_, _id: string, label: string) => label.trim())
    .replace(/!?\[\[note:([^\]]+)\]\]/gu, (_, id: string) => resolveNoteLabel(id, ctx))
    .replace(/!?\[\[issue:([^|\]]+)\|([^\]]+)\]\]/gu, (_, _id: string, label: string) => label.trim())
    .replace(/!?\[\[issue:([^\]]+)\]\]/gu, (_, id: string) => resolveIssueLabel(id, ctx))
    .replace(/!?\[\[([^|\]]+)\|([^\]]+)\]\]/gu, (_, _target: string, label: string) => label.trim())
    .replace(/!?\[\[([^\]]+)\]\]/gu, (_, target: string) => target.trim())
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, (_, alt: string) => alt.trim())
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, (_, label: string) => label.trim())
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/gu, "$1$2")
    .replace(/(^|[^\w_])_([^_\s][^_]*?)_(?!\w)/gu, "$1$2")
    .replace(/\*\*|__|`/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function localizedMediaKind(kind: string): string {
  switch (kind.toLowerCase()) {
    case "image":
      return t("web.library.kind.image");
    case "audio":
      return t("web.library.kind.audio");
    case "video":
      return t("web.library.kind.video");
    default:
      return t("web.library.kind.other");
  }
}

function coverImageSrc(cover: NoteCover | undefined): string | undefined {
  if (cover === undefined) return undefined;
  if (cover.path !== "") return fileUrl(cover.path);
  return cover.url !== "" ? cover.url : undefined;
}

function frameImageSrc(framePath: string | undefined): string | undefined {
  return framePath !== undefined && framePath !== "" ? fileUrl(framePath) : undefined;
}

function CoverImage(props: { readonly testID: string; readonly src: string; readonly width: number; readonly height: number }) {
  const isDark = () => colorScheme() === "dark";
  return (
    <View class="relative overflow-hidden" style={{ width: props.width, height: props.height }}>
      <Image testID={props.testID} src={props.src} style={{ width: props.width, height: props.height, objectFit: "cover" }} />
      <If when={isDark()}>
        <View testID={`${props.testID}-scrim`} class="pointer-events-none absolute inset-0 border border-line" style={{ backgroundColor: mix("page", 0.14) }} />
      </If>
    </View>
  );
}

function DocPreview(props: { readonly data: PreviewByTag<"doc">; readonly noteTitle: string; readonly ctx?: PreviewTextContext | undefined }) {
  const cleanedHeading = computed(() => {
    const cleaned = cleanPreviewText(props.data.heading ?? "", props.ctx);
    if (!cleaned || sameTitle(cleaned, props.noteTitle)) return "";
    return cleaned;
  });
  const cleanedExcerpt = computed(() => {
    const cleaned = cleanPreviewText(props.data.excerpt, props.ctx);
    if (!cleaned || sameTitle(cleaned, props.noteTitle)) return "";
    return cleaned;
  });
  const hasHeading = () => cleanedHeading() !== "";
  const hasExcerpt = () => cleanedExcerpt() !== "";
  const outlineRows = computed(() =>
    props.data.outline
      .map((item) => ({ ...item, text: cleanPreviewText(item.text, props.ctx) }))
      .filter((item) => item.text !== "" && !sameTitle(item.text, props.noteTitle))
      .slice(0, 4),
  );
  const countsText = computed(() => {
    const parts: string[] = [];
    if (props.data.blockCount > 0) parts.push(t("web.note.preview.blocks", { n: props.data.blockCount }));
    if (props.data.slideCount > 1) parts.push(t("web.note.preview.slides", { n: props.data.slideCount }));
    return parts.join(" · ");
  });
  return (
    <View class="flex-1 overflow-hidden px-3 pt-3">
      <View class="flex-1 justify-between gap-1.5 overflow-hidden rounded-t-md border border-b-0 border-line bg-page px-3 pt-2.5 pb-2">
        <View class="gap-1 overflow-hidden">
          <If when={hasHeading()}>
            <Text class="truncate text-xs font-semibold text-ink">{cleanedHeading()}</Text>
          </If>
          <If
            when={hasExcerpt()}
            else={
              <If
                when={outlineRows().length > 0}
                else={
                  <If when={!hasHeading()}>
                    <Text class="pt-0.5 text-2xs text-faint">{t("web.note.blocks.start")}</Text>
                  </If>
                }
              >
                <View class="gap-1 pt-0.5">
                  <Each of={outlineRows()} key="index">
                    {(item) => {
                      const padLeft = () => Math.min(3, Math.max(0, item().depth)) * 8;
                      return (
                        <View class="flex-row items-center gap-1.5" style={{ paddingLeft: padLeft() }}>
                          <View class={`size-1.5 shrink-0 rounded-full ${item().checked === true ? "bg-accent" : "bg-faint"}`} />
                          <Text class="min-w-0 flex-1 truncate text-2xs text-muted">{item().text}</Text>
                        </View>
                      );
                    }}
                  </Each>
                </View>
              </If>
            }
          >
            <Text class={`text-2xs leading-relaxed text-muted ${hasHeading() ? "line-clamp-4" : "line-clamp-5"}`}>{cleanedExcerpt()}</Text>
          </If>
        </View>
        <If when={countsText() !== ""}>
          <Text class="shrink-0 text-right font-mono text-2xs text-faint tabular-nums">{countsText()}</Text>
        </If>
      </View>
    </View>
  );
}

function BasePreview(props: { readonly data: PreviewByTag<"base">; readonly noteTitle: string; readonly ctx?: PreviewTextContext | undefined }) {
  const cols = computed(() => props.data.columns.slice(0, 4));
  const rows = computed(() => props.data.rows.slice(0, 5));
  const hasCounts = () => props.data.totalRows > 0 || props.data.totalCols > 0;
  const sheetLabel = computed(() => {
    const cleaned = cleanPreviewText(props.data.sheetName ?? "", props.ctx);
    return cleaned && !sameTitle(cleaned, props.noteTitle) ? cleaned : "";
  });
  return (
    <View class="flex-1 justify-between gap-1.5 overflow-hidden p-2.5">
      <View class="shrink overflow-hidden rounded-sm border border-line bg-page">
        <If when={cols().length > 0}>
          <View class="flex-row border-b border-line bg-side">
            <Each of={cols()} key="index">
              {(col, idx) => (
                <View class={`min-w-0 flex-1 px-2 py-1.5 ${idx() < cols().length - 1 ? "border-r border-line" : ""}`}>
                  <Text class="truncate font-mono text-2xs font-semibold text-muted">{col()}</Text>
                </View>
              )}
            </Each>
          </View>
        </If>
        <Each of={rows()} key="index">
          {(row, rIdx) => {
            const cells = computed(() => {
              const count = Math.max(cols().length, Math.min(4, row().length));
              return row()
                .slice(0, count)
                .map((cell) => cleanPreviewText(cell, props.ctx));
            });
            return (
              <View class={`flex-row ${rIdx() < rows().length - 1 ? "border-b border-line" : ""}`}>
                <Each of={cells()} key="index">
                  {(cell, cIdx) => (
                    <View class={`min-w-0 flex-1 px-2 py-1.5 ${cIdx() < cells().length - 1 ? "border-r border-line" : ""}`}>
                      <Text class="truncate text-2xs text-ink tabular-nums">{cell()}</Text>
                    </View>
                  )}
                </Each>
              </View>
            );
          }}
        </Each>
      </View>
      <If when={hasCounts() || sheetLabel() !== ""}>
        <View class="shrink-0 flex-row items-center justify-between gap-2 px-0.5">
          <Text class="min-w-0 flex-1 truncate text-2xs text-muted">{sheetLabel()}</Text>
          <If when={hasCounts()}>
            <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{`${props.data.totalRows}×${props.data.totalCols}`}</Text>
          </If>
        </View>
      </If>
    </View>
  );
}

function CanvasPreview(props: {
  readonly data: PreviewByTag<"canvas">;
  readonly width: number;
  readonly height: number;
  readonly ctx?: PreviewTextContext | undefined;
}) {
  const shapes = computed(() => props.data.shapes.slice(0, 24));
  const innerW = computed(() => Math.max(40, props.width - 24));
  const innerH = computed(() => Math.max(30, props.height - 24));
  const bounds = computed(() => {
    let maxX = 1;
    let maxY = 1;
    for (const s of shapes()) {
      maxX = Math.max(maxX, s.x + s.w);
      maxY = Math.max(maxY, s.y + s.h);
    }
    return { maxX, maxY };
  });
  return (
    <View class="relative flex-1 overflow-hidden p-3">
      <View class="relative flex-1">
        <Each of={shapes()} key="index">
          {(shape) => {
            const left = () => {
              const norm = shape().x <= 1 && bounds().maxX <= 1.2 ? shape().x : shape().x / bounds().maxX;
              return Math.round(Math.min(0.92, Math.max(0, norm)) * innerW());
            };
            const top = () => {
              const norm = shape().y <= 1 && bounds().maxY <= 1.2 ? shape().y : shape().y / bounds().maxY;
              return Math.round(Math.min(0.88, Math.max(0, norm)) * innerH());
            };
            const w = () => {
              const norm = shape().w <= 1 && bounds().maxX <= 1.2 ? shape().w : shape().w / bounds().maxX;
              return Math.max(14, Math.min(innerW() - left(), Math.round(Math.max(0.08, norm) * innerW())));
            };
            const h = () => {
              const norm = shape().h <= 1 && bounds().maxY <= 1.2 ? shape().h : shape().h / bounds().maxY;
              return Math.max(10, Math.min(innerH() - top(), Math.round(Math.max(0.08, norm) * innerH())));
            };
            const kind = () => shape().kind;
            const boxClass = () => {
              if (kind() === "sticky") return "rounded-xs border border-line bg-warn-soft";
              if (kind() === "container") return "rounded-sm border border-dashed border-line-strong";
              if (kind() === "text") return "rounded-xs bg-hover";
              return "rounded-xs border border-line bg-page";
            };
            const label = () => cleanPreviewText(shape().label ?? "", props.ctx);
            const showLabel = () => label() !== "" && w() >= 44 && h() >= 16;
            return (
              <View
                class={`absolute overflow-hidden ${kind() === "container" ? "justify-start pt-0.5" : "justify-center"} ${boxClass()}`}
                style={{ left: left(), top: top(), width: w(), height: h() }}
              >
                <If when={showLabel()}>
                  <Text class="truncate px-1 text-2xs text-muted">{label()}</Text>
                </If>
              </View>
            );
          }}
        </Each>
      </View>
      <If when={props.data.nodeCount > 0}>
        <View class="absolute right-2.5 bottom-1.5 rounded-xs bg-side px-1">
          <Text class="font-mono text-2xs text-faint tabular-nums">{t("web.note.whiteboard.elements", { n: props.data.nodeCount })}</Text>
        </View>
      </If>
    </View>
  );
}

function MediaPreview(props: {
  readonly data: PreviewByTag<"media">;
  readonly noteTitle: string;
  readonly width: number;
  readonly height: number;
  readonly id: string;
  readonly ctx?: PreviewTextContext | undefined;
}) {
  const imgSrc = computed(() => frameImageSrc(props.data.framePath));
  const glyph = () => (props.data.mediaKind === "video" ? "video" : props.data.mediaKind === "image" ? "image" : "audio");
  const caption = computed(() => {
    const cleaned = cleanPreviewText(props.data.caption ?? "", props.ctx);
    return cleaned && !sameTitle(cleaned, props.noteTitle) ? cleaned : "";
  });
  return (
    <If
      when={imgSrc()}
      else={
        <View class="flex-1 justify-between gap-2 overflow-hidden p-3">
          <View class="flex-1 items-center justify-center gap-1.5 rounded-sm border border-line bg-page px-3 py-2">
            <Icon name={glyph()} size={16} tone="muted" />
            <If when={caption() !== ""}>
              <Text class="line-clamp-2 text-center text-2xs leading-relaxed text-muted">{caption()}</Text>
            </If>
          </View>
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-2xs text-faint">{localizedMediaKind(props.data.mediaKind)}</Text>
            <If when={props.data.durationSec !== undefined && props.data.durationSec > 0}>
              <Text class="font-mono text-2xs text-faint tabular-nums">{`${(props.data.durationSec ?? 0).toFixed(1)}s`}</Text>
            </If>
          </View>
        </View>
      }
    >
      {(src) => <CoverImage testID={`library-note-frame-${props.id}`} src={src()} width={props.width} height={props.height} />}
    </If>
  );
}

function StructuredPreview(props: {
  readonly preview: NotePreviewData;
  readonly note: Note;
  readonly width: number;
  readonly height: number;
  readonly ctx?: PreviewTextContext | undefined;
}) {
  return (
    <View testID={`library-note-preview-${props.note.id}`} class="flex-1 overflow-hidden">
      <If when={props.preview._tag === "doc" ? props.preview : undefined}>{(d) => <DocPreview data={d()} noteTitle={props.note.title} ctx={props.ctx} />}</If>
      <If when={props.preview._tag === "base" ? props.preview : undefined}>{(d) => <BasePreview data={d()} noteTitle={props.note.title} ctx={props.ctx} />}</If>
      <If when={props.preview._tag === "canvas" ? props.preview : undefined}>
        {(d) => <CanvasPreview data={d()} width={props.width} height={props.height} ctx={props.ctx} />}
      </If>
      <If when={props.preview._tag === "media" ? props.preview : undefined}>
        {(d) => <MediaPreview data={d()} noteTitle={props.note.title} width={props.width} height={props.height} id={props.note.id} ctx={props.ctx} />}
      </If>
    </View>
  );
}

export function NotePreview(props: {
  readonly note: Note;
  readonly width: number;
  readonly height: number;
  readonly notesById?: ReadonlyMap<string, Pick<Note, "title">> | undefined;
  readonly issuesById?: ReadonlyMap<string, Pick<Issue, "number" | "title">> | undefined;
}) {
  const coverSrc = computed(() => coverImageSrc(props.note.cover));
  const ctx = computed((): PreviewTextContext => ({ notesById: props.notesById, issuesById: props.issuesById }));
  return (
    <If
      when={coverSrc()}
      else={
        <If
          when={props.note.preview}
          else={
            <View testID={`library-note-preview-${props.note.id}`} class="flex-1 items-center justify-center">
              <Icon name={noteIcon(props.note)} size={20} tone="faint" />
            </View>
          }
        >
          {(preview) => <StructuredPreview preview={preview()} note={props.note} width={props.width} height={props.height} ctx={ctx()} />}
        </If>
      }
    >
      {(src) => <CoverImage testID={`library-note-cover-${props.note.id}`} src={src()} width={props.width} height={props.height} />}
    </If>
  );
}
