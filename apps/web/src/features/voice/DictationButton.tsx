import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createExternal } from "#/base/external.ts";
import { ready, useSettings } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { Icon, type IconSize } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";
import { styleProps } from "#/ui/positioner.ts";

import { dictation, type DictationPhase, insertDictated } from "./dictation";

const recordingPulse = stylex.keyframes({ "50%": { opacity: 0.5 } });

const recipeStyles = stylex.create({
  dictationBarSpan: {
    display: "flex",
    animationName: { default: recordingPulse, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "2s",
    animationDelay: "0s",
    animationTimingFunction: "cubic-bezier(.4, 0, .6, 1)",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  dictationBarSpan2: {
    marginLeft: "var(--spacing)",
    width: "calc(var(--spacing) * 2)",
    height: "calc(var(--spacing) * 2)",
    flexShrink: "0",
    animationName: { default: recordingPulse, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "2s",
    animationDelay: "0s",
    animationTimingFunction: "cubic-bezier(.4, 0, .6, 1)",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
    borderRadius: "2147483647px",
    backgroundColor: "var(--wb-berry)",
  },
});

const variantStyles = stylex.create({
  dictationBarSpan: {
    marginInline: "var(--spacing)",
    display: "flex",
    height: "calc(var(--spacing) * 5)",
    minWidth: "0",
    flex: "1",
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "space-between",
    overflow: "hidden",
  },
});

const viewStyles = stylex.create({
  mark: {
    display: "inline-flex",
    flexShrink: 0,
    cursor: { default: "pointer", ":disabled": "default" },
    touchAction: "none",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--spacing)",
    WebkitUserSelect: "none",
    userSelect: "none",
    opacity: { default: null, ":disabled": 0.5 },
  },
  unset: { color: "var(--color-faint)" },
  recording: {
    color: "var(--color-berry)",
    backgroundColor: {
      default: "var(--color-berry)",
      "@supports (color: color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-berry) 12%, transparent)",
    },
    animationName: { default: recordingPulse, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: { default: "2s", "@media (prefers-reduced-motion: reduce)": "0s" },
    animationTimingFunction: { default: "cubic-bezier(0.4,0,0.6,1)", "@media (prefers-reduced-motion: reduce)": "ease" },
    animationIterationCount: { default: "infinite", "@media (prefers-reduced-motion: reduce)": 1 },
  },
  recordingBar: { backgroundColor: { default: "var(--color-accent)", "@media (hover: hover)": { default: null, ":hover": "var(--color-accent-hover)" } } },
  surface: { backgroundColor: { default: null, "@media (hover: hover)": { default: null, ":hover": "var(--color-hover)" } } },
  recordingSurface: { backgroundColor: { default: "var(--color-accent)", "@media (hover: hover)": { default: null, ":hover": "var(--color-hover)" } } },
  dictationBar: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  dictationBarSpan: {
    width: "calc(var(--spacing) * 9)",
    flexShrink: "0",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
    fontVariantNumeric: "tabular-nums",
  },
  dictationBarSpan2: {
    width: "calc(var(--spacing) * .75)",
    flexShrink: "0",
    borderRadius: "2147483647px",
    backgroundColor: {
      default: "var(--color-ink)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-ink) 55%, transparent)",
    },
  },
  dictationBarSpan3: {
    display: {
      default: "none",
      "@media (width>=40rem)": "inline",
    },
    flexShrink: "0",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-faint)",
  },
  dictationCancel: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
    flexShrink: "0",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  dictationProblem: {
    marginInline: "calc(var(--spacing) * 2)",
    marginBottom: "var(--spacing)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  dictationProblemSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    color: "var(--color-muted)",
  },
  dictationProblemButton: {
    flexShrink: "0",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-ink)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-page)",
      },
    },
  },
  dictationProblemButton2: {
    flexShrink: "0",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    padding: "calc(var(--spacing) * .5)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-page)",
      },
    },
  },
});

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
  const off = () => ready(settings, undefined)?.readiness.dictation.ready === false;
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

/** Tap to start talking, tap again to stop, or hold to talk and let go. not set up, it opens where it is set. */
export function DictationKey(props: { dictating: Dictating; bar?: boolean; surface?: boolean; size?: IconSize | undefined; styles?: stylex.StyleXStyles }) {
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
      styles={props.styles}
      surface={props.surface}
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
  styles?: stylex.StyleXStyles;
}) {
  const dictating = useDictation({ input: () => props.field(), value: () => props.value, onValue: (v, c) => props.onValue(v, c) });
  return <DictationKey dictating={dictating} size={props.size} styles={props.styles} />;
}

/** The key as it looks in each state, the microphone and the server kept out: what DictationKey draws. */
export function DictationMark(props: {
  state: DictationState;
  problem?: string | undefined;
  /** The box shows the recording (DictationBar): the key is its done, not a pulsing stop. */
  bar?: boolean | undefined;
  size?: IconSize | undefined;
  styles?: stylex.StyleXStyles;
  surface?: boolean | undefined;
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
      {...styleProps([
        viewStyles.mark,
        props.state === "unset" && viewStyles.unset,
        props.state === "recording"
          ? props.bar === true
            ? props.surface === true
              ? viewStyles.recordingSurface
              : viewStyles.recordingBar
            : viewStyles.recording
          : props.surface === true && viewStyles.surface,
        props.styles,
      ])}
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

/** In a box's row while its field listens or is being transcribed, in place of what else the row holds. */
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
    <div data-testid="dictation-bar" data-state={d().state()} {...stylex.attrs(viewStyles.dictationBar)}>
      <Show
        when={listening()}
        fallback={
          <span {...stylex.attrs(recipeStyles.dictationBarSpan)}>
            <Icon name="wait" size={14} />
            {t("web.voice.dictation.transcribing")}
          </span>
        }
      >
        <span aria-hidden="true" {...stylex.attrs(recipeStyles.dictationBarSpan2)} />
        <span {...stylex.attrs(viewStyles.dictationBarSpan)} role="timer" aria-label={t("web.voice.dictation.listening")}>
          {clock(elapsed())}
        </span>
        <span aria-hidden="true" {...stylex.attrs(variantStyles.dictationBarSpan)}>
          <For each={bars().toReversed()} keyed={false}>
            {(level) => <span {...stylex.attrs(viewStyles.dictationBarSpan2)} style={{ height: `${Math.max(3, level() * 20)}px` }} />}
          </For>
        </span>
        <span {...stylex.attrs(viewStyles.dictationBarSpan3)}>{t("web.voice.dictation.keys")}</span>
        <button
          type="button"
          data-testid="dictation-cancel"
          onClick={() => d().cancel()}
          aria-label={t("web.voice.dictation.cancel")}
          title={t("web.voice.dictation.cancel")}
          {...stylex.attrs(viewStyles.dictationCancel)}
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
        <div data-testid="dictation-problem" role="status" {...stylex.attrs(viewStyles.dictationProblem)}>
          <Icon name="warn" size={14} />
          <span {...stylex.attrs(viewStyles.dictationProblemSpan)} title={why()}>
            {why()}
          </span>
          <button type="button" {...stylex.attrs(viewStyles.dictationProblemButton)} onClick={() => d().toggle()}>
            {t("web.voice.dictation.again")}
          </button>
          <button
            type="button"
            {...stylex.attrs(viewStyles.dictationProblemButton2)}
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
