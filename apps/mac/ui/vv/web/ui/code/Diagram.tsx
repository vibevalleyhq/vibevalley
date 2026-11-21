// Ported from VibeValley apps/web/src/ui/richText.ts's diagram: a Mermaid
// block drawn by Pele (the same renderer). Pele's SVG is themed by CSS
// variables, which an image does not read: they are put in as the theme's
// colours (style.css's .diagram mapping) and the SVG shown as an Image.
// While it is drawn, or when it cannot be, the source stays, with why. Not
// here: pan and zoom (mountAsync's, a DOM's).
import { Clipboard, colorScheme, Image, signal, Text, View } from "nsh";
import { renderAsync } from "pele/lazy";

import { t } from "@vibevalley/i18n";

import { createEffect } from "../../../solid";
import { messageOf } from "../../base/format";
import { Icon } from "../Icon";
import { Bubble } from "../Tip";
import { mix, tone } from "../tone";
import { CodeBlock } from "./CodeBlock";

const font = "PingFang SC";

/** Pele's variables as style.css's .diagram sets them; the ones it leaves are Pele's own defaults. */
const palette = (): Record<string, string> => ({
  bg: tone("page"),
  fg: tone("ink"),
  m: tone("muted"),
  l: tone("muted"),
  s: tone("side"),
  a: tone("hover"),
  b: tone("faint"),
  c: tone("accent"),
  r: "6",
  fm: "Menlo",
});

/** The SVG with its variables resolved, for a renderer without CSS. */
function inlineSvg(svg: string, colors: Record<string, string>): string {
  return svg
    .replace(/style="rx:var\(--_r\)"/gu, `rx="${colors.r}"`)
    .replace(/var\(--_([a-z]+)\)/gu, (whole, name: string) => colors[name] ?? whole)
    .replace(/<svg /u, `<svg font-family="${font}" font-size="16" `);
}

export function Diagram(props: { source: string }) {
  const drawn = signal<{ svg: string; width: number; height: number } | undefined>(undefined);
  const failed = signal<string | undefined>(undefined);
  const showSource = signal(false);
  const errorSourceOpen = signal(true);
  const copied = signal(false);
  let epoch = 0;

  createEffect(
    () => props.source,
    (source) => {
      const id = ++epoch;
      drawn.set(undefined);
      failed.set(undefined);
      void renderAsync(source, { fontFamily: font })
        .then((r) => {
          if (id === epoch) drawn.set({ svg: r.svg, width: r.width, height: r.height });
        })
        .catch((e: unknown) => {
          if (id === epoch) failed.set(messageOf(e));
        });
    },
  );

  const src = () => {
    const d = drawn();
    // Read so that a change of scheme draws it again in the other colours.
    colorScheme();
    return d ? `data:image/svg+xml;utf8,${encodeURIComponent(inlineSvg(d.svg, palette()))}` : "";
  };

  const copySource = () => {
    void Clipboard.writeText(props.source).then(() => {
      copied.set(true);
      setTimeout(() => copied.set(false), 1500);
    });
  };

  return (
    <View testID="diagram" accessibilityLabel={t("web.base.rich.diagram")} class="my-2 max-w-full">
      <If
        when={drawn()}
        else={
          <If when={failed()} else={<CodeBlock code={props.source} language="mermaid" />}>
            <View class="gap-1.5">
              <View class="flex-row items-start gap-2 rounded-md border bg-bad-soft px-3 py-2" style={{ borderColor: mix("berry", 0.25) }}>
                <View class="mt-0.5 shrink-0">
                  <Icon name="cross" size={12} />
                </View>
                <Text testID="diagram-error" class="min-w-0 flex-1 text-xs font-medium text-berry">
                  {t("web.base.rich.diagramFailed", { why: failed() ?? "" })}
                </Text>
                <View
                  role="button"
                  accessibilityLabel={errorSourceOpen() ? t("web.base.rich.less") : t("web.base.rich.more")}
                  accessibilityState={{ expanded: errorSourceOpen() }}
                  tooltip={<Bubble text={errorSourceOpen() ? t("web.base.rich.less") : t("web.base.rich.more")} />}
                  onPress={() => errorSourceOpen.set(!errorSourceOpen())}
                  class="h-6 shrink-0 flex-row items-center gap-1 rounded-sm px-1.5 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
                >
                  <View
                    class="h-3.5 w-3.5 items-center justify-center transition-transform duration-120 ease-out"
                    style={{ transform: [{ rotate: errorSourceOpen() ? "90deg" : "0deg" }] }}
                  >
                    <Icon name="expand" size={10} tone="berry" />
                  </View>
                  <Text class="text-2xs font-medium text-berry">{errorSourceOpen() ? t("web.base.rich.less") : t("web.base.rich.more")}</Text>
                </View>
              </View>
              <If when={errorSourceOpen()}>
                <CodeBlock code={props.source} language="mermaid" />
              </If>
            </View>
          </If>
        }
      >
        {(d) => (
          <View class="overflow-hidden rounded-md border border-line bg-page">
            <View class="flex-row items-center justify-between gap-2 border-b border-line bg-side px-3 py-1.5">
              <View class="flex-row items-center gap-2">
                <View class="rounded-xs bg-hover px-1.5 py-px">
                  <Text class="font-mono text-2xs font-medium text-ink">mermaid</Text>
                </View>
                <Text class="text-2xs text-faint">{t("web.base.rich.diagram")}</Text>
              </View>
              <View class="flex-row items-center gap-1">
                <View
                  role="button"
                  accessibilityLabel={showSource() ? t("web.base.rich.less") : t("web.base.rich.more")}
                  accessibilityState={{ expanded: showSource() }}
                  tooltip={<Bubble text={showSource() ? t("web.base.rich.less") : t("web.base.rich.more")} />}
                  onPress={() => showSource.set(!showSource())}
                  class="h-6 flex-row items-center gap-1 rounded-sm px-1.5 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover active:translate-y-px"
                >
                  <View
                    class="h-3.5 w-3.5 items-center justify-center transition-transform duration-120 ease-out"
                    style={{ transform: [{ rotate: showSource() ? "90deg" : "0deg" }] }}
                  >
                    <Icon name="expand" size={10} tone="muted" />
                  </View>
                  <Text class="text-2xs font-medium text-muted">{showSource() ? t("web.base.rich.less") : t("web.base.rich.more")}</Text>
                </View>
                <View
                  role="button"
                  accessibilityLabel={copied() ? t("web.base.rich.copied") : t("web.base.rich.copy")}
                  tooltip={<Bubble text={copied() ? t("web.base.rich.copied") : t("web.base.rich.copy")} />}
                  onPress={copySource}
                  class="h-6 flex-row items-center gap-1 rounded-sm px-1.5 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover active:translate-y-px"
                >
                  <Icon name={copied() ? "check" : "copy"} size={12} tone="muted" />
                </View>
              </View>
            </View>
            <View class="items-center justify-center bg-page p-4">
              <Image
                role="image"
                accessible
                accessibilityLabel={t("web.base.rich.diagram")}
                src={src()}
                style={{ width: d().width, maxWidth: "100%", aspectRatio: d().width / d().height }}
              />
            </View>
            <If when={showSource()}>
              <View class="border-t border-line bg-side px-3 py-2.5">
                <Text class="font-mono text-xs text-ink" style={{ userSelect: "text" }}>
                  {props.source}
                </Text>
              </View>
            </If>
          </View>
        )}
      </If>
    </View>
  );
}
