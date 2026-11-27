// Data chart view backed by native Rust `vibevalley/rich` (`VvChart` via
// vibevalley-chart + ImageSrc::svg_markup), with a clean fallback for stock `nsh test`.
import { Text, View } from "nsh";

import { useDesignHost } from "../host";

export interface ChartProps {
  spec: string;
  title?: string | undefined;
  class?: string | undefined;
}

export function Chart(props: ChartProps) {
  const native = useDesignHost().rich();
  if (native) {
    const VvChart = native.VvChart;
    return <VvChart spec={props.spec} title={props.title ?? null} class={props.class} />;
  }
  return (
    <View testID="chart" accessibilityLabel={props.title ?? "Chart"} class={`my-2 max-w-full rounded-md border border-line bg-side p-3 ${props.class ?? ""}`}>
      <Text class="font-mono text-xs text-muted">{props.spec}</Text>
    </View>
  );
}
