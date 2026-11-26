// Declarative Markdown wrapper backed by native Rust `vibevalley/rich` (`VvMarkdown`),
// with a stock `nsh/base` `TextView` fallback when running headless under `nsh test`.
// Issue numbers (#12), @mentions, Shiki code blocks, Mermaid diagrams,
// JSON Canvas, SVG Charts, reactive GenUI, and LaTeX math are all handled natively in Rust.
import { cleanup, Clipboard, computed, Image, signal, Text, untracked, View } from "nsh";
import { TextView, type TextViewImage } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { fileUrl, openAttachment, useAttachmentFile } from "../infra/attachmentFile";
import {
  formatGenUiAction,
  richNative,
  type VvCodeCopyEvent,
  type VvDiagramPressEvent,
  type VvGenUiActionEvent,
  type VvIssuePressEvent,
  type VvMentionPressEvent,
  type VvTaskPressEvent,
} from "../infra/rich";
import { createEffect } from "../infra/solid";
import { Canvas } from "./code/Canvas";
import { Chart } from "./code/Chart";
import { CodeBlock } from "./code/CodeBlock";
import { Diagram } from "./code/Diagram";
import { GenUi } from "./code/GenUi";
import { Compare } from "./Compare";
import { splitMarkdownCompareBlocks, type CompareSpec } from "./compareModel";
import { fileKind, kindIcon } from "./domain/AttachmentTile";
import { followDesignHref, useDesignHost } from "./host";
import { Icon } from "./Icon";
import { Lightbox, type Picture } from "./Lightbox";
import { RichPreviewModal, type RichPreviewPayload } from "./RichPreviewModal";

const ATTACHMENT_PATH_RE = /^(?:https?:\/\/[^/?#]+)?\/api\/v1\/attachment\/([^/?#\s]+)(?:[?#][^\s]*)?$/iu;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/u;
const HTML_IMG_RE = /^<img\b([^>]*?)>/iu;

interface MarkdownAttachmentImageSpec {
  readonly key: string;
  readonly id: string;
  readonly alt: string;
  readonly rawUrl: string;
}

type MarkdownSegment =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "compare"; readonly raw: string; readonly spec: CompareSpec }
  | { readonly kind: "images"; readonly items: readonly MarkdownAttachmentImageSpec[] };

/** Extracts a VibeValley attachment id from `/api/v1/attachment/<id>` or `http(s)://.../api/v1/attachment/<id>`. */
function extractAttachmentId(rawUrl: string): string | undefined {
  let trimmed = rawUrl.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.length >= 2) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const match = ATTACHMENT_PATH_RE.exec(trimmed);
  if (!match) return undefined;
  const rawId = match[1] ?? "";
  if (rawId === "") return undefined;
  try {
    const decoded = decodeURIComponent(rawId).trim();
    return decoded === "" ? undefined : decoded;
  } catch {
    return rawId;
  }
}

function isClosingFence(line: string, markerChar: string, minLength: number): boolean {
  const trimmed = line.replace(/^[ \t]{0,3}/u, "").replace(/[ \t]+$/u, "");
  if (trimmed.length < minLength) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== markerChar) return false;
  }
  return true;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findInlineCodeEnd(line: string, start: number): { tickLen: number; end: number } | undefined {
  let tickLen = 0;
  while (start + tickLen < line.length && line[start + tickLen] === "`") {
    tickLen += 1;
  }
  if (tickLen === 0) return undefined;
  let pos = start + tickLen;
  while (pos < line.length) {
    if (line[pos] === "`") {
      let run = 0;
      while (pos + run < line.length && line[pos + run] === "`") run += 1;
      if (run === tickLen) return { tickLen, end: pos + run };
      pos += run;
      continue;
    }
    pos += 1;
  }
  return undefined;
}

function extractImageDest(inner: string): string | undefined {
  const trimmed = inner.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    return close > 1 ? trimmed.slice(1, close).trim() : undefined;
  }
  const match = /^(\S+)/u.exec(trimmed);
  return match?.[1];
}

function parseMarkdownImageAt(line: string, start: number): { end: number; alt: string; rawUrl: string; attachmentId: string } | undefined {
  if (line[start] !== "!" || line[start + 1] !== "[" || isEscaped(line, start)) return undefined;
  let altEnd = -1;
  for (let i = start + 2; i < line.length; i += 1) {
    if (line[i] === "\\" && i + 1 < line.length) {
      i += 1;
      continue;
    }
    if (line[i] === "[") return undefined;
    if (line[i] === "]") {
      altEnd = i;
      break;
    }
  }
  if (altEnd < 0 || line[altEnd + 1] !== "(") return undefined;

  let depth = 1;
  let quote: string | undefined;
  let closeParen = -1;
  for (let i = altEnd + 2; i < line.length; i += 1) {
    const ch = line[i] ?? "";
    if (ch === "\\" && i + 1 < line.length) {
      i += 1;
      continue;
    }
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  if (closeParen < 0) return undefined;

  const rawUrl = extractImageDest(line.slice(altEnd + 2, closeParen));
  if (rawUrl === undefined) return undefined;
  const attachmentId = extractAttachmentId(rawUrl);
  if (attachmentId === undefined) return undefined;
  const alt = line
    .slice(start + 2, altEnd)
    .replace(/\\([\\[\]()!*_`])/gu, "$1")
    .trim();
  return { end: closeParen + 1, alt, rawUrl, attachmentId };
}

function parseHtmlAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu");
  const match = re.exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}

function parseHtmlAttachmentImageAt(line: string, start: number): { end: number; alt: string; rawUrl: string; attachmentId: string } | undefined {
  if (line[start] !== "<") return undefined;
  const match = HTML_IMG_RE.exec(line.slice(start));
  if (!match) return undefined;
  const attrs = match[1] ?? "";
  const rawUrl = parseHtmlAttr(attrs, "src");
  if (rawUrl === undefined) return undefined;
  const attachmentId = extractAttachmentId(rawUrl);
  if (attachmentId === undefined) return undefined;
  const alt = (parseHtmlAttr(attrs, "alt") ?? "").trim();
  return { end: start + match[0].length, alt, rawUrl, attachmentId };
}

type InlineImagePiece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly id: string; readonly alt: string; readonly rawUrl: string };

function splitLineAttachmentImages(line: string): InlineImagePiece[] {
  const pieces: InlineImagePiece[] = [];
  let cursor = 0;
  let chunkStart = 0;

  const flushText = (end: number) => {
    if (end > chunkStart) {
      pieces.push({ kind: "text", text: line.slice(chunkStart, end) });
    }
  };

  while (cursor < line.length) {
    if (line[cursor] === "`") {
      const codeSpan = findInlineCodeEnd(line, cursor);
      if (codeSpan) {
        cursor = codeSpan.end;
        continue;
      }
      while (cursor < line.length && line[cursor] === "`") cursor += 1;
      continue;
    }

    if (line[cursor] === "!" && line[cursor + 1] === "[") {
      const parsed = parseMarkdownImageAt(line, cursor);
      if (parsed) {
        flushText(cursor);
        pieces.push({ kind: "image", id: parsed.attachmentId, alt: parsed.alt, rawUrl: parsed.rawUrl });
        cursor = parsed.end;
        chunkStart = cursor;
        continue;
      }
    }

    if (line[cursor] === "<") {
      const parsed = parseHtmlAttachmentImageAt(line, cursor);
      if (parsed) {
        flushText(cursor);
        pieces.push({ kind: "image", id: parsed.attachmentId, alt: parsed.alt, rawUrl: parsed.rawUrl });
        cursor = parsed.end;
        chunkStart = cursor;
        continue;
      }
    }

    cursor += 1;
  }

  flushText(line.length);
  return pieces;
}

function appendMarkdownText(out: MarkdownSegment[], text: string): void {
  const normalized = text.replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/gu, "");
  if (normalized.trim() === "") return;
  const last = out.at(-1);
  if (last?.kind === "markdown") {
    out[out.length - 1] = { kind: "markdown", text: `${last.text}\n${normalized}` };
  } else {
    out.push({ kind: "markdown", text: normalized });
  }
}

function splitMarkdownAttachmentImages(text: string, counter: { next: number }): MarkdownSegment[] {
  if (text === "") return [];
  if (!text.includes("/api/v1/attachment/")) return [{ kind: "markdown", text }];

  const lines = text.split(/\r?\n/u);
  const out: MarkdownSegment[] = [];
  let mdLines: string[] = [];
  let fenceChar: string | undefined;
  let fenceLen = 0;

  const flushMarkdownLines = () => {
    if (mdLines.length === 0) return;
    appendMarkdownText(out, mdLines.join("\n"));
    mdLines = [];
  };

  const pushImage = (img: { id: string; alt: string; rawUrl: string }) => {
    const spec: MarkdownAttachmentImageSpec = { key: `img:${counter.next++}`, id: img.id, alt: img.alt, rawUrl: img.rawUrl };
    const last = out.at(-1);
    if (last?.kind === "images") {
      out[out.length - 1] = { kind: "images", items: [...last.items, spec] };
    } else {
      out.push({ kind: "images", items: [spec] });
    }
  };

  for (const line of lines) {
    if (fenceChar === undefined) {
      const open = FENCE_OPEN_RE.exec(line);
      if (open) {
        const marker = open[1] ?? "";
        fenceChar = marker[0];
        fenceLen = marker.length;
        mdLines.push(line);
        continue;
      }
    } else {
      mdLines.push(line);
      if (isClosingFence(line, fenceChar, fenceLen)) {
        fenceChar = undefined;
        fenceLen = 0;
      }
      continue;
    }

    if (!line.includes("/api/v1/attachment/")) {
      mdLines.push(line);
      continue;
    }

    const pieces = splitLineAttachmentImages(line);
    if (!pieces.some((p) => p.kind === "image")) {
      mdLines.push(line);
      continue;
    }

    let lineBuf = "";
    for (const piece of pieces) {
      if (piece.kind === "text") {
        lineBuf += piece.text;
        continue;
      }
      if (lineBuf.trim() !== "") {
        mdLines.push(lineBuf.trimEnd());
      }
      flushMarkdownLines();
      lineBuf = "";
      pushImage(piece);
    }
    if (lineBuf.trim() !== "") {
      mdLines.push(lineBuf.trimStart());
    }
  }

  flushMarkdownLines();
  return out;
}

function splitMarkdownSegments(text: string): MarkdownSegment[] {
  const base = splitMarkdownCompareBlocks(text);
  const counter = { next: 0 };
  const out: MarkdownSegment[] = [];
  for (const seg of base) {
    if (seg.kind === "compare") {
      out.push(seg);
      continue;
    }
    for (const piece of splitMarkdownAttachmentImages(seg.text, counter)) {
      if (piece.kind === "markdown") {
        appendMarkdownText(out, piece.text);
      } else if (piece.kind === "images") {
        const last = out.at(-1);
        if (last?.kind === "images") {
          out[out.length - 1] = { kind: "images", items: [...last.items, ...piece.items] };
        } else {
          out.push(piece);
        }
      }
    }
  }
  return out;
}

/** Returns attachment IDs embedded as inline markdown images outside fenced/inline code blocks. */
export function extractInlineAttachmentIds(text: string): ReadonlySet<string> {
  if (!text.includes("/api/v1/attachment/")) return new Set();
  const ids = new Set<string>();
  for (const seg of splitMarkdownSegments(text)) {
    if (seg.kind !== "images") continue;
    for (const item of seg.items) ids.add(item.id);
  }
  return ids;
}

const fallbackClasses = {
  link: "text-water underline",
  strong: "font-semibold text-ink",
  blockquote: "my-1 border-l-2 border-faint py-0.5 pl-3 text-muted",
  alert: "my-1.5 rounded-md border border-line bg-side px-3 py-1.5",
  code: "rounded-sm border border-line bg-side px-1.5 py-px font-mono text-xs text-ink",
  keyboard: "rounded-xs border border-line bg-side px-1 py-px font-mono text-2xs text-ink",
  heading: "mt-1 mb-0.5 font-semibold text-ink",
  paragraph: "my-1",
  list: "my-0.5 pl-5",
  listItem: "my-0.5 items-start",
  listMarker: "text-muted tabular-nums",
  listItemContent: "min-w-0 flex-1 gap-0",
  taskMarker: "mt-0.5 size-3.5 rounded-xs border border-faint bg-page",
  taskMarkerChecked: "border-accent bg-accent text-page",
  table: "my-2 overflow-hidden rounded-md border border-line",
  tableHead: "bg-side",
  tableRow: "border-b border-line",
  tableCell: "border border-line px-2 py-1 text-ink",
  tableHeaderCell: "bg-side font-semibold text-ink",
  rule: "my-2 border-line",
};

const fallbackHeadings = (size: "base" | "sm" | "doc") => {
  switch (size) {
    case "sm":
      return { heading1: "text-base", heading2: "text-sm", heading3: "text-sm", heading4: "text-sm", heading5: "text-sm", heading6: "text-sm" };
    case "doc":
      return { heading1: "text-2xl", heading2: "text-xl", heading3: "text-base", heading4: "text-sm", heading5: "text-sm", heading6: "text-xs" };
    case "base":
      return { heading1: "text-lg", heading2: "text-base", heading3: "text-sm", heading4: "text-sm", heading5: "text-sm", heading6: "text-sm" };
  }
};

export interface MarkdownProps {
  text: string;
  class?: string | undefined;
  size?: "base" | "sm" | "doc";
  baseDir?: string | null;
  mentions?: boolean;
  streaming?: boolean;
  selectable?: boolean;
  onIssuePress?: (event: VvIssuePressEvent) => void;
  onMentionPress?: (event: VvMentionPressEvent) => void;
  onTaskPress?: (event: VvTaskPressEvent) => void;
  onCodeCopy?: (event: VvCodeCopyEvent) => void;
  onGenUiAction?: (event: VvGenUiActionEvent) => void;
  onDiagramPress?: (event: VvDiagramPressEvent) => void;
}

interface MarkdownChunkProps {
  readonly text: string;
  readonly class?: string | undefined;
  readonly size: "base" | "sm" | "doc";
  readonly baseDir?: string | undefined;
  readonly mentions?: boolean | undefined;
  readonly streaming?: boolean | undefined;
  readonly selectable?: boolean | undefined;
  readonly onIssuePress?: ((event: VvIssuePressEvent) => void) | undefined;
  readonly onMentionPress?: ((event: VvMentionPressEvent) => void) | undefined;
  readonly onTaskPress?: ((event: VvTaskPressEvent) => void) | undefined;
  readonly onCodeCopy?: ((event: VvCodeCopyEvent) => void) | undefined;
  readonly onGenUiAction: (event: VvGenUiActionEvent) => void;
  readonly onDiagramPress: (event: VvDiagramPressEvent) => void;
  readonly onOpenLink: (url: string) => void;
  readonly onDefaultIssuePress: (number: number) => void;
  readonly onOpenFallbackImage: (image: TextViewImage) => void;
}

function MarkdownAttachmentImage(props: {
  readonly item: MarkdownAttachmentImageSpec;
  readonly onPicture: (key: string, pic: Picture | undefined) => void;
  readonly onOpen: (key: string) => void;
}) {
  const designHost = useDesignHost();
  const file = useAttachmentFile(() => props.item.id);
  const resolved = computed(() => {
    const f = file();
    const label = props.item.alt || f?.name || props.item.id;
    if (f) {
      const kind = fileKind(f.type);
      if (kind === "image") {
        const pic: Picture = { src: fileUrl(f.path), name: label, path: f.path };
        return { kind: "image" as const, picture: pic };
      }
      return { kind: "file" as const, name: label, fileKind: kind };
    }
    if (/^https?:\/\//iu.test(props.item.rawUrl)) {
      const pic: Picture = { src: props.item.rawUrl, name: label };
      return { kind: "image" as const, picture: pic };
    }
    return { kind: "missing" as const, name: label };
  });

  createEffect(
    () => resolved(),
    (res) => {
      props.onPicture(props.item.key, res.kind === "image" ? res.picture : undefined);
    },
  );
  cleanup(() => {
    const key = untracked(() => props.item.key);
    props.onPicture(key, undefined);
  });

  return (
    <If
      when={(() => {
        const r = resolved();
        return r.kind === "image" ? r.picture : undefined;
      })()}
      else={
        <View
          role="button"
          testID={`markdown-attachment-${props.item.id}`}
          accessibilityLabel={resolved().name}
          onPress={() => void openAttachment(props.item.id).catch((e: unknown) => designHost.toast(designHost.formatError(e), "bad"))}
          class="max-w-full flex-row items-center gap-1.5 rounded-md border border-line bg-side px-2.5 py-1.5 hover:bg-hover"
        >
          <Icon
            name={(() => {
              const r = resolved();
              return r.kind === "file" ? kindIcon[r.fileKind] : "image";
            })()}
            size={14}
            tone="muted"
          />
          <Text class="min-w-0 truncate text-xs font-medium text-ink">{resolved().name}</Text>
        </View>
      }
    >
      {(pic) => (
        <View
          role="button"
          testID={`markdown-image-${props.item.id}`}
          accessibilityLabel={pic().name}
          onPress={() => props.onOpen(props.item.key)}
          class="max-w-full self-start overflow-hidden rounded-md border border-line bg-side hover:border-faint hover:opacity-90"
        >
          <Image testID="markdown-image-thumb" src={pic().src} accessibilityLabel={pic().name} class="h-44 w-72 max-w-full bg-side object-contain" />
        </View>
      )}
    </If>
  );
}

function MarkdownChunk(props: MarkdownChunkProps) {
  const native = richNative();
  if (native) {
    const VvMarkdown = native.VvMarkdown;
    return (
      <VvMarkdown
        text={props.text}
        size={props.size}
        baseDir={props.baseDir ?? null}
        mentions={props.mentions === true}
        streaming={props.streaming === true}
        selectable={props.selectable ?? true}
        class={props.class}
        onLinkPress={(e) => props.onOpenLink(e.url)}
        onIssuePress={(e) => {
          if (props.onIssuePress) props.onIssuePress(e);
          else props.onDefaultIssuePress(e.number);
        }}
        onMentionPress={props.onMentionPress}
        onTaskPress={props.onTaskPress}
        onCodeCopy={props.onCodeCopy}
        onGenUiAction={props.onGenUiAction}
        onDiagramPress={props.onDiagramPress}
      />
    );
  }
  return (
    <TextView
      markdown={props.text}
      selectable={props.selectable ?? true}
      classes={{
        ...fallbackClasses,
        ...fallbackHeadings(props.size),
        root: `min-w-0 gap-0 text-ink ${props.size === "sm" ? "text-sm" : "text-base"} ${props.class ?? ""}`,
      }}
      renderCodeBlock={(block) => {
        switch (block.language) {
          case "mermaid":
            return <Diagram source={block.code} interactive onPress={props.onDiagramPress} />;
          case "chart":
            return <Chart spec={block.code} />;
          case "canvas":
            return <Canvas data={block.code} />;
          case "genui":
            return <GenUi spec={block.code} streaming={props.streaming} onAction={props.onGenUiAction} />;
          default:
            return <CodeBlock code={block.code} language={block.language} onCopy={props.onCodeCopy} />;
        }
      }}
      renderImage={(img) => (
        <View
          role="button"
          testID="markdown-image"
          accessibilityLabel={img.alt || img.src}
          onPress={() => props.onOpenFallbackImage(img)}
          class="my-1 max-w-full self-start overflow-hidden rounded-md border border-line bg-side hover:border-faint hover:opacity-90"
        >
          <Image testID="markdown-image-thumb" src={img.src} accessibilityLabel={img.alt || img.src} class="h-44 w-72 max-w-full bg-side object-contain" />
        </View>
      )}
      onLinkPress={(e) => props.onOpenLink(e.url)}
      onTaskPress={props.onTaskPress}
    />
  );
}

/** Chat text, descriptions, notes, and reports. */
export function Markdown(props: MarkdownProps) {
  const designHost = useDesignHost();
  const preview = signal<RichPreviewPayload | undefined>(undefined);
  const knownPictures = signal<ReadonlyMap<string, Picture>>(new Map());
  const lightboxAt = signal<number | undefined>(undefined);
  const fallbackPicture = signal<Picture | undefined>(undefined);
  const size = () => props.size ?? "base";
  const openLink = (url: string) => {
    const attachmentId = extractAttachmentId(url);
    if (attachmentId !== undefined) {
      void openAttachment(attachmentId).catch((e: unknown) => designHost.toast(designHost.formatError(e), "bad"));
      return;
    }
    followDesignHref(designHost, url);
  };
  const openIssue = (number: number) => designHost.navigate(`/issues/${number}`);
  const handleDiagramPress = (event: VvDiagramPressEvent) => {
    if (props.onDiagramPress) {
      props.onDiagramPress(event);
      return;
    }
    preview.set({ kind: "mermaid", source: event.source });
  };
  const handleGenUiAction = (event: VvGenUiActionEvent) => {
    if (props.onGenUiAction) {
      props.onGenUiAction(event);
      return;
    }
    const action = event.action.trim();
    const payload = event.payload.trim();
    if (action === "navigate" && payload.startsWith("/")) {
      designHost.navigate(payload);
      return;
    }
    if (action === "copy" && payload) {
      void Clipboard.writeText(payload).then(
        () => designHost.toast(t("web.base.rich.copied")),
        () => undefined,
      );
      return;
    }
    const summary = formatGenUiAction(event);
    if (summary) designHost.toast(summary);
  };
  const segments = computed(() => splitMarkdownSegments(props.text));
  const hasRichSegments = computed(() => segments().some((seg) => seg.kind !== "markdown"));
  const keyedSegments = computed(() => {
    let mdIdx = 0;
    let cmpIdx = 0;
    let imgsIdx = 0;
    return segments().map((seg) => {
      switch (seg.kind) {
        case "compare":
          return { ...seg, key: `cmp:${cmpIdx++}` };
        case "images":
          return { ...seg, key: `imgs:${imgsIdx++}` };
        case "markdown":
          return { ...seg, key: `md:${mdIdx++}` };
      }
    });
  });

  const imageItems = computed(() => segments().flatMap((seg) => (seg.kind === "images" ? seg.items : [])));
  const lightboxEntries = computed(() => {
    const map = knownPictures();
    return imageItems().flatMap((item) => {
      const pic = map.get(item.key);
      return pic ? [{ key: item.key, picture: pic }] : [];
    });
  });
  const lightboxPictures = computed(() => lightboxEntries().map((e) => e.picture));
  const activeLightboxPictures = computed(() => {
    const fb = fallbackPicture();
    return fb ? [fb] : lightboxPictures();
  });
  const activeLightboxAt = computed(() => (fallbackPicture() ? 0 : lightboxAt()));

  const setKnownPicture = (key: string, pic: Picture | undefined) => {
    const prev = untracked(knownPictures);
    const existing = prev.get(key);
    if (existing?.src === pic?.src && existing?.name === pic?.name && existing?.path === pic?.path) {
      return;
    }
    const next = new Map(prev);
    if (pic) next.set(key, pic);
    else next.delete(key);
    knownPictures.set(next);
  };

  const openLightboxFor = (key: string) => {
    fallbackPicture.set(undefined);
    const idx = untracked(lightboxEntries).findIndex((e) => e.key === key);
    if (idx >= 0) lightboxAt.set(idx);
  };

  const openFallbackImage = (img: TextViewImage) => {
    lightboxAt.set(undefined);
    fallbackPicture.set({ src: img.src, name: img.alt || img.src });
  };

  const handleLightboxAt = (at: number | undefined) => {
    if (untracked(fallbackPicture)) {
      if (at === undefined) fallbackPicture.set(undefined);
      return;
    }
    lightboxAt.set(at);
  };

  return (
    <>
      <If
        when={hasRichSegments()}
        else={
          <MarkdownChunk
            text={props.text}
            class={props.class}
            size={size()}
            baseDir={props.baseDir ?? undefined}
            mentions={props.mentions}
            streaming={props.streaming}
            selectable={props.selectable}
            onIssuePress={props.onIssuePress}
            onMentionPress={props.onMentionPress}
            onTaskPress={props.onTaskPress}
            onCodeCopy={props.onCodeCopy}
            onGenUiAction={handleGenUiAction}
            onDiagramPress={handleDiagramPress}
            onOpenLink={openLink}
            onDefaultIssuePress={openIssue}
            onOpenFallbackImage={openFallbackImage}
          />
        }
      >
        <View testID="markdown-compare-flow" class={`min-w-0 gap-2 ${props.class ?? ""}`}>
          <Each of={keyedSegments()} key={(seg) => seg.key}>
            {(seg) => (
              <If
                when={(() => {
                  const s = seg();
                  return s.kind === "compare" ? s.spec : undefined;
                })()}
                else={
                  <If
                    when={(() => {
                      const s = seg();
                      return s.kind === "images" ? s.items : undefined;
                    })()}
                    else={
                      <MarkdownChunk
                        text={(() => {
                          const s = seg();
                          return s.kind === "markdown" ? s.text : "";
                        })()}
                        size={size()}
                        baseDir={props.baseDir ?? undefined}
                        mentions={props.mentions}
                        streaming={props.streaming}
                        selectable={props.selectable}
                        onIssuePress={props.onIssuePress}
                        onMentionPress={props.onMentionPress}
                        onTaskPress={props.onTaskPress}
                        onCodeCopy={props.onCodeCopy}
                        onGenUiAction={handleGenUiAction}
                        onDiagramPress={handleDiagramPress}
                        onOpenLink={openLink}
                        onDefaultIssuePress={openIssue}
                        onOpenFallbackImage={openFallbackImage}
                      />
                    }
                  >
                    {(items) => (
                      <View testID="markdown-image-strip" class="flex-row flex-wrap items-start gap-2">
                        <Each of={items()} key={(item) => item.key}>
                          {(item) => <MarkdownAttachmentImage item={item()} onPicture={setKnownPicture} onOpen={openLightboxFor} />}
                        </Each>
                      </View>
                    )}
                  </If>
                }
              >
                {(spec) => <Compare spec={spec()} />}
              </If>
            )}
          </Each>
        </View>
      </If>
      <Lightbox pictures={activeLightboxPictures()} at={activeLightboxAt()} onAt={handleLightboxAt} />
      <RichPreviewModal payload={preview()} onClose={() => preview.set(undefined)} />
    </>
  );
}
