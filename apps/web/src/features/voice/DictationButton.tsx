import { t } from "@vibevalley/i18n";
// The dictation button every input row has.

import type { IconName } from "../../ui/icons";

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
      ? ["record", t("web.voice.dictation.unset")]
      : phase() === "recording"
        ? ["stop", t("web.voice.dictation.recording")]
        : phase() === "transcribing"
          ? ["wait", t("web.voice.dictation.transcribing")]
          : ["record", problem() ? t("web.voice.dictation.failed", { why: problem() ?? "" }) : t("web.voice.dictation.start")];
  return (
    <button
      type="button"
      aria-label={phase() === "recording" ? t("web.voice.dictation.stop") : t("web.voice.dictation.label")}
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
      class={[
        "inline-flex shrink-0 cursor-pointer items-center justify-center p-1 disabled:cursor-default disabled:opacity-50",
        { "animate-pulse": phase() === "recording" },
        props.class,
      ]}
    >
      <Icon name={look()[0]} size={props.size ?? 20} />
    </button>
  );
}
