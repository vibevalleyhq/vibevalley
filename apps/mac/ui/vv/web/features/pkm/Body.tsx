// Ported from VibeValley apps/web/src/features/pkm/Body.tsx: a block's words
// with its links, tags, remarks, inline Markdown, fenced code blocks and
// read-out ((refs)). A link's or copy button's press does not reach the block
// under it (nsh gives the press to the innermost pressable).
import { Clipboard, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { PkmTransclusion } from "@vibevalley/protocol";

import { hostApi } from "../../../../bridge";
import { useRouter } from "../../infra/router";
import { Icon } from "../../ui/Icon";
import { Bubble } from "../../ui/Tip";
import { toast } from "../../ui/toasts";
import { mix, tone } from "../../ui/tone";
import { type BodySegment, fencedCode, headingOf, type Piece, piecesOf } from "./outline";
import { pkmHref } from "./vault";

/** Inline formatting inside a clickable ((ref)) without nesting inner links or recursive refs. */
function drawRefBody(body: string) {
  return piecesOf(body).map((piece) => {
    switch (piece.kind) {
      case "code":
        return (
          <Text class="font-mono text-xs text-ink" style={{ backgroundColor: tone("hover") }}>
            {piece.text}
          </Text>
        );
      case "bold":
        return <Text class="font-semibold">{piece.text}</Text>;
      case "italic":
        return <Text class="italic">{piece.text}</Text>;
      case "strike":
        return <Text class="text-muted line-through">{piece.text}</Text>;
      case "text":
      case "link":
      case "tag":
      case "url":
      case "remark":
        return piece.text;
      case "ref":
        return "";
    }
  });
}

/** refs: the read-out ((refs)) of the page and of the blocks shown with it. `class`: the words' size and colour. */
export function Body(props: { text: string; refs: readonly PkmTransclusion[]; class?: string }) {
  const router = useRouter();
  const heading = () => headingOf(props.text);
  const shown = () => props.text.slice(heading()?.prefix ?? 0);
  const segments = () => fencedCode(props.text);
  const drawn = (p: Piece) => {
    switch (p.kind) {
      case "text":
        return p.text;
      case "code":
        return (
          <Text class="font-mono text-xs text-ink" style={{ backgroundColor: tone("hover") }}>
            {p.text}
          </Text>
        );
      case "bold":
        return <Text class="font-semibold">{p.text}</Text>;
      case "italic":
        return <Text class="italic">{p.text}</Text>;
      case "strike":
        return <Text class="text-muted line-through">{p.text}</Text>;
      case "url":
        return (
          <Text
            testID="pkm-url"
            role="link"
            class="text-water underline"
            style={{ textDecorationColor: mix("water", 0.25) }}
            onPress={() => void hostApi.openUrl(p.url)}
          >
            {p.text}
          </Text>
        );
      case "link":
      case "tag":
        return (
          <Text
            testID="pkm-link"
            role="link"
            // A hairline under it, not colour alone, tells it from the words around it.
            class="text-water underline"
            style={{ textDecorationColor: mix("water", 0.25) }}
            onPress={() => router.navigate(pkmHref(p.page))}
          >
            {p.text}
          </Text>
        );
      case "remark":
        return (
          <Text testID="pkm-remark" accessibilityHint={p.remark} class="text-ink underline" style={{ textDecorationColor: mix("wheat", 0.7) }}>
            {p.text}
          </Text>
        );
      case "ref": {
        const ref = props.refs.find((x) => x.block === p.id);
        const target = ref?.found !== false ? ref?.page : undefined;
        return (
          <Text
            testID="pkm-ref"
            role={target ? "link" : undefined}
            accessibilityHint={ref?.pageTitle ? t("web.pkm.page.refFrom", { page: ref.pageTitle }) : undefined}
            class={`underline ${ref?.found === false ? "text-berry" : ""}`}
            style={{ textDecorationColor: mix("faint", 0.5), textDecorationStyle: "dotted" }}
            onPress={target ? () => router.navigate(pkmHref(target, ref?.block)) : undefined}
          >
            {ref?.body !== undefined ? drawRefBody(ref.body) : t("web.pkm.page.missingRef")}
          </Text>
        );
      }
    }
  };
  const lookFor = (level: 1 | 2 | 3 | undefined) => {
    const size = level === 1 ? "text-lg font-semibold" : level === 2 ? "text-base font-semibold" : level === 3 ? "font-semibold" : "";
    // A heading's size takes the place of the size given.
    return size ? `${(props.class ?? "text-ink").replace(/\btext-(2xs|xs|sm|base|lg|xl)\b/u, "")} ${size}` : (props.class ?? "text-sm text-ink");
  };
  const drawSegment = (seg: BodySegment, index: number) => {
    switch (seg.kind) {
      case "text": {
        const h = index === 0 ? headingOf(seg.text) : undefined;
        return <Text class={lookFor(h?.level)}>{piecesOf(seg.text.slice(h?.prefix ?? 0)).map(drawn)}</Text>;
      }
      case "code":
        return (
          <View testID="pkm-code" class="gap-1 rounded-md border border-line px-2.5 py-1.5" style={{ backgroundColor: mix("ink", 0.04) }}>
            <View class="flex-row items-center justify-between gap-2">
              <Text class="font-mono text-2xs text-faint">{seg.lang}</Text>
              <View
                role="button"
                testID="pkm-code-copy"
                accessibilityLabel={t("web.base.rich.copy")}
                tooltip={<Bubble text={t("web.base.rich.copy")} />}
                onPress={() => {
                  void Clipboard.writeText(seg.code);
                  toast(t("web.base.rich.copied"));
                }}
                class="h-5 w-5 items-center justify-center rounded-xs hover:bg-hover"
              >
                <Icon name="copy" size={12} tone="muted" />
              </View>
            </View>
            <Text class="font-mono text-xs text-ink">{seg.code}</Text>
          </View>
        );
    }
  };
  return (
    <If when={segments()} else={<Text class={lookFor(heading()?.level)}>{piecesOf(shown()).map(drawn)}</Text>}>
      {(list) => <View class="gap-1.5">{list().map((seg, i) => drawSegment(seg, i))}</View>}
    </If>
  );
}
