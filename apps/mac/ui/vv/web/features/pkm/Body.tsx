import { Text } from "nsh";

import { t } from "@vibevalley/i18n";
import type { PkmTransclusion } from "@vibevalley/protocol";

import { useRouter } from "../../infra/router";
import { mix } from "../../ui/tone";
import { type Piece, piecesOf } from "./outline";
import { pkmHref } from "./vault";

/** refs: the read-out ((refs)) of the page and of the blocks shown with it. `class`: the words' size and colour. */
export function Body(props: { text: string; refs: readonly PkmTransclusion[]; class?: string }) {
  const router = useRouter();
  const heading = () => /^(#{1,3})\s/u.exec(props.text);
  const shown = () => props.text.slice(heading()?.[0].length ?? 0);
  const drawn = (p: Piece) => {
    switch (p.kind) {
      case "text":
        return p.text;
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
        return (
          <Text
            testID="pkm-ref"
            accessibilityHint={ref?.pageTitle ? t("web.pkm.page.refFrom", { page: ref.pageTitle }) : undefined}
            class={`underline ${ref?.found === false ? "text-berry" : ""}`}
            style={{ textDecorationColor: mix("faint", 0.5), textDecorationStyle: "dotted" }}
          >
            {ref?.body ?? t("web.pkm.page.missingRef")}
          </Text>
        );
      }
    }
  };
  const size = () => {
    const level = heading()?.[1]?.length;
    return level === 1 ? "text-lg font-semibold" : level === 2 ? "text-base font-semibold" : level === 3 ? "font-semibold" : "";
  };
  // A heading's size takes the place of the size given.
  const look = () =>
    size() ? `${(props.class ?? "text-ink").replace(/\btext-(2xs|xs|sm|base|lg|xl)\b/u, "")} ${size()}` : (props.class ?? "text-sm text-ink");
  return <Text class={look()}>{piecesOf(shown()).map(drawn)}</Text>;
}
