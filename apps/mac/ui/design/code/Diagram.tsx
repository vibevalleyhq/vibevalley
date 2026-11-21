// Mermaid diagram view backed by native Rust `vibevalley/rich` (`VvDiagram` via
// vibevalley-pele + ImageSrc::svg_markup), with a clean text fallback for stock `nsh test`.
import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { richNative } from "../../infra/rich";

export interface DiagramProps {
  source: string;
  maxWidth?: number;
  class?: string | undefined;
}

export function Diagram(props: DiagramProps) {
  const native = richNative();
  if (native) {
    const VvDiagram = native.VvDiagram;
    return <VvDiagram source={props.source} maxWidth={props.maxWidth ?? null} class={props.class} />;
  }
  return (
    <View
      testID="diagram"
      accessibilityLabel={t("web.base.rich.diagram")}
      class={`my-2 max-w-full rounded-md border border-line bg-side p-3 ${props.class ?? ""}`}
    >
      <Text class="font-mono text-xs text-muted">{props.source}</Text>
    </View>
  );
}
