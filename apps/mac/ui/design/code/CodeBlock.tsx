// Fenced code block backed by native Rust `vibevalley/rich` (`VvCodeBlock` via
// vibevalley-shiki + vibevalley-onig), with a lightweight `<Text>` fallback for
// stock `nsh test` (zero `<Editor readOnly>`).
import { cleanup, Clipboard, computed, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { useDesignHost, type DesignCodeCopyEvent } from "../host";
import { Icon } from "../Icon";
import { mix } from "../tone";

const defaultFoldLines = 16;

function useTimeout(): (fn: () => void, ms: number) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(timer));
  return (fn, ms) => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

export interface CodeBlockProps {
  code: string;
  language?: string | undefined;
  foldLines?: number;
  selectable?: boolean;
  wrap?: boolean;
  onCopy?: (event: DesignCodeCopyEvent) => void;
  class?: string | undefined;
}

export function CodeBlock(props: CodeBlockProps) {
  const native = useDesignHost().rich();
  if (native) {
    const VvCodeBlock = native.VvCodeBlock;
    return (
      <VvCodeBlock
        code={props.code}
        language={props.language ?? null}
        foldLines={props.foldLines}
        selectable={props.selectable}
        wrap={props.wrap}
        onCopy={props.onCopy}
        class={props.class}
      />
    );
  }
  return <CodeBlockFallback {...props} />;
}

function CodeBlockFallback(props: CodeBlockProps) {
  const foldAt = () => props.foldLines ?? defaultFoldLines;
  const lines = computed(() => props.code.split("\n").length);
  const folded = signal(true);
  const copied = signal(false);
  const later = useTimeout();
  const long = computed(() => foldAt() > 0 && lines() > foldAt());
  const copy = () => {
    const code = props.code;
    const language = props.language ?? null;
    void Clipboard.writeText(code).then(() => {
      copied.set(true);
      props.onCopy?.({ code, language });
      later(() => copied.set(false), 1500);
    });
  };
  return (
    <View testID="code-block" class={`my-2 rounded-md ${props.class ?? ""}`} style={{ backgroundColor: mix("ink", 0.06) }}>
      <View class="flex-row items-center gap-2 pt-1 pr-1 pl-3">
        <Text class="flex-1 font-mono text-2xs text-muted">{props.language || t("web.base.rich.lines", { n: lines() })}</Text>
        <View
          role="button"
          testID="code-copy"
          accessibilityLabel={copied() ? t("web.base.rich.copied") : t("web.base.rich.copy")}
          onPress={copy}
          class="rounded-sm p-1 hover:bg-hover"
        >
          <Icon name={copied() ? "check" : "copy"} size={14} tone="muted" />
        </View>
      </View>
      <View class="overflow-hidden px-3 pb-3" style={long() && folded() ? { maxHeight: foldAt() * 18 } : undefined}>
        <Scroll horizontal={props.wrap !== true}>
          <Text class="font-mono text-xs text-ink">{props.code}</Text>
        </Scroll>
      </View>
      <If when={long()}>
        <View class="flex-row px-2 pb-1">
          <View
            role="button"
            testID="code-more"
            accessibilityState={{ expanded: !folded() }}
            onPress={() => folded.set(!folded())}
            class="rounded-sm px-1.5 hover:bg-hover"
          >
            <Text class="text-xs text-muted">{folded() ? t("web.base.rich.more") : t("web.base.rich.less")}</Text>
          </View>
        </View>
      </If>
    </View>
  );
}
