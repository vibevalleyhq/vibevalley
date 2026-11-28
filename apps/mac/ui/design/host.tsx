// Narrow host boundary for core `design/` primitives so design components stay completely decoupled from `infra/`.
import { context, nativeModule, untracked, type ComponentHostProps, type JSX, type Modifiers, type ViewRef } from "nsh";
import type { TextViewClasses, TextViewLinks, TextViewStyles } from "nsh/base";

import type { Agent, Attachment, Missing, RuntimeInfo, SettingsStatus } from "@vibevalley/protocol";
import type { MotionChoice } from "@vibevalley/protocol/host";

import { installScrollbarTheme } from "./scrollbar";
import { toast as pushToast, type Tone as ToastTone } from "./toasts";

export interface QrMatrix {
  readonly size: number;
  readonly rows: readonly string[];
}

export interface DesignAttachmentFile {
  readonly path: string;
  readonly type: string;
  readonly name?: string;
}

export interface DesignProbeNode {
  readonly testId: string;
  readonly role?: string;
  readonly parentId?: string | undefined;
  readonly text?: () => string | undefined;
  readonly getRef?: () => ViewRef | undefined;
  readonly getLineCount?:
    | ((bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined) => number | undefined)
    | undefined;
  readonly getFocused?: (() => boolean | undefined) | undefined;
  readonly onPress?: () => void;
}

export interface DesignCodeCopyEvent {
  code: string;
  language?: string | null;
}

export interface DesignDiagramPressEvent {
  source: string;
}

export interface DesignGenUiActionEvent {
  action: string;
  payload: string;
}

export interface DesignIssuePressEvent {
  number: number;
}

export interface DesignLinkPressEvent {
  url: string;
  modifiers: Modifiers;
}

export interface DesignMentionPressEvent {
  name: string;
}

export interface DesignTaskPressEvent {
  index: number;
  checked: boolean;
}

export interface DesignRichNative {
  readonly VvCanvas: (props: ComponentHostProps & { data: string; showGrid?: boolean; padding?: number }) => JSX.Element;
  readonly VvChart: (props: ComponentHostProps & { spec: string; title?: string | null }) => JSX.Element;
  readonly VvCodeBlock: (
    props: ComponentHostProps & {
      code: string;
      language?: string | null;
      foldLines?: number;
      selectable?: boolean;
      wrap?: boolean;
      onCopy?: (event: DesignCodeCopyEvent) => void;
    },
  ) => JSX.Element;
  readonly VvDiagram: (
    props: ComponentHostProps & {
      source: string;
      maxWidth?: number | null;
      interactive?: boolean;
      onPress?: (event: DesignDiagramPressEvent) => void;
    },
  ) => JSX.Element;
  readonly VvGenUi: (
    props: ComponentHostProps & {
      spec: string;
      streaming?: boolean;
      onAction?: (event: DesignGenUiActionEvent) => void;
    },
  ) => JSX.Element;
  readonly VvIcon: (props: ComponentHostProps & { name: string; size?: number; color?: string; label?: string | null }) => JSX.Element;
  readonly VvMarkdown: (
    props: ComponentHostProps & {
      text: string;
      size?: "base" | "sm" | "doc";
      baseDir?: string | null;
      mentions?: boolean;
      streaming?: boolean;
      selectable?: boolean;
      links?: TextViewLinks;
      classes?: TextViewClasses;
      styles?: TextViewStyles;
      onLinkPress?: (event: DesignLinkPressEvent) => void;
      onIssuePress?: (event: DesignIssuePressEvent) => void;
      onMentionPress?: (event: DesignMentionPressEvent) => void;
      onTaskPress?: (event: DesignTaskPressEvent) => void;
      onCodeCopy?: (event: DesignCodeCopyEvent) => void;
      onGenUiAction?: (event: DesignGenUiActionEvent) => void;
      onDiagramPress?: (event: DesignDiagramPressEvent) => void;
    },
  ) => JSX.Element;
}

export interface DesignCoreBridge {
  readonly parseCompareSpec?: (raw: string) => string | null;
  readonly splitCompareBlocks?: (text: string) => string;
  readonly formatCompareBlock?: (specJson: string) => string | null;
}

type DesignRichModule = DesignRichNative & DesignCoreBridge;

let richResolved = false;
let cachedRich: DesignRichModule | undefined;
let coreBridgeGetter: (() => DesignCoreBridge | undefined) | undefined;

function defaultRichModule(): DesignRichModule | undefined {
  if (richResolved) return cachedRich;
  richResolved = true;
  try {
    cachedRich = nativeModule<DesignRichModule>("vibevalley/rich");
  } catch {
    cachedRich = undefined;
  }
  return cachedRich;
}

/** Registers the host-provided synchronous core bridge getter (`app/DesignHost` wires `infra/rich::coreBridge`). */
export function registerDesignCoreBridge(getter: (() => DesignCoreBridge | undefined) | undefined): void {
  coreBridgeGetter = getter;
}

/** Returns the active synchronous `Compare` core bridge (host-registered bridge or direct `"vibevalley/rich"` native module). */
export function getDesignCoreBridge(): DesignCoreBridge | undefined {
  return coreBridgeGetter ? coreBridgeGetter() : defaultRichModule();
}

export const fileUrl = (path: string) => `file://${encodeURI(path)}`;

export interface DesignHost {
  readonly openExternal: (url: string) => void | Promise<unknown>;
  readonly openFile: (path: string) => void | Promise<unknown>;
  readonly navigate: (path: string, options?: { replace?: boolean }) => void;
  readonly saveFile: (path: string, name?: string) => Promise<{ saved: boolean }>;
  readonly renderQr: (text: string, border: number) => Promise<QrMatrix | undefined>;
  readonly toast: (text: string, tone?: ToastTone) => void;
  readonly motion?: (choice: MotionChoice) => void;
  readonly getPrefWidth: (pane: string) => number | undefined;
  readonly setPrefWidth: (pane: string, width: number | undefined) => void;
  readonly formatError: (error: unknown) => string;
  readonly rich?: () => DesignRichNative | undefined;
  readonly useAttachmentFile?: (id: () => string) => () => DesignAttachmentFile | undefined;
  readonly openAttachment?: (id: string) => Promise<void>;
  readonly uploadAttachmentBlob?: (file: File | Blob, fallbackName: string) => Promise<Attachment>;
  readonly importLocalAttachment?: (uri: string) => Promise<Attachment>;
  readonly useAssetsDir?: () => () => string | undefined;
  readonly openTerminal?: (req: { readonly cwd: string; readonly title?: string }) => Promise<unknown>;
  readonly isProbeEnabled?: () => boolean;
  readonly useProbe?: (node: DesignProbeNode) => void;
  readonly useAgents?: () => () => readonly Agent[];
  readonly useRuntimes?: () => () => readonly RuntimeInfo[];
  readonly useSettings?: () => () => SettingsStatus | undefined;
  readonly readinessFix?: (missing: Missing) => { readonly words: string; readonly href: string };
  readonly matchesSearch?: (query: string, fields: readonly (string | undefined)[]) => boolean;
}

export interface ResolvedDesignHost extends DesignHost {
  readonly rich: () => DesignRichNative | undefined;
  readonly useAttachmentFile: (id: () => string) => () => DesignAttachmentFile | undefined;
  readonly openAttachment: (id: string) => Promise<void>;
  readonly uploadAttachmentBlob: (file: File | Blob, fallbackName: string) => Promise<Attachment>;
  readonly importLocalAttachment: (uri: string) => Promise<Attachment>;
  readonly useAssetsDir: () => () => string | undefined;
  readonly openTerminal: (req: { readonly cwd: string; readonly title?: string }) => Promise<unknown>;
  readonly isProbeEnabled: () => boolean;
  readonly useProbe: (node: DesignProbeNode) => void;
  readonly useAgents: () => () => readonly Agent[];
  readonly useRuntimes: () => () => readonly RuntimeInfo[];
  readonly useSettings: () => () => SettingsStatus | undefined;
  readonly readinessFix: (missing: Missing) => { readonly words: string; readonly href: string };
  readonly matchesSearch: (query: string, fields: readonly (string | undefined)[]) => boolean;
}

const emptyAgents: readonly Agent[] = [];
const emptyRuntimes: readonly RuntimeInfo[] = [];

const defaultDesignHost: ResolvedDesignHost = {
  openExternal: () => {},
  openFile: () => {},
  navigate: () => {},
  saveFile: () => Promise.resolve({ saved: false }),
  renderQr: () => Promise.resolve(undefined),
  toast: pushToast,
  getPrefWidth: () => undefined,
  setPrefWidth: () => {},
  formatError: (error) => (error instanceof Error ? error.message : String(error)),
  rich: defaultRichModule,
  useAttachmentFile: () => () => undefined,
  openAttachment: () => Promise.resolve(),
  uploadAttachmentBlob: () => Promise.reject(new Error("Attachment upload host is unavailable")),
  importLocalAttachment: () => Promise.reject(new Error("Attachment import host is unavailable")),
  useAssetsDir: () => () => undefined,
  openTerminal: () => Promise.resolve(),
  isProbeEnabled: () => false,
  useProbe: () => {},
  useAgents: () => () => emptyAgents,
  useRuntimes: () => () => emptyRuntimes,
  useSettings: () => () => undefined,
  readinessFix: () => ({ words: "", href: "/settings" }),
  matchesSearch: (query, fields) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return fields.some((f) => (f ?? "").toLowerCase().includes(q));
  },
};

const DesignHostContext = context<ResolvedDesignHost>(defaultDesignHost);

export function useDesignHost(): ResolvedDesignHost {
  return DesignHostContext();
}

export function useDesignAttachmentUrl(id: () => string): () => string | undefined {
  const file = useDesignHost().useAttachmentFile(id);
  return () => {
    const f = file();
    return f ? fileUrl(f.path) : undefined;
  };
}

export function DesignHostProvider(props: { host: DesignHost; children: JSX.Element }) {
  installScrollbarTheme();
  const resolved: ResolvedDesignHost = untracked(() => ({ ...defaultDesignHost, ...props.host }));
  return <DesignHostContext.Provider value={resolved}>{props.children}</DesignHostContext.Provider>;
}

/** Navigates to an internal path via `navigate`, or opens an external URL via `openExternal`. */
export function followDesignHref(host: DesignHost, href: string, options?: { replace?: boolean }): void {
  const trimmed = href.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("/")) {
    host.navigate(trimmed, options);
  } else {
    void host.openExternal(trimmed);
  }
}
