// Lazy accessor for the native Rust `vibevalley/rich` UI set registered by apps/mac.
// Stock `nsh test` loads only `nsh/base`, where `nativeModule("vibevalley/rich")` throws
// ReferenceError; catching once lets declarative TS wrappers fall back cleanly in tests.
import { nativeModule, type ComponentHostProps, type JSX, type Modifiers } from "nsh";
import type { TextViewClasses, TextViewLinks, TextViewStyles } from "nsh/base";

import { setTranslator } from "@vibevalley/i18n";

export interface VvCodeCopyEvent {
  code: string;
  language?: string | null;
}

export interface VvDiagramPressEvent {
  source: string;
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

export type VvMarkdownSize = "base" | "sm" | "doc";

/** Formats a GenUI action event into a concise human-readable line for toasts or channel feedback. */
export function formatGenUiAction(event: VvGenUiActionEvent): string {
  const action = event.action.trim();
  const payload = event.payload.trim();
  if (action === "state_change") return payload;
  if (!action) return payload;
  return payload ? `${action}: ${payload}` : action;
}

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
  interactive?: boolean;
  onPress?: (event: VvDiagramPressEvent) => void;
}

export interface VvGenUiProps extends ComponentHostProps {
  spec: string;
  streaming?: boolean;
  onAction?: (event: VvGenUiActionEvent) => void;
}

export interface VvIconProps extends ComponentHostProps {
  name: string;
  size?: number;
  color?: string;
  label?: string | null;
}

export interface VvMarkdownProps extends ComponentHostProps {
  text: string;
  size?: VvMarkdownSize;
  baseDir?: string | null;
  mentions?: boolean;
  streaming?: boolean;
  selectable?: boolean;
  links?: TextViewLinks;
  classes?: TextViewClasses;
  styles?: TextViewStyles;
  onLinkPress?: (event: VvLinkPressEvent) => void;
  onIssuePress?: (event: VvIssuePressEvent) => void;
  onMentionPress?: (event: VvMentionPressEvent) => void;
  onTaskPress?: (event: VvTaskPressEvent) => void;
  onCodeCopy?: (event: VvCodeCopyEvent) => void;
  onGenUiAction?: (event: VvGenUiActionEvent) => void;
  onDiagramPress?: (event: VvDiagramPressEvent) => void;
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

export interface VvWhiteboardCursorEvent {
  x: number;
  y: number;
  viewportX: number;
  viewportY: number;
  viewportW: number;
  viewportH: number;
  zoom: number;
}

export interface VvWhiteboardViewportEvent {
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
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
  onCursorMove?: (event: VvWhiteboardCursorEvent) => void;
  onViewportChange?: (event: VvWhiteboardViewportEvent) => void;
}

export interface VvRichModule {
  VvCanvas: (props: VvCanvasProps) => JSX.Element;
  VvChart: (props: VvChartProps) => JSX.Element;
  VvCodeBlock: (props: VvCodeBlockProps) => JSX.Element;
  VvDiagram: (props: VvDiagramProps) => JSX.Element;
  VvGenUi: (props: VvGenUiProps) => JSX.Element;
  VvIcon: (props: VvIconProps) => JSX.Element;
  VvMarkdown: (props: VvMarkdownProps) => JSX.Element;
  VvWhiteboard: (props: VvWhiteboardProps) => JSX.Element;
  matchPinyin: (text: string, query: string) => boolean;
  translate?: (locale: string, key: string, paramsJson?: string) => string;
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

/** Routes `@vibevalley/i18n` through native Rust `VvI18n` when the host registers it. */
export function installNativeI18n(): void {
  const translate = richNative()?.translate;
  if (!translate) return;
  setTranslator((locale, key, params) => (params ? translate(locale, key, JSON.stringify(params)) : translate(locale, key)));
}
