// Static JSON Canvas view backed by native Rust `vibevalley/rich` (`VvCanvas` via
// vibevalley-canvas + ImageSrc::svg_markup), with a clean fallback for stock `nsh test`.
import { Text, View } from "nsh";

import { richNative } from "../../infra/rich";

export interface CanvasProps {
  data: string;
  showGrid?: boolean;
  padding?: number;
  class?: string | undefined;
}

export function Canvas(props: CanvasProps) {
  const native = richNative();
  if (native) {
    const VvCanvas = native.VvCanvas;
    return <VvCanvas data={props.data} showGrid={props.showGrid} padding={props.padding} class={props.class} />;
  }
  return (
    <View testID="canvas" accessibilityLabel="Canvas" class={`my-2 max-w-full rounded-md border border-line bg-side p-3 ${props.class ?? ""}`}>
      <Text class="font-mono text-xs text-muted">{props.data}</Text>
    </View>
  );
}
