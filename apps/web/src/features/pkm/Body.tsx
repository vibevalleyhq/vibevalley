import type { JSX } from "@solidjs/web";
import { For } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmTransclusion } from "@vibevalley/protocol";

import { Link as A } from "#/infra/router.ts";

import { type Piece, piecesOf } from "./outline";
import { pkmHref } from "./vault";

/** refs: the read-out ((refs)) of the page and of the blocks shown with it. */
export function Body(props: { text: string; refs: readonly PkmTransclusion[] }) {
  const heading = () => /^(#{1,3})\s/u.exec(props.text);
  const shown = () => props.text.slice(heading()?.[0].length ?? 0);
  const drawn = (p: Piece): JSX.Element => {
    switch (p.kind) {
      case "text":
        return <>{p.text}</>;
      case "link":
      case "tag":
        return (
          <A
            href={pkmHref(p.page)}
            data-testid="pkm-link"
            // A hairline under it, not colour alone, tells it from the words around it (in the dark theme the colours are
            // too close); full under the pointer.
            class="text-water underline decoration-water/25 hover:decoration-water underline-offset-3"
            onClick={(e: MouseEvent) => e.stopPropagation()}
          >
            {p.text}
          </A>
        );
      case "remark":
        return (
          <mark data-testid="pkm-remark" title={p.remark} class="bg-transparent text-ink underline decoration-wheat/70 underline-offset-3">
            {p.text}
          </mark>
        );
      case "ref": {
        const ref = props.refs.find((x) => x.block === p.id);
        return (
          <span
            data-testid="pkm-ref"
            title={ref?.pageTitle ? t("web.pkm.page.refFrom", { page: ref.pageTitle }) : undefined}
            class={["underline decoration-faint/50 hover:decoration-faint decoration-dotted underline-offset-3", ref?.found === false ? "text-berry" : ""]}
          >
            {ref?.body ?? t("web.pkm.page.missingRef")}
          </span>
        );
      }
    }
  };
  const size = () => {
    const level = heading()?.[1]?.length;
    return level === 1 ? "text-lg font-semibold" : level === 2 ? "text-base font-semibold" : level === 3 ? "font-semibold" : undefined;
  };
  return (
    <span class={["whitespace-pre-wrap", size()]}>
      <For each={piecesOf(shown())}>{(p) => drawn(p)}</For>
    </span>
  );
}
