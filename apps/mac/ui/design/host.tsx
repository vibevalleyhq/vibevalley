// Narrow host boundary for core `design/` primitives so design components stay decoupled from `infra/`.
import { context, type JSX } from "nsh";

import type { MotionChoice } from "@vibevalley/protocol/host";

import { installScrollbarTheme } from "./scrollbar";
import { toast as pushToast, type Tone as ToastTone } from "./toasts";

export interface QrMatrix {
  readonly size: number;
  readonly rows: readonly string[];
}

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
}

const defaultDesignHost: DesignHost = {
  openExternal: () => {},
  openFile: () => {},
  navigate: () => {},
  saveFile: () => Promise.resolve({ saved: false }),
  renderQr: () => Promise.resolve(undefined),
  toast: pushToast,
  getPrefWidth: () => undefined,
  setPrefWidth: () => {},
  formatError: (error) => (error instanceof Error ? error.message : String(error)),
};

const DesignHostContext = context<DesignHost>(defaultDesignHost);

export function useDesignHost(): DesignHost {
  return DesignHostContext();
}

export function DesignHostProvider(props: { host: DesignHost; children: JSX.Element }) {
  installScrollbarTheme();
  return <DesignHostContext.Provider value={props.host}>{props.children}</DesignHostContext.Provider>;
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
