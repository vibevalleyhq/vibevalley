// Ported from VibeValley apps/web/src/features/artifact/HtmlFrame.tsx: one
// html version with the controls its display asks for. The <iframe> is an
// nsh WebView given the page (frame.ts says how it talks). A web view is a
// native view over whatever nsh draws in its box and is left out of the
// app's pictures; `covered` hides it (opacity 0 keeps the page loaded)
// while something nsh draws must show over it, as a menu does.
import { untracked, View, WebView, type JSX } from "nsh";

import type { Artifact, ArtifactDisplay } from "@vibevalley/protocol";

import { shownTheme } from "../../state/prefs";
import { useArtifactContent } from "./ArtifactCard";
import { createFrame, type Frame, framed, shim } from "./frame";
import { SlidesControls } from "./SlidesControls";

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
  motion: () => undefined,
};

/** One html version in its web view, with the controls its display asks for. A page's messages only change what the
 * controls show; the controls' commands go to that one view. */
export function HtmlFrame(props: {
  artifact: Artifact;
  version: number;
  title: string;
  testId?: string;
  frameClass: string;
  /** Where the frame and its controls sit, when the place needs more than filling it. */
  rootClass?: string;
  covered?: boolean;
  onPresent?: (on: boolean) => void;
  onFrame?: (frame: Frame) => void;
}) {
  const frame = createFrame();
  untracked(() => props.onFrame)?.(frame);
  const content = useArtifactContent(() => ({ id: props.artifact.id, version: props.version }));
  const display = () => props.artifact.display ?? "page";
  const page = () => {
    const c = content.data();
    return c ? framed({ page: c.content, display: display(), theme: shownTheme() }) : undefined;
  };
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
      {controlsFor[display()]({ artifact: props.artifact, version: props.version, frame, onPresent: (on) => props.onPresent?.(on) })}
    </View>
  );
}
