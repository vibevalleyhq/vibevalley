import { type Accessor, createSignal, onSettled } from "solid-js";

import type { Artifact, HtmlShellCommand, HtmlShellMessage } from "@vibevalley/protocol";

import { shellMessageOf } from "./shell";

/** What the page's runtime last said: what it is (ready) and where it is (at). */
export interface Shown {
  readonly ready?: Extract<HtmlShellMessage, { vibevalley: "ready" }>;
  readonly at?: Extract<HtmlShellMessage, { vibevalley: "at" }>;
}

/** What a frame's runtime says, followed: only messages from that frame, only the protocol's. */
export function useShown(frame: Accessor<HTMLIFrameElement | undefined>): Accessor<Shown> {
  const [shown, setShown] = createSignal<Shown>({});
  onSettled(() => {
    const heard = (e: MessageEvent) => {
      if (e.source === null || e.source !== frame()?.contentWindow) return;
      const message = shellMessageOf(e.data);
      if (message?.vibevalley === "ready") setShown((s) => ({ ...s, ready: message }));
      if (message?.vibevalley === "at") setShown((s) => ({ ...s, at: message }));
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  });
  return shown;
}

/** A command to a frame's runtime; nothing when the frame is gone. */
export const sendTo = (frame: HTMLIFrameElement | undefined) => (command: HtmlShellCommand) => frame?.contentWindow?.postMessage(command, "*");

export interface Controls {
  readonly artifact: Artifact;
  readonly version: number;
  readonly shown: Accessor<Shown>;
  readonly frame: Accessor<HTMLIFrameElement | undefined>;
}
