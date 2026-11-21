// Ported from VibeValley apps/web/src/ui/Splitter.tsx: the same widths kept
// per pane in the prefs. The drag is a pan gesture (PanResponder) rather
// than pointer capture; a double press puts the default back; the arrow
// keys move it 16 points while it has the focus.
import { keymap, PanResponder, signal, untracked, View, type Accessor } from "nsh";

import { setWidth, usePrefs } from "../state/prefs";

/** A pane's width: the one the user dragged it to on this machine, else its default, kept between min and max. */
export function usePaneWidth(pane: string, fallback: number, min: number, max: number): Accessor<number> {
  const kept = usePrefs((p) => p.widths[pane]);
  return () => Math.min(max, Math.max(min, kept() ?? fallback));
}

/** A pane's edge the user drags to set its width (docs/design/05-audiovisual-and-artifacts.md). side: the edge it is on, so dragging outward widens the pane. */
export function Splitter(props: { pane: string; side: "left" | "right"; width: number; min: number; max: number; label: string }) {
  const dragging = signal(false);
  const focused = signal(false);
  const sign = () => (props.side === "left" ? -1 : 1);
  const to = (w: number) => setWidth(props.pane, Math.round(Math.min(props.max, Math.max(props.min, w))));
  let start = 0;
  let lastPress = 0;
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      start = untracked(() => props.width);
      dragging.set(true);
      const now = Date.now();
      if (now - lastPress < 300) setWidth(props.pane, undefined);
      lastPress = now;
    },
    onPanResponderMove: (_e, g) => to(start + sign() * g.dx),
    onPanResponderRelease: () => dragging.set(false),
    onPanResponderTerminate: () => dragging.set(false),
  });
  keymap.bind(
    {
      left: () => focused() && to(untracked(() => props.width) - 16 * sign()),
      right: () => focused() && to(untracked(() => props.width) + 16 * sign()),
    },
    { passThrough: true },
  );
  return (
    <View
      {...pan.panHandlers}
      role="adjustable"
      testID={`splitter-${props.pane}`}
      accessibilityLabel={props.label}
      accessibilityValue={{ now: props.width, min: props.min, max: props.max }}
      focusable
      onFocus={() => focused.set(true)}
      onBlur={() => focused.set(false)}
      class={`group absolute top-0 bottom-0 z-10 w-2 cursor-col-resize items-center ${props.side === "left" ? "-left-1" : "-right-1"}`}
    >
      <View
        class={`h-full w-0.5 rounded-full transition duration-120 ease-out ${dragging() || focused() ? "bg-focus" : "bg-transparent group-hover:bg-focus"}`}
      />
    </View>
  );
}
