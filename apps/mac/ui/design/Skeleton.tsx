import { computed, effect, signal, View, type ViewStyle } from "nsh";

import { motionClass } from "./motion";

type SkeletonWidth = ViewStyle["width"];

const DEFAULT_WIDTHS: readonly SkeletonWidth[] = ["62%", "84%", "71%", "54%", "78%", "46%"];

/** Delays `true` by `delayMs` (150ms) to avoid flashing placeholders on fast reads; clears immediately. */
export function useDelayedBusy(busy: () => boolean, delayMs = 150): () => boolean {
  const active = computed(busy);
  const shown = signal(false);
  effect(() => {
    if (!active()) {
      shown.set(false);
      return;
    }
    if (delayMs <= 0) {
      shown.set(true);
      return;
    }
    const timer = setTimeout(() => shown.set(true), delayMs);
    return () => clearTimeout(timer);
  });
  return () => shown();
}

export interface SkeletonBarProps {
  readonly class?: string | undefined;
  /** `"side"` uses a stronger fill so bars stay visible on `bg-side`. */
  readonly surface?: "page" | "side" | undefined;
  readonly width?: SkeletonWidth | undefined;
  readonly height?: number | undefined;
  readonly testID?: string | undefined;
}

export function SkeletonBar(props: SkeletonBarProps) {
  const fill = () => (props.surface === "side" ? "bg-selected" : "bg-hover");
  const style = (): ViewStyle | undefined => {
    if (props.width === undefined && props.height === undefined) return undefined;
    return {
      ...(props.width !== undefined ? { width: props.width } : {}),
      ...(props.height !== undefined ? { height: props.height } : {}),
    };
  };
  return <View testID={props.testID} class={`h-3 rounded-sm ${fill()} ${motionClass("animate-pulse")} ${props.class ?? ""}`} style={style()} />;
}

export interface SkeletonLinesProps {
  /** Row count (staggered widths) or explicit per-row widths. */
  readonly rows?: number | readonly SkeletonWidth[] | undefined;
  /** Uniform or per-row left indent (px) for tree skeletons. */
  readonly indent?: number | readonly number[] | undefined;
  readonly gap?: "sm" | "md" | undefined;
  readonly rowHeight?: number | undefined;
  readonly surface?: "page" | "side" | undefined;
  readonly class?: string | undefined;
  readonly testID?: string | undefined;
  readonly accessibilityLabel?: string | undefined;
}

export function SkeletonLines(props: SkeletonLinesProps) {
  const items = () => {
    const raw = props.rows;
    const widths: readonly SkeletonWidth[] =
      typeof raw === "number"
        ? Array.from({ length: Math.max(0, raw) }, (_, i) => DEFAULT_WIDTHS[i % DEFAULT_WIDTHS.length] ?? "70%")
        : (raw ?? DEFAULT_WIDTHS.slice(0, 4));
    return widths.map((width, index) => {
      const padLeft = typeof props.indent === "number" ? props.indent : (props.indent?.[index] ?? 0);
      return { index, width, padLeft };
    });
  };
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ busy: true }}
      class={`${props.gap === "md" ? "gap-2.5" : "gap-1.5"} ${props.class ?? ""}`}
    >
      <Each of={items()} key={(row) => row.index}>
        {(row) => (
          <View style={{ paddingLeft: row().padLeft }}>
            <SkeletonBar surface={props.surface} width={row().width} height={props.rowHeight ?? 12} />
          </View>
        )}
      </Each>
    </View>
  );
}
