// Declarative Markdown wrapper backed by native Rust `vibevalley/rich` (`VvMarkdown`),
// with a stock `nsh/base` `TextView` fallback when running headless under `nsh test`.
// Issue numbers (#12), @mentions, PKM syntax, Shiki code blocks, Mermaid diagrams,
// JSON Canvas, SVG Charts, reactive GenUI, and LaTeX math are all handled natively in Rust.
import { TextView } from "nsh/base";

import { hostApi } from "../../../bridge";
import { useRouter } from "../infra/router";
import { Canvas } from "./code/Canvas";
import { Chart } from "./code/Chart";
import { CodeBlock } from "./code/CodeBlock";
import { Diagram } from "./code/Diagram";
import { GenUi } from "./code/GenUi";
import {
  richNative,
  type BlockRefPayload,
  type VvBlockRefPressEvent,
  type VvCodeCopyEvent,
  type VvEmbedPressEvent,
  type VvGenUiActionEvent,
  type VvIssuePressEvent,
  type VvMentionPressEvent,
  type VvTaskPressEvent,
  type VvWikilinkPressEvent,
} from "./rich/native";

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

const fallbackHeadings = (sm: boolean) =>
  sm
    ? { heading1: "text-base", heading2: "text-sm", heading3: "text-sm", heading4: "text-sm", heading5: "text-sm", heading6: "text-sm" }
    : { heading1: "text-lg", heading2: "text-base", heading3: "text-sm", heading4: "text-sm", heading5: "text-sm", heading6: "text-sm" };

export interface MarkdownProps {
  text: string;
  class?: string | undefined;
  size?: "base" | "sm";
  mentions?: boolean;
  pkm?: boolean;
  refs?: readonly BlockRefPayload[];
  streaming?: boolean;
  selectable?: boolean;
  onIssuePress?: (event: VvIssuePressEvent) => void;
  onMentionPress?: (event: VvMentionPressEvent) => void;
  onWikilinkPress?: (event: VvWikilinkPressEvent) => void;
  onBlockRefPress?: (event: VvBlockRefPressEvent) => void;
  onEmbedPress?: (event: VvEmbedPressEvent) => void;
  onTaskPress?: (event: VvTaskPressEvent) => void;
  onCodeCopy?: (event: VvCodeCopyEvent) => void;
  onGenUiAction?: (event: VvGenUiActionEvent) => void;
}

/** Chat text, descriptions, notes, and reports. */
export function Markdown(props: MarkdownProps) {
  const router = useRouter();
  const small = () => props.size === "sm";
  const openLink = (url: string) => {
    if (url.startsWith("/")) router.navigate(url);
    else void hostApi.openUrl(url);
  };
  const native = richNative();
  if (native) {
    const VvMarkdown = native.VvMarkdown;
    return (
      <VvMarkdown
        text={props.text}
        size={props.size ?? "base"}
        mentions={props.mentions === true}
        pkm={props.pkm === true}
        refs={props.refs}
        streaming={props.streaming === true}
        selectable={props.selectable ?? true}
        class={props.class}
        onLinkPress={(e) => openLink(e.url)}
        onIssuePress={(e) => {
          if (props.onIssuePress) props.onIssuePress(e);
          else router.navigate(`/issues/${e.number}`);
        }}
        onMentionPress={props.onMentionPress}
        onWikilinkPress={(e) => {
          if (props.onWikilinkPress) props.onWikilinkPress(e);
          else router.navigate(`/pkm/${encodeURIComponent(e.page)}`);
        }}
        onBlockRefPress={(e) => {
          if (props.onBlockRefPress) props.onBlockRefPress(e);
          else if (e.page) router.navigate(`/pkm/${encodeURIComponent(e.page)}?b=${encodeURIComponent(e.id)}`);
        }}
        onEmbedPress={props.onEmbedPress}
        onTaskPress={props.onTaskPress}
        onCodeCopy={props.onCodeCopy}
        onGenUiAction={props.onGenUiAction}
      />
    );
  }
  return (
    <TextView
      markdown={props.text}
      selectable={props.selectable ?? true}
      classes={{
        ...fallbackClasses,
        ...fallbackHeadings(small()),
        root: `min-w-0 gap-0 text-ink ${small() ? "text-sm" : "text-base"} ${props.class ?? ""}`,
      }}
      renderCodeBlock={(block) => {
        switch (block.language) {
          case "mermaid":
            return <Diagram source={block.code} />;
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
      onLinkPress={(e) => openLink(e.url)}
      onTaskPress={props.onTaskPress}
    />
  );
}
