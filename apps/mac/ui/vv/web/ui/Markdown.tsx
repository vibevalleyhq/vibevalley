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
  blockquote: "my-0 border-l-2 border-line pl-3 text-muted",
  code: "rounded-sm border-0 bg-hover px-1 font-mono text-xs",
  heading: "mt-0 mb-0 font-semibold",
  heading1: "text-lg",
  paragraph: "my-1",
  list: "my-0 pl-5",
  listItem: "my-0.5",
  listItemContent: "gap-0",
  taskMarker: "mt-1 size-3.5",
  table: "my-2",
  tableHead: "bg-transparent",
  tableCell: "border border-line px-2 py-0",
  tableHeaderCell: "bg-transparent font-semibold text-ink",
  rule: "my-2 border-line",
};

const fallbackHeadings = (size: string) => ({ heading2: size, heading3: size, heading4: size, heading5: size, heading6: size });

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
        ...fallbackHeadings(props.size === "sm" ? "text-sm" : "text-base"),
        root: `min-w-0 gap-0 text-ink ${props.size === "sm" ? "text-sm" : "text-base"} ${props.class ?? ""}`,
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
