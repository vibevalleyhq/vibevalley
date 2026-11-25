// Mermaid diagram view backed by native Rust `vibevalley/rich` (`VvDiagram` via
// vibevalley-pele + ImageSrc::svg_markup), with a clean text fallback for stock `nsh test`.
import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { richNative, type VvDiagramPressEvent } from "../../infra/rich";
import { Icon } from "../Icon";

export interface DiagramProps {
  source: string;
  maxWidth?: number;
  interactive?: boolean;
  onPress?: (event: VvDiagramPressEvent) => void;
  class?: string | undefined;
}

export function Diagram(props: DiagramProps) {
  const native = richNative();
  if (native) {
    const VvDiagram = native.VvDiagram;
    return (
      <VvDiagram source={props.source} maxWidth={props.maxWidth ?? null} interactive={props.interactive === true} onPress={props.onPress} class={props.class} />
    );
  }
  const triggerPress = () => props.onPress?.({ source: props.source });
  return (
    <If
      when={props.interactive === true}
      else={
        <View
          testID="diagram"
          accessibilityLabel={t("web.base.rich.diagram")}
          class={`my-2 max-w-full rounded-md border border-line bg-side p-3 ${props.class ?? ""}`}
          style={props.maxWidth !== undefined ? { maxWidth: props.maxWidth } : undefined}
        >
          <Text class="font-mono text-xs text-muted">{props.source}</Text>
        </View>
      }
    >
      <View
        testID="diagram"
        accessibilityLabel={t("web.base.rich.diagram")}
        class={`my-2 max-w-full overflow-hidden rounded-md border border-line bg-side ${props.class ?? ""}`}
        style={{ maxHeight: 320, ...(props.maxWidth !== undefined ? { maxWidth: props.maxWidth } : {}) }}
      >
        <View class="flex-row items-center justify-between gap-2 border-b border-line px-3 py-1.5">
          <Text class="font-mono text-2xs text-muted">mermaid</Text>
          <View
            role="button"
            testID="diagram-expand"
            accessibilityLabel={t("web.base.rich.expand")}
            onPress={triggerPress}
            class="flex-row items-center gap-1 rounded-sm px-1.5 py-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Icon name="enlarge" size={11} tone="muted" />
            <Text class="text-2xs text-muted">{t("web.base.rich.expand")}</Text>
          </View>
        </View>
        <View role="button" testID="diagram-preview" accessibilityLabel={t("web.base.rich.diagram")} onPress={triggerPress} class="p-3 hover:bg-hover">
          <Text class="font-mono text-xs text-muted">{props.source}</Text>
        </View>
      </View>
    </If>
  );
}
