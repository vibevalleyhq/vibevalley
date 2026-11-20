// Ported from VibeValley apps/web/src/ui/richText.ts's codeBlock: a fenced
// block with its language (or its line count), a copy button, folded past
// sixteen lines. Its colours come from nsh's Editor (read-only, its own
// highlighting) rather than Shiki in a web worker.
import { Clipboard, colorScheme, signal, Text, View } from "nsh";
import { Editor } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../Icon";
import { Bubble } from "../Tip";
import { mix, tone } from "../tone";

const foldLines = 16;
const lineHeight = 18;

export function CodeBlock(props: { code: string; language?: string | undefined }) {
  const lines = () => props.code.split("\n").length;
  const folded = signal(true);
  const copied = signal(false);
  const long = () => lines() > foldLines;
  const remaining = () => Math.max(0, lines() - foldLines);
  const dark = () => colorScheme() === "dark";
  const copy = () => {
    void Clipboard.writeText(props.code).then(() => {
      copied.set(true);
      setTimeout(() => copied.set(false), 1500);
    });
  };
  return (
    <View
      testID="code-block"
      class="my-2 overflow-hidden rounded-md border border-line"
      // Editor follows colorScheme() for syntax tokens: use dark code-bg in dark mode and quiet side surface in light mode for crisp contrast.
      style={{ backgroundColor: dark() ? tone("code-bg") : tone("side") }}
    >
      <View
        class="flex-row items-center justify-between gap-2 border-b border-line px-3 py-1.5"
        style={{ backgroundColor: dark() ? mix("code-ink", 0.05) : mix("ink", 0.04) }}
      >
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <If
            when={props.language}
            else={<Text class="font-mono text-2xs font-medium text-muted tabular-nums">{t("web.base.rich.lines", { n: lines() })}</Text>}
          >
            {(lang) => (
              <>
                <View class="rounded-xs bg-hover px-1.5 py-px">
                  <Text class={`font-mono text-2xs font-medium ${dark() ? "text-code-ink" : "text-ink"}`}>{lang()}</Text>
                </View>
                <Text class="font-mono text-2xs text-faint tabular-nums">{t("web.base.rich.lines", { n: lines() })}</Text>
              </>
            )}
          </If>
        </View>
        <View class="shrink-0 flex-row items-center gap-1">
          <If when={long()}>
            <View
              role="button"
              accessibilityLabel={folded() ? t("web.base.rich.more") : t("web.base.rich.less")}
              accessibilityState={{ expanded: !folded() }}
              tooltip={<Bubble text={folded() ? t("web.base.rich.more") : t("web.base.rich.less")} />}
              onPress={() => folded.set(!folded())}
              class="h-6 flex-row items-center gap-1 rounded-sm px-1.5 transition duration-120 ease-out hover:bg-hover active:translate-y-px"
            >
              <View
                class="h-3.5 w-3.5 items-center justify-center transition-transform duration-120 ease-out"
                style={{ transform: [{ rotate: folded() ? "0deg" : "90deg" }] }}
              >
                <Icon name="expand" size={10} tone="muted" />
              </View>
              <Text class="text-2xs font-medium text-muted">{folded() ? t("web.base.rich.more") : t("web.base.rich.less")}</Text>
            </View>
          </If>
          <View
            role="button"
            testID="code-copy"
            accessibilityLabel={copied() ? t("web.base.rich.copied") : t("web.base.rich.copy")}
            tooltip={<Bubble text={copied() ? t("web.base.rich.copied") : t("web.base.rich.copy")} />}
            onPress={copy}
            class="h-6 flex-row items-center gap-1 rounded-sm px-1.5 transition duration-120 ease-out hover:bg-hover active:translate-y-px"
          >
            <Icon name={copied() ? "check" : "copy"} size={12} tone="muted" />
            <Text class={`text-2xs font-medium ${copied() ? "text-ok-ink" : "text-muted"}`}>
              {copied() ? t("web.base.rich.copied") : t("web.base.rich.copy")}
            </Text>
          </View>
        </View>
      </View>
      <View class="px-3 py-2.5">
        <View class="overflow-hidden" style={long() && folded() ? { maxHeight: foldLines * lineHeight } : undefined}>
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
            class={`bg-transparent ${dark() ? "text-code-ink" : "text-ink"}`}
          />
        </View>
      </View>
      <If when={long()}>
        <View
          role="button"
          testID="code-more"
          accessibilityState={{ expanded: !folded() }}
          onPress={() => folded.set(!folded())}
          class="flex-row items-center justify-center gap-1.5 border-t border-line px-3 py-1.5 transition duration-120 ease-out hover:bg-hover"
          style={{ backgroundColor: dark() ? mix("code-ink", 0.03) : mix("ink", 0.025) }}
        >
          <View
            class="h-3.5 w-3.5 items-center justify-center transition-transform duration-120 ease-out"
            style={{ transform: [{ rotate: folded() ? "0deg" : "180deg" }] }}
          >
            <Icon name="choose" size={10} tone={folded() ? "water" : "muted"} />
          </View>
          <Text class={`text-xs font-medium tabular-nums ${folded() ? "text-water" : "text-muted"}`}>
            {folded()
              ? `${t("web.base.rich.more")} · +${t("web.base.rich.lines", { n: remaining() })}`
              : `${t("web.base.rich.less")} · ${t("web.base.rich.lines", { n: lines() })}`}
          </Text>
        </View>
      </If>
    </View>
  );
}
