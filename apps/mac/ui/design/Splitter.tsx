import { keymap, PanResponder, signal, untracked, View, type Accessor } from "nsh";

import { useDesignHost } from "./host";

/** A pane's width: the one the user dragged it to on this machine, else its default, kept between min and max. */
export function usePaneWidth(pane: string, fallback: number, min: number, max: number): Accessor<number> {
  const designHost = useDesignHost();
  return () => Math.min(max, Math.max(min, designHost.getPrefWidth(pane) ?? fallback));
}

/** side: the edge it is on, so dragging outward widens the pane. */
export function Splitter(props: { pane: string; side: "left" | "right"; width: number; min: number; max: number; label: string }) {
  const designHost = useDesignHost();
  const dragging = signal(false);
  const focused = signal(false);
  const sign = () => (props.side === "left" ? -1 : 1);
  const to = (w: number) => designHost.setPrefWidth(props.pane, Math.round(Math.min(props.max, Math.max(props.min, w))));
  let start = 0;
  let lastPress = 0;
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      start = untracked(() => props.width);
      dragging.set(true);
      const now = Date.now();
      if (now - lastPress < 300) designHost.setPrefWidth(props.pane, undefined);
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
      <View class={`h-full w-0.5 rounded-full ${dragging() || focused() ? "bg-focus" : "bg-transparent group-hover:bg-focus"}`} />
    </View>
  );
}
