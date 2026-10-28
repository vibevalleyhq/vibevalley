// The dictation button every input row has.

import type { IconName } from "../../ui/icons";
import { voiceWording } from "./words";
import { onSettled } from "solid-js";
import { dictation, insertDictated } from "./dictation";
import { createExternal } from "../../base/external";
import { ready, useSettings } from "../../base/query";
import { Icon } from "../../ui/Icon";

/** Tap to start talking, tap again to stop: the words go into the field at its caret, for the owner to read before sending. */
export function DictationButton(props: {
  field: () => HTMLTextAreaElement | HTMLInputElement | undefined;
  value: string;
  onValue: (v: string, caret: number) => void;
  size?: number;
  class?: string;
}) {
  const version = createExternal(dictation.subscribe, () => dictation.version);
  const phase = () => (version(), dictation.phase);
  const problem = () => (version(), dictation.problem);
  const me = {};
  onSettled(() => () => dictation.release(me));
  // Unknown until the settings are read; the server says what is missing then.
  const settings = useSettings();
  const off = () => ready(settings, undefined)?.dictation.url === "";
  const look = (): [IconName, string] =>
    off()
      ? ["record", voiceWording().dictation.unset]
      : phase() === "recording"
        ? ["stop", voiceWording().dictation.recording]
        : phase() === "transcribing"
          ? ["wait", voiceWording().dictation.transcribing]
          : ["record", problem() ? voiceWording().dictation.failed(problem() ?? "") : voiceWording().dictation.start];
  return (
    <button
      type="button"
      aria-label={phase() === "recording" ? voiceWording().dictation.stop : voiceWording().dictation.label}
      title={look()[1]}
      disabled={off() || phase() === "transcribing"}
      onClick={() =>
        // oxlint-disable-next-line solid/reactivity -- like an event handler, it reads the field as it is when the words come.
        void dictation.toggle(me, (words) => {
          const el = props.field();
          const now = props.value;
          const start = el?.selectionStart ?? now.length;
          const end = el?.selectionEnd ?? now.length;
          const next = insertDictated(now, start, end, words);
          props.onValue(next.value, next.caret);
          requestAnimationFrame(() => {
            el?.focus();
            el?.setSelectionRange(next.caret, next.caret);
          });
        })
      }
      class={["shrink-0 cursor-pointer p-1 disabled:cursor-default disabled:opacity-40", { "animate-pulse": phase() === "recording" }, props.class]}
    >
      <Icon name={look()[0]} size={props.size ?? 20} />
    </button>
  );
}
