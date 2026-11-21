// Interactive generative UI view backed by native Rust `vibevalley/rich` (`VvGenUi`
// via vibevalley-genui + native nsh elements), with a clean fallback for stock `nsh test`.
import { Text, View } from "nsh";

import { richNative, type VvGenUiActionEvent } from "../rich/native";

export interface GenUiProps {
  spec: string;
  streaming?: boolean;
  onAction?: (event: VvGenUiActionEvent) => void;
  class?: string | undefined;
}

export function GenUi(props: GenUiProps) {
  const native = richNative();
  if (native) {
    const VvGenUi = native.VvGenUi;
    return <VvGenUi spec={props.spec} streaming={props.streaming} onAction={props.onAction} class={props.class} />;
  }
  return (
    <View testID="genui" accessibilityLabel="GenUI" class={`my-2 max-w-full rounded-md border border-line bg-side p-3 ${props.class ?? ""}`}>
      <Text class="font-mono text-xs text-muted">{props.spec}</Text>
    </View>
  );
}
