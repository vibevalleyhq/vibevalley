import { keymap, PanResponder, signal, untracked, View, type ViewRef } from "nsh";

export interface SliderProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly testid?: string;
  readonly class?: string;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function snap(v: number, min: number, max: number, step: number | undefined): number {
  const clamped = clamp(v, min, max);
  if (step === undefined || step <= 0) return clamped;
  const steps = Math.round((clamped - min) / step);
  const precision = Math.max(0, (String(step).split(".")[1] ?? "").length);
  return clamp(Number((min + steps * step).toFixed(precision)), min, max);
}

/** Native nsh range slider backed by PanResponder + View using theme.json tokens. */
export function Slider(props: SliderProps) {
  const dragging = signal(false);
  const focused = signal(false);
  const trackWidth = signal(0);
  let trackRef: ViewRef | undefined;
  let trackLeft = 0;
  let trackSpan = 0;

  const span = () => Math.max(0, props.max - props.min);
  const ratio = () => {
    const s = span();
    return s <= 0 ? 0 : clamp((props.value - props.min) / s, 0, 1);
  };

  const emitAtX = (pageX: number) => {
    const w = trackSpan || untracked(trackWidth);
    if (w <= 0) return;
    const nextRatio = clamp((pageX - trackLeft) / w, 0, 1);
    const next = snap(props.min + nextRatio * span(), props.min, props.max, props.step);
    if (next !== untracked(() => props.value)) props.onChange(next);
  };

  const refreshBounds = (after?: () => void) => {
    void trackRef?.measure().then(
      (measured) => {
        if (measured) {
          trackLeft = measured.pagePosition.x;
          trackSpan = measured.bounds.size.width;
          after?.();
        }
      },
      () => {},
    );
  };

  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => props.disabled !== true,
    onMoveShouldSetPanResponder: () => props.disabled !== true,
    onPanResponderGrant: (_e, g) => {
      if (props.disabled === true) return;
      dragging.set(true);
      if (trackSpan > 0) emitAtX(g.x0);
      refreshBounds(() => emitAtX(g.x0));
    },
    onPanResponderMove: (_e, g) => {
      if (props.disabled === true) return;
      emitAtX(g.moveX);
    },
    onPanResponderRelease: () => dragging.set(false),
    onPanResponderTerminate: () => dragging.set(false),
  });

  const nudge = (dir: -1 | 1) => {
    if (!focused() || props.disabled === true) return false;
    const step = props.step ?? (span() > 0 ? span() / 100 : 1);
    const next = snap(untracked(() => props.value) + dir * step, props.min, props.max, props.step);
    if (next !== untracked(() => props.value)) props.onChange(next);
    return true;
  };

  keymap.bind({ left: () => nudge(-1), right: () => nudge(1) }, { passThrough: true });

  const thumbSize = 14;
  const thumbLeft = () => Math.round(ratio() * Math.max(0, trackWidth() - thumbSize));
  const fillWidth = () => (trackWidth() > 0 ? Math.round(thumbLeft() + thumbSize / 2) : 0);

  return (
    <View
      ref={(r) => {
        trackRef = r;
      }}
      {...pan.panHandlers}
      role="adjustable"
      testID={props.testid}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      accessibilityValue={{ now: props.value, min: props.min, max: props.max }}
      focusable={props.disabled !== true}
      onFocus={() => focused.set(true)}
      onBlur={() => focused.set(false)}
      onLayout={(e) => {
        trackWidth.set(e.bounds.size.width);
        refreshBounds();
      }}
      class={`group relative h-6 min-w-20 justify-center rounded-full ${props.disabled === true ? "opacity-50" : ""} ${props.class ?? ""}`}
      style={{ cursor: props.disabled === true ? "default" : "pointer" }}
    >
      <View class="h-1.5 w-full overflow-hidden rounded-full bg-selected">
        <View class="h-full rounded-full bg-accent" style={{ width: fillWidth() }} />
      </View>
      <View
        class={[
          "absolute size-3.5 rounded-full border-2 bg-page shadow-raise transition duration-120 ease-out",
          props.disabled === true ? "border-idle" : dragging() || focused() ? "border-focus" : "border-accent group-hover:border-focus",
          focused() ? "outline-2 outline-focus" : "",
        ].join(" ")}
        style={{ left: thumbLeft(), top: 5 }}
      />
    </View>
  );
}
