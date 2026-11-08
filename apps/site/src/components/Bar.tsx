/** @jsxImportSource @solidjs/web */
import { createSignal } from "solid-js";

import { createScrollPosition } from "../animation/scroll";
import type { Copy } from "../i18n/zh";
import { cx } from "./ui";

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
        <img src="/gen/icon-64.png" alt="" width="32" height="32" class="size-8 border-2 border-bark-900" />
        {props.copy.name}
      </a>
      <nav aria-label={props.copy.title} class="ml-auto flex gap-5 font-pixel text-lg/none">
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
        class="border-2 border-cream-50 px-2.5 py-1.5 font-pixel text-lg/none hover:bg-cream-50 hover:text-bark-900"
        href={props.copy.other.href}
        hreflang={props.copy.other.href === "/" ? "zh-CN" : "en"}
        lang={props.copy.other.href === "/" ? "zh-CN" : "en"}
      >
        {props.copy.other.label}
      </a>
    </header>
  );
}
