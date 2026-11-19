// Ported from VibeValley apps/web/src/features/artifact/HtmlFrame.tsx: one
// html version or store artifact view with the controls its display asks for.
// The <iframe> is an nsh WebView given the page (frame.ts says how it talks).
// A web view is a native view over whatever nsh draws in its box and is left
// out of the app's pictures; `covered` hides it (opacity 0 keeps the page
// loaded) while something nsh draws must show over it, as a menu does.
import { cleanup, untracked, View, WebView, type JSX } from "nsh";

import type { Artifact, ArtifactDisplay } from "@vibevalley/protocol";

import { shownTheme } from "../../state/prefs";
import { createFrame, type Frame, shim, withShellQuery } from "./frame";
import { MotionControls } from "./MotionControls";
import { SlidesControls } from "./SlidesControls";
import { useArtifactPage, useReportViewContext, useStoreViewHtml } from "./store";

/** What the controls under a display are given. */
export interface Controls {
  readonly artifact: Artifact;
  readonly version: number;
  readonly frame: Frame;
  /** The page fills the whole view (a deck shown), or goes back. */
  readonly onPresent: (on: boolean) => void;
}

/** The controls under each display; a page as it is has none. */
const controlsFor: Record<ArtifactDisplay, (c: Controls) => JSX.Element> = {
  page: () => undefined,
  slides: (c) => <SlidesControls {...c} />,
  motion: (c) => <MotionControls {...c} />,
};

export interface HtmlFrameProps {
  readonly artifact: Artifact;
  readonly version: number;
  readonly title: string;
  readonly testId?: string;
  readonly frameClass: string;
  /** Where the frame and its controls sit, when the place needs more than filling it. */
  readonly rootClass?: string;
  readonly covered?: boolean;
  /** Optional store view overrides when `artifact.body === "store"` (loaded via native `artifact.view`). */
  readonly viewPath?: string;
  readonly viewElementId?: string;
  readonly viewSeq?: number;
  readonly hideControls?: boolean;
  readonly onPresent?: (on: boolean) => void;
  readonly onFrame?: (frame: Frame) => void;
  readonly onMessage?: (raw: unknown) => void;
}

/** One html version or store view in its web view, with the controls its display asks for. A page's messages only
 * change what the controls show; the controls' commands go to that one view. */
export function HtmlFrame(props: HtmlFrameProps) {
  const frame = createFrame();
  untracked(() => props.onFrame)?.(frame);
  if (props.onMessage) {
    const off = frame.onMessage((raw) => props.onMessage?.(raw));
    cleanup(off);
  }

  const isStore = () => props.artifact.body === "store";
  const htmlPage = useArtifactPage(() => (isStore() ? undefined : { id: props.artifact.id, version: props.version, theme: shownTheme() }));
  const storeView = useStoreViewHtml(() =>
    isStore()
      ? {
          id: props.artifact.id,
          theme: shownTheme(),
          ...(props.viewPath !== undefined ? { path: props.viewPath } : {}),
          ...(props.viewElementId !== undefined ? { elementId: props.viewElementId } : {}),
          seq: props.viewSeq ?? props.version,
        }
      : undefined,
  );

  const display = () => props.artifact.display ?? "page";
  const page = () => {
    if (isStore()) return storeView.html();
    const raw = htmlPage.html();
    return raw !== undefined ? withShellQuery(raw) : undefined;
  };

  if (!untracked(() => props.hideControls) && !untracked(isStore)) {
    useReportViewContext(
      () => props.artifact.id,
      () => {
        const atPage = frame.shown().at?.page;
        const atTime = frame.shown().at?.time;
        return {
          title: props.artifact.title,
          version: props.version,
          ...(display() === "slides" && atPage !== undefined ? { slideIndex: atPage } : {}),
          ...(display() === "motion" && atTime !== undefined ? { time: Math.round(atTime * 100) / 100 } : {}),
        };
      },
    );
  }

  const stateText = () => {
    const s = frame.state();
    const ready = frame.shown().ready;
    return typeof s === "object" ? `error: ${s.error}` : ready ? `${s} ${ready.display}${ready.pages !== undefined ? ` ${ready.pages}` : ""}` : s;
  };

  return (
    <View testID={props.testId ? `${props.testId}-root` : undefined} class={`min-h-0 min-w-0 flex-1 ${props.rootClass ?? ""}`}>
      <If when={page()}>
        {(html) => (
          <WebView
            ref={(r) => frame.setRef(r)}
            testID={props.testId}
            accessibilityLabel={props.title}
            accessibilityValue={{ text: stateText() }}
            html={html()}
            incognito
            injectedJavaScriptBeforeContentLoaded={shim}
            onLoadStart={() => frame.setState("loading")}
            onLoad={() => frame.setState("loaded")}
            onError={(e) => frame.setState({ error: e.code ?? e.message })}
            onMessage={(e) => frame.heard(e.data)}
            class={props.frameClass}
            style={props.covered === true ? { opacity: 0 } : undefined}
          />
        )}
      </If>
      <If when={props.hideControls !== true && !isStore()}>
        {controlsFor[display()]({ artifact: props.artifact, version: props.version, frame, onPresent: (on) => props.onPresent?.(on) })}
      </If>
    </View>
  );
}
