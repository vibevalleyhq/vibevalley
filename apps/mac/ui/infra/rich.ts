// Lazy accessor for the native Rust `vibevalley/rich` UI set registered by apps/mac.
// Stock `nsh test` loads only `nsh/base`, where `nativeModule("vibevalley/rich")` throws
// ReferenceError; catching once lets declarative TS wrappers fall back cleanly in tests.
import { nativeModule, type ComponentHostProps, type JSX, type Modifiers } from "nsh";
import type { TextViewClasses, TextViewLinks, TextViewStyles } from "nsh/base";

export interface BlockRefPayload {
  block: string;
  body?: string | null;
  page?: string | null;
  pageTitle?: string | null;
  found?: boolean;
}

export interface VvBlockRefPressEvent {
  id: string;
  page?: string | null;
}

export interface VvCodeCopyEvent {
  code: string;
  language?: string | null;
}

export interface VvEmbedPressEvent {
  target: string;
}

export interface VvGenUiActionEvent {
  action: string;
  payload: string;
}

export interface VvIssuePressEvent {
  number: number;
}

export interface VvLinkPressEvent {
  url: string;
  modifiers: Modifiers;
}

export interface VvMentionPressEvent {
  name: string;
}

export interface VvTaskPressEvent {
  index: number;
  checked: boolean;
}

export interface VvWikilinkPressEvent {
  page: string;
  label: string;
}

export type VvMarkdownSize = "base" | "sm";

export interface VvCanvasProps extends ComponentHostProps {
  data: string;
  showGrid?: boolean;
  padding?: number;
}

export interface VvChartProps extends ComponentHostProps {
  spec: string;
  title?: string | null;
}

export interface VvCodeBlockProps extends ComponentHostProps {
  code: string;
  language?: string | null;
  foldLines?: number;
  selectable?: boolean;
  wrap?: boolean;
  onCopy?: (event: VvCodeCopyEvent) => void;
}

export interface VvDiagramProps extends ComponentHostProps {
  source: string;
  maxWidth?: number | null;
}

export interface VvGenUiProps extends ComponentHostProps {
  spec: string;
  streaming?: boolean;
  onAction?: (event: VvGenUiActionEvent) => void;
}

export interface VvMarkdownProps extends ComponentHostProps {
  text: string;
  size?: VvMarkdownSize;
  mentions?: boolean;
  pkm?: boolean;
  refs?: readonly BlockRefPayload[];
  streaming?: boolean;
  selectable?: boolean;
  links?: TextViewLinks;
  classes?: TextViewClasses;
  styles?: TextViewStyles;
  onLinkPress?: (event: VvLinkPressEvent) => void;
  onIssuePress?: (event: VvIssuePressEvent) => void;
  onMentionPress?: (event: VvMentionPressEvent) => void;
  onWikilinkPress?: (event: VvWikilinkPressEvent) => void;
  onBlockRefPress?: (event: VvBlockRefPressEvent) => void;
  onEmbedPress?: (event: VvEmbedPressEvent) => void;
  onTaskPress?: (event: VvTaskPressEvent) => void;
  onCodeCopy?: (event: VvCodeCopyEvent) => void;
  onGenUiAction?: (event: VvGenUiActionEvent) => void;
}

export interface VvWhiteboardBatchEvent {
  writesJson: string;
}

export interface VvWhiteboardSelectionEvent {
  idsJson: string;
  count: number;
}

export interface VvWhiteboardChatEvent {
  selectedIdsJson: string;
}

export interface VvWhiteboardExportEvent {
  format: string;
  filename: string;
  mime: string;
  content: string;
}

export interface VvWhiteboardProps extends ComponentHostProps {
  entriesJson: string;
  presencesJson?: string;
  seq?: number;
  title?: string;
  readOnly?: boolean;
  locale?: string;
  onBatch?: (event: VvWhiteboardBatchEvent) => void;
  onSelectionChange?: (event: VvWhiteboardSelectionEvent) => void;
  onOpenChat?: (event: VvWhiteboardChatEvent) => void;
  onExport?: (event: VvWhiteboardExportEvent) => void;
}

export interface VvRichModule {
  VvCanvas: (props: VvCanvasProps) => JSX.Element;
  VvChart: (props: VvChartProps) => JSX.Element;
  VvCodeBlock: (props: VvCodeBlockProps) => JSX.Element;
  VvDiagram: (props: VvDiagramProps) => JSX.Element;
  VvGenUi: (props: VvGenUiProps) => JSX.Element;
  VvMarkdown: (props: VvMarkdownProps) => JSX.Element;
  VvWhiteboard: (props: VvWhiteboardProps) => JSX.Element;
  matchPinyin: (text: string, query: string) => boolean;
}

let cached: VvRichModule | null | undefined;

export function richNative(): VvRichModule | undefined {
  if (cached !== undefined) return cached ?? undefined;
  try {
    cached = nativeModule<VvRichModule>("vibevalley/rich");
  } catch {
    cached = null;
  }
  return cached ?? undefined;
}
