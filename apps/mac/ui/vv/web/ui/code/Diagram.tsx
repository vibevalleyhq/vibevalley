// Ported from VibeValley apps/web/src/ui/richText.ts's diagram: a Mermaid
// block drawn by Pele (the same renderer). Pele's SVG is themed by CSS
// variables, which an image does not read: they are put in as the theme's
// colours (style.css's .diagram mapping) and the SVG shown as an Image.
// While it is drawn, or when it cannot be, the source stays, with why. Not
// here: pan and zoom (mountAsync's, a DOM's).
import { colorScheme, Image, signal, Text, View } from "nsh";
import { renderAsync } from "pele/lazy";

import { t } from "@vibevalley/i18n";

import { messageOf } from "../../base/format";
import { tone } from "../tone";
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
  b: "#8a8a8a",
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
  void renderAsync(props.source, { fontFamily: font })
    .then((r) => drawn.set({ svg: r.svg, width: r.width, height: r.height }))
    .catch((e: unknown) => failed.set(messageOf(e)));
  const src = () => {
    const d = drawn();
    // Read so that a change of scheme draws it again in the other colours.
    colorScheme();
    return d ? `data:image/svg+xml;utf8,${encodeURIComponent(inlineSvg(d.svg, palette()))}` : "";
  };
  return (
    <View testID="diagram" accessibilityLabel={t("web.base.rich.diagram")} class="my-2 max-w-full">
      <If
        when={drawn()}
        else={
          <View>
            <CodeBlock code={props.source} language="mermaid" />
            <If when={failed()}>
              <Text testID="diagram-error" class="text-xs text-berry">
                {t("web.base.rich.diagramFailed", { why: failed() ?? "" })}
              </Text>
            </If>
          </View>
        }
      >
        {(d) => (
          <Image
            role="image"
            accessible
            accessibilityLabel={t("web.base.rich.diagram")}
            src={src()}
            style={{ width: d().width, maxWidth: "100%", aspectRatio: d().width / d().height }}
          />
        )}
      </If>
    </View>
  );
}
