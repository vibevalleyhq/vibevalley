// Ported from VibeValley apps/web/src/ui/richText.ts's codeBlock: a fenced
// block with its language (or its line count), a copy button, folded past
// sixteen lines. Its colours come from nsh's Editor (read-only, its own
// highlighting) rather than Shiki in a web worker.
import { Clipboard, signal, Text, View } from "nsh";
import { Editor } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../Icon";
import { mix } from "../tone";

const foldLines = 16;
const lineHeight = 18;

export function CodeBlock(props: { code: string; language?: string | undefined }) {
  const lines = () => props.code.split("\n").length;
  const folded = signal(true);
  const copied = signal(false);
  const long = () => lines() > foldLines;
  const copy = () => {
    void Clipboard.writeText(props.code).then(() => {
      copied.set(true);
      setTimeout(() => copied.set(false), 1500);
    });
  };
  return (
    <View testID="code-block" class="my-2 rounded-md" style={{ backgroundColor: mix("ink", 0.06) }}>
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
      <View class="overflow-hidden px-3 pb-3" style={long() && folded() ? { maxHeight: 288 } : undefined}>
        <Editor
          value={props.code}
          language={props.language || undefined}
          readOnly
          lineNumbers={false}
          folding={false}
          activeLine={false}
          indentGuides={false}
          scrollBeyondLastLine={false}
          fontSize={12}
          lineHeight={lineHeight}
          minRows={1}
          class="bg-transparent"
        />
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
