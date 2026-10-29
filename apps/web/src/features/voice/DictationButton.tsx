import { t } from "@vibevalley/i18n";
// The dictation button every input row has.

import type { IconName } from "../../ui/icons";

import { onSettled } from "solid-js";
import { dictation, type DictationPhase, insertDictated } from "./dictation";
import { createExternal } from "../../base/external";
import { ready, useSettings } from "../../base/query";
import { Icon, type IconSize } from "../../ui/Icon";

/** Tap to start talking, tap again to stop: the words go into the field at its caret, for the owner to read before sending. */
export function DictationButton(props: {
  field: () => HTMLTextAreaElement | HTMLInputElement | undefined;
  value: string;
  onValue: (v: string, caret: number) => void;
  size?: IconSize;
  class?: string;
}) {
  const version = createExternal(dictation.subscribe, () => dictation.version);
  const phase = () => (version(), dictation.phase);
  const problem = () => (version(), dictation.problem);
  const me = {};
  onSettled(() => () => dictation.release(me));
  // Unknown until the settings are read; the server says what is missing then.
  const settings = useSettings();
  const off = () => ready(settings, undefined)?.dictationReady === false;
  return (
    <DictationMark
      state={off() ? "unset" : phase()}
      problem={problem() ?? undefined}
      size={props.size}
      class={props.class}
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
    />
  );
}

export type DictationState = "unset" | DictationPhase;

/** The button as it looks in each state, the microphone and the server kept out: what DictationButton draws. */
export function DictationMark(props: {
  state: DictationState;
  problem?: string | undefined;
  size?: IconSize | undefined;
  class?: string | undefined;
  onClick: () => void;
}) {
  const look = (): [IconName, string] =>
    props.state === "unset"
      ? ["record", t("web.voice.dictation.unset")]
      : props.state === "recording"
        ? ["stop", t("web.voice.dictation.recording")]
        : props.state === "transcribing"
          ? ["wait", t("web.voice.dictation.transcribing")]
          : ["record", props.problem ? t("web.voice.dictation.failed", { why: props.problem }) : t("web.voice.dictation.start")];
  return (
    <button
      type="button"
      data-testid="dictate"
      data-state={props.state}
      aria-label={props.state === "recording" ? t("web.voice.dictation.stop") : t("web.voice.dictation.label")}
      title={look()[1]}
      disabled={props.state === "unset" || props.state === "transcribing"}
      onClick={() => props.onClick()}
      class={[
        "inline-flex shrink-0 cursor-pointer items-center justify-center p-1 disabled:cursor-default disabled:opacity-50",
        { "animate-pulse": props.state === "recording" },
        props.class,
      ]}
    >
      <Icon name={look()[0]} size={props.size ?? 20} />
    </button>
  );
}
