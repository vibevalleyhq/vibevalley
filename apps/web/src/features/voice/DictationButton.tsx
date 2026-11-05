// The dictation key every input row has, and the bar a workbench box shows while it listens.

import { createEffect, createSignal, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createExternal } from "#/base/external.ts";
import { ready, useSettings } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { Icon, type IconSize } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";

import { dictation, type DictationPhase, insertDictated } from "./dictation";

export type DictationState = "unset" | DictationPhase;

/** One field's hold on the page's recorder: the words go into it at its caret, for the owner to read before sending. */
export function useDictation(field: {
  input: () => HTMLTextAreaElement | HTMLInputElement | undefined;
  value: () => string;
  onValue: (v: string, caret: number) => void;
}) {
  const version = createExternal(dictation.subscribe, () => dictation.version);
  const me = {};
  onSettled(() => () => dictation.release(me));
  // Unknown until the settings are read; the server says what is missing then.
  const settings = useSettings();
  const router = useRouter();
  const off = () => ready(settings, undefined)?.dictationReady === false;
  const toggle = () =>
    // Like an event handler, it reads the field as it is when the words come.
    void dictation.toggle(me, (words) => {
      const el = field.input();
      const now = field.value();
      const start = el?.selectionStart ?? now.length;
      const end = el?.selectionEnd ?? now.length;
      const next = insertDictated(now, start, end, words);
      field.onValue(next.value, next.caret);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(next.caret, next.caret);
      });
    });
  return {
    state: (): DictationState => (off() ? "unset" : (version(), dictation.phase)),
    /** This field started what is going on now. */
    mine: () => (version(), dictation.owns(me)),
    problem: () => (version(), dictation.problemFor(me)),
    toggle,
    done: () => dictation.done(me),
    cancel: () => dictation.cancel(me),
    dismiss: () => dictation.dismiss(),
    setUp: () => router.navigate("/settings/dictation"),
  };
}

export type Dictating = ReturnType<typeof useDictation>;

/** Held this long, letting go stops it: push to talk. A shorter press leaves it listening until the next. */
const holdMs = 400;

/** Tap to start talking, tap again to stop, or hold to talk and let go; not set up, it opens where it is set. bar: the
 * box shows the recording itself (DictationBar), so the key does not pulse too. */
export function DictationKey(props: { dictating: Dictating; bar?: boolean; size?: IconSize | undefined; class?: string | undefined }) {
  const d = () => props.dictating;
  // The press that started a recording, and whether letting go of it stopped it: its click is then not a tap.
  let pressed: number | undefined;
  let released = false;
  return (
    <DictationMark
      state={d().state()}
      problem={d().problem()}
      bar={props.bar === true}
      size={props.size}
      class={props.class}
      onPointerDown={(e) => {
        if (e.button !== 0 || d().state() !== "idle") return;
        e.currentTarget.setPointerCapture(e.pointerId);
        pressed = performance.now();
        d().toggle();
      }}
      onPointerUp={() => {
        if (pressed === undefined || performance.now() - pressed < holdMs) return;
        pressed = undefined;
        released = true;
        d().done();
      }}
      onClick={() => {
        if (released) return void (released = false);
        // The tap that started it: it keeps listening.
        if (pressed !== undefined) return void (pressed = undefined);
        if (d().state() === "unset") d().setUp();
        else d().toggle();
      }}
    />
  );
}

/** The key on its own, for a box that shows nothing else of it (the farm's chat). */
export function DictationButton(props: {
  field: () => HTMLTextAreaElement | HTMLInputElement | undefined;
  value: string;
  onValue: (v: string, caret: number) => void;
  size?: IconSize;
  class?: string;
}) {
  const dictating = useDictation({ input: () => props.field(), value: () => props.value, onValue: (v, c) => props.onValue(v, c) });
  return <DictationKey dictating={dictating} size={props.size} class={props.class} />;
}

/** The key as it looks in each state, the microphone and the server kept out: what DictationKey draws. */
export function DictationMark(props: {
  state: DictationState;
  problem?: string | undefined;
  /** The box shows the recording (DictationBar): the key is its done, not a pulsing stop. */
  bar?: boolean | undefined;
  size?: IconSize | undefined;
  class?: string | undefined;
  onClick: () => void;
  onPointerDown?: ((e: PointerEvent & { currentTarget: HTMLButtonElement }) => void) | undefined;
  onPointerUp?: (() => void) | undefined;
}) {
  const look = (): [IconName, string] =>
    props.state === "unset"
      ? ["record", t("web.voice.dictation.unset")]
      : props.state === "recording"
        ? [props.bar === true ? "ticked" : "stop", props.bar === true ? t("web.voice.dictation.done") : t("web.voice.dictation.recording")]
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
      disabled={props.state === "transcribing"}
      onClick={() => props.onClick()}
      onPointerDown={(e) => props.onPointerDown?.(e)}
      onPointerUp={() => props.onPointerUp?.()}
      class={[
        "inline-flex shrink-0 cursor-pointer touch-none items-center justify-center p-1 select-none disabled:cursor-default disabled:opacity-50",
        { "text-faint": props.state === "unset" },
        { "animate-pulse bg-berry/12 text-berry": props.state === "recording" && props.bar !== true },
        { "bg-accent hover:bg-accent-hover": props.state === "recording" && props.bar === true },
        props.class,
      ]}
    >
      <Icon name={look()[0]} size={props.size ?? 20} />
    </button>
  );
}

/** How many of the meter's bars, and how often one is added: about four seconds of the voice across. */
const barCount = 56;
const silence: readonly number[] = Array.from({ length: barCount }, () => 0);
const barMs = 70;

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** In a box's row while its field listens or is being transcribed, in place of what else the row holds: how long it
 * has listened, the voice's level running past, and cancel; the key beside it is done (Esc and Enter say the same, see
 * dictationKey). */
export function DictationBar(props: { dictating: Dictating }) {
  const d = () => props.dictating;
  const listening = () => d().state() === "recording";
  // Oldest first; drawn newest at the right, so a narrow box cuts off the oldest.
  const [bars, setBars] = createSignal(silence);
  const [elapsed, setElapsed] = createSignal(0);
  createEffect(listening, (on) => {
    if (!on) return;
    setBars(silence);
    setElapsed(0);
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= barMs) {
        last = now;
        setBars((b) => [...b.slice(1), dictation.level()]);
        setElapsed(dictation.startedAt > 0 ? now - dictation.startedAt : 0);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  });
  return (
    <div data-testid="dictation-bar" data-state={d().state()} class="flex min-w-0 flex-1 items-center gap-2">
      <Show
        when={listening()}
        fallback={
          <span class="flex animate-pulse items-center gap-2 px-1 text-sm text-muted">
            <Icon name="wait" size={14} />
            {t("web.voice.dictation.transcribing")}
          </span>
        }
      >
        <span aria-hidden="true" class="ml-1 size-2 shrink-0 animate-pulse rounded-full bg-berry" />
        <span class="w-9 shrink-0 text-xs text-muted tabular-nums" role="timer" aria-label={t("web.voice.dictation.listening")}>
          {clock(elapsed())}
        </span>
        <span aria-hidden="true" class="mx-1 flex h-5 min-w-0 flex-1 flex-row-reverse items-center justify-between overflow-hidden">
          <For each={bars().toReversed()} keyed={false}>
            {(level) => <span class="w-0.75 shrink-0 rounded-full bg-ink/55" style={{ height: `${Math.max(3, level() * 20)}px` }} />}
          </For>
        </span>
        <span class="hidden shrink-0 text-xs text-faint sm:inline">{t("web.voice.dictation.keys")}</span>
        <button
          type="button"
          data-testid="dictation-cancel"
          onClick={() => d().cancel()}
          aria-label={t("web.voice.dictation.cancel")}
          title={t("web.voice.dictation.cancel")}
          class="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </Show>
    </div>
  );
}

/** Why the field's last recording came to nothing, above the box's row until read or tried again. */
export function DictationProblem(props: { dictating: Dictating }) {
  const d = () => props.dictating;
  return (
    <Show when={d().problem()}>
      {(why) => (
        <div data-testid="dictation-problem" role="status" class="mx-2 mb-1 flex items-center gap-2 rounded-md bg-hover px-2 py-1 text-xs">
          <Icon name="warn" size={14} />
          <span class="min-w-0 flex-1 truncate text-muted" title={why()}>
            {why()}
          </span>
          <button type="button" class="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-medium text-ink hover:bg-page" onClick={() => d().toggle()}>
            {t("web.voice.dictation.again")}
          </button>
          <button
            type="button"
            class="shrink-0 cursor-pointer rounded p-0.5 text-muted hover:bg-page hover:text-ink"
            aria-label={t("web.voice.dictation.dismiss")}
            title={t("web.voice.dictation.dismiss")}
            onClick={() => d().dismiss()}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
    </Show>
  );
}

/** What a box's key does while its field listens: Esc drops the recording, Enter stops it and fills in the words. Gives
 * true when it took the key. */
export function dictationKey(d: Dictating, e: KeyboardEvent): boolean {
  if (e.isComposing || !d.mine() || d.state() !== "recording") return false;
  if (e.key === "Escape") d.cancel();
  else if (e.key === "Enter" && !e.shiftKey) d.done();
  else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}
