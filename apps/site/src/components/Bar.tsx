/** @jsxImportSource @solidjs/web */
import * as stylex from "@stylexjs/stylex";
import { createSignal } from "solid-js";

import { createScrollPosition } from "../animation/scroll";
import type { Copy } from "../i18n/zh";
import { cx } from "./ui";

const viewStyles = stylex.create({
  barImg: {
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
  },
  barNav: {
    marginLeft: "auto",
    display: "flex",
    gap: "calc(var(--spacing) * 5)",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-lg)",
    lineHeight: "1",
  },
  barA: {
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-cream-50)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-lg)",
    lineHeight: "1",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-50)",
      },
    },
    color: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-bark-900)",
      },
    },
  },
});

interface Props {
  copy: Pick<Copy, "home" | "title" | "nav" | "other"> & { name: string };
  github: string;
}

export default function Bar(props: Props) {
  const [solid, setSolid] = createSignal(false);
  createScrollPosition((y) => setSolid(y > (document.getElementById("top")?.offsetHeight ?? innerHeight) - 80));
  return (
    <header
      class={cx(
        "fixed inset-x-0 top-0 z-20 flex items-center gap-6 px-[clamp(16px,4vw,40px)] py-3 text-cream-50 transition-[background-color,box-shadow] duration-300 ease-[steps(3)]",
        solid() && "bg-bark-900/92 shadow-[0_2px_0_var(--color-bark-900)]",
      )}
    >
      <a class="text-shadow-soft flex items-center gap-2.5 font-pixel text-2xl/none" href={props.copy.home}>
        <img src="/gen/icon-64.png" alt="" width="32" height="32" {...stylex.attrs(viewStyles.barImg)} />
        {props.copy.name}
      </a>
      <nav aria-label={props.copy.title} {...stylex.attrs(viewStyles.barNav)}>
        {(["how", "features", "screens", "start"] as const).map((id) => (
          <a href={`#${id}`} class="text-shadow-soft hidden border-b-2 border-transparent py-1 hover:border-wheat min-[860px]:block">
            {props.copy.nav[id]}
          </a>
        ))}
        <a href={props.github} class="text-shadow-soft border-b-2 border-transparent py-1 hover:border-wheat">
          {props.copy.nav.github}
        </a>
      </nav>
      <a
        {...stylex.attrs(viewStyles.barA)}
        href={props.copy.other.href}
        hreflang={props.copy.other.href === "/" ? "zh-CN" : "en"}
        lang={props.copy.other.href === "/" ? "zh-CN" : "en"}
      >
        {props.copy.other.label}
      </a>
    </header>
  );
}
