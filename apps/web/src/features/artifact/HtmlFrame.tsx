import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { createSignal, onSettled } from "solid-js";

import type { Artifact, HtmlShellCommand, HtmlShellMessage } from "@vibevalley/protocol";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { shownTheme } from "#/state/prefs.ts";

import { shellMessageOf, shellPath } from "./shell";

const viewStyles = stylex.create({
  htmlFrame: {
    display: "flex",
    minHeight: "0",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
});

/** What the page's runtime last said: what it is (ready) and where it is (at). */
export interface Shown {
  readonly ready?: Extract<HtmlShellMessage, { vibevalley: "ready" }>;
  readonly at?: Extract<HtmlShellMessage, { vibevalley: "at" }>;
}

/** One html version in its sandbox, with the controls its display asks for. A page's messages only change what the
 * controls show; the controls' commands go to that one frame. */
export function HtmlFrame(props: {
  artifact: Artifact;
  version: number;
  title: string;
  testId?: string;
  frameStyle: StyleXStyles;
  onFrame?: (frame: HTMLIFrameElement) => void;
}) {
  const [frame, setFrame] = createSignal<HTMLIFrameElement>();
  const [shown, setShown] = createSignal<Shown>({});
  onSettled(() => {
    const heard = (e: MessageEvent) => {
      if (e.source !== frame()?.contentWindow) return;
      const message = shellMessageOf(e.data);
      if (message?.vibevalley === "ready") setShown((s) => ({ ...s, ready: message }));
      if (message?.vibevalley === "at") setShown((s) => ({ ...s, at: message }));
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  });
  const display = () => props.artifact.display ?? "page";
  const send = (command: HtmlShellCommand) => frame()?.contentWindow?.postMessage(command, "*");
  return (
    <div data-display={display()} {...stylex.attrs(viewStyles.htmlFrame)}>
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
        {...stylex.attrs(props.frameStyle)}
      />
      {controlsFor[display()]({ artifact: props.artifact, version: props.version, shown: shown(), send })}
    </div>
  );
}

interface Controls {
  readonly artifact: Artifact;
  readonly version: number;
  readonly shown: Shown;
  readonly send: (command: HtmlShellCommand) => void;
}

/** The controls under each display; a page as it is has none. */
const controlsFor: Record<NonNullable<Artifact["display"]>, (c: Controls) => ReturnType<typeof HtmlFrame> | undefined> = {
  page: () => undefined,
  slides: () => undefined,
  motion: () => undefined,
};
