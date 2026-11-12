import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";

import type { Artifact, ArtifactDisplay } from "@vibevalley/protocol";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { shownTheme } from "#/state/prefs.ts";

import { type Controls, useShown } from "./frame";
import { shellPath } from "./shell";
import { SlidesControls } from "./SlidesControls";

/** The controls under each display; a page as it is has none. */
const controlsFor: Record<ArtifactDisplay, (c: Controls) => JSX.Element> = {
  page: () => undefined,
  slides: (c) => <SlidesControls {...c} />,
  motion: () => undefined,
};

/** One html version in its sandbox, with the controls its display asks for. A page's messages only change what the
 * controls show; the controls' commands go to that one frame. */
export function HtmlFrame(props: {
  artifact: Artifact;
  version: number;
  title: string;
  testId?: string;
  frameStyle: JSX.ClassValue;
  /** Where the frame and its controls sit, when the place needs more than filling it. */
  rootStyle?: JSX.ClassValue;
  onFrame?: (frame: HTMLIFrameElement) => void;
}) {
  const [frame, setFrame] = createSignal<HTMLIFrameElement>();
  const shown = useShown(frame);
  const display = () => props.artifact.display ?? "page";
  return (
    <div data-display={display()} class={["flex min-h-0 min-w-0 flex-1 flex-col", props.rootStyle]}>
      <iframe
        ref={(el) => {
          setFrame(el);
          props.onFrame?.(el);
        }}
        data-testid={props.testId}
        title={props.title}
        src={shellPath(props.artifact.id, props.version, display(), shownTheme())}
        sandbox={htmlSandbox}
        referrerpolicy="no-referrer"
        allow="fullscreen"
        class={props.frameStyle}
      />
      {controlsFor[display()]({ artifact: props.artifact, version: props.version, shown, frame })}
    </div>
  );
}
