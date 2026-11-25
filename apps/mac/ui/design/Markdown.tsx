// Declarative Markdown wrapper backed by native Rust `vibevalley/rich` (`VvMarkdown`),
// with a stock `nsh/base` `TextView` fallback when running headless under `nsh test`.
// Issue numbers (#12), @mentions, Shiki code blocks, Mermaid diagrams,
// JSON Canvas, SVG Charts, reactive GenUI, and LaTeX math are all handled natively in Rust.
import { Clipboard, signal } from "nsh";
import { TextView } from "nsh/base";

import { t } from "@vibevalley/i18n";

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
import { Canvas } from "./code/Canvas";
import { Chart } from "./code/Chart";
import { CodeBlock } from "./code/CodeBlock";
import { Diagram } from "./code/Diagram";
import { GenUi } from "./code/GenUi";
import { followDesignHref, useDesignHost } from "./host";
import { RichPreviewModal, type RichPreviewPayload } from "./RichPreviewModal";

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

/** Chat text, descriptions, notes, and reports. */
export function Markdown(props: MarkdownProps) {
  const designHost = useDesignHost();
  const preview = signal<RichPreviewPayload | undefined>(undefined);
  const size = () => props.size ?? "base";
  const openLink = (url: string) => followDesignHref(designHost, url);
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
  const native = richNative();
  if (native) {
    const VvMarkdown = native.VvMarkdown;
    return (
      <>
        <VvMarkdown
          text={props.text}
          size={size()}
          baseDir={props.baseDir ?? null}
          mentions={props.mentions === true}
          streaming={props.streaming === true}
          selectable={props.selectable ?? true}
          class={props.class}
          onLinkPress={(e) => openLink(e.url)}
          onIssuePress={(e) => {
            if (props.onIssuePress) props.onIssuePress(e);
            else designHost.navigate(`/issues/${e.number}`);
          }}
          onMentionPress={props.onMentionPress}
          onTaskPress={props.onTaskPress}
          onCodeCopy={props.onCodeCopy}
          onGenUiAction={handleGenUiAction}
          onDiagramPress={handleDiagramPress}
        />
        <RichPreviewModal payload={preview()} onClose={() => preview.set(undefined)} />
      </>
    );
  }
  return (
    <>
      <TextView
        markdown={props.text}
        selectable={props.selectable ?? true}
        classes={{
          ...fallbackClasses,
          ...fallbackHeadings(size()),
          root: `min-w-0 gap-0 text-ink ${size() === "sm" ? "text-sm" : "text-base"} ${props.class ?? ""}`,
        }}
        renderCodeBlock={(block) => {
          switch (block.language) {
            case "mermaid":
              return <Diagram source={block.code} interactive onPress={handleDiagramPress} />;
            case "chart":
              return <Chart spec={block.code} />;
            case "canvas":
              return <Canvas data={block.code} />;
            case "genui":
              return <GenUi spec={block.code} streaming={props.streaming} onAction={handleGenUiAction} />;
            default:
              return <CodeBlock code={block.code} language={block.language} onCopy={props.onCodeCopy} />;
          }
        }}
        onLinkPress={(e) => openLink(e.url)}
        onTaskPress={props.onTaskPress}
      />
      <RichPreviewModal payload={preview()} onClose={() => preview.set(undefined)} />
    </>
  );
}
