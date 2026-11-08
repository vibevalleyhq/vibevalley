import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmTransclusion } from "@vibevalley/protocol";

import { Link as A } from "#/infra/router.ts";

import { type Piece, piecesOf } from "./outline";
import { pkmHref } from "./vault";

const recipeStyles = stylex.create({
  bodyA: {
    color: "var(--wb-water)",
    textDecorationLine: "underline",
    WebkitTextDecorationColor: {
      default: "var(--wb-water)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-water) 25%, transparent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-water)",
      },
    },
    textDecorationColor: {
      default: "var(--wb-water)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-water) 25%, transparent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-water)",
      },
    },
    textUnderlineOffset: "3px",
  },
  bodyMark: {
    backgroundColor: "transparent",
    color: "var(--wb-ink)",
    textDecorationLine: "underline",
    WebkitTextDecorationColor: {
      default: "var(--wb-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-wheat) 70%, transparent)",
    },
    textDecorationColor: {
      default: "var(--wb-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-wheat) 70%, transparent)",
    },
    textUnderlineOffset: "3px",
  },
  bodySpan: {
    textDecorationLine: "underline",
    WebkitTextDecorationColor: {
      default: "var(--wb-faint)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-faint) 50%, transparent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-faint)",
      },
    },
    textDecorationColor: {
      default: "var(--wb-faint)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-faint) 50%, transparent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-faint)",
      },
    },
    textDecorationStyle: "dotted",
    textUnderlineOffset: "3px",
  },
  bodySpanVariant1Case1: {
    color: null,
  },
  bodySpanVariant1Case2: {
    color: "var(--wb-berry)",
  },
});

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
            {...stylex.attrs(recipeStyles.bodyA)}
            onClick={(e: MouseEvent) => e.stopPropagation()}
          >
            {p.text}
          </A>
        );
      case "remark":
        return (
          <mark data-testid="pkm-remark" title={p.remark} {...stylex.attrs(recipeStyles.bodyMark)}>
            {p.text}
          </mark>
        );
      case "ref": {
        const ref = props.refs.find((x) => x.block === p.id);
        return (
          <span
            data-testid="pkm-ref"
            title={ref?.pageTitle ? t("web.pkm.page.refFrom", { page: ref.pageTitle }) : undefined}
            {...stylex.attrs(recipeStyles.bodySpan, ref?.found === false ? recipeStyles.bodySpanVariant1Case2 : recipeStyles.bodySpanVariant1Case1)}
          >
            {ref?.body ?? t("web.pkm.page.missingRef")}
          </span>
        );
      }
    }
  };
  const size = () => {
    const level = heading()?.[1]?.length;
    return level === 1 ? "text-lg font-semibold" : level === 2 ? "text-base font-semibold" : level === 3 ? "font-semibold" : "";
  };
  return (
    <span class={["whitespace-pre-wrap", size()]}>
      <For each={piecesOf(shown())}>{(p) => drawn(p)}</For>
    </span>
  );
}
