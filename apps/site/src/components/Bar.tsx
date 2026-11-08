/** @jsxImportSource @solidjs/web */
import * as stylex from "@stylexjs/stylex";
import { createSignal } from "solid-js";

import { createScrollPosition } from "../animation/scroll";
import type { Copy } from "../i18n/zh";

const sceneStyles = stylex.create({
  brand: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2.5)",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-2xl)",
    lineHeight: "1",
    textShadow: "var(--text-shadow-soft)",
  },
  sectionLink: {
    display: {
      default: "none",
      "@media (width>=860px)": "block",
    },
    borderBottomStyle: "solid",
    borderBottomWidth: "2px",
    borderColor: {
      default: "transparent",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-wheat)",
      },
    },
    paddingBlock: "var(--spacing)",
    textShadow: "var(--text-shadow-soft)",
  },
  repositoryLink: {
    borderBottomStyle: "solid",
    borderBottomWidth: "2px",
    borderColor: {
      default: "transparent",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-wheat)",
      },
    },
    paddingBlock: "var(--spacing)",
    textShadow: "var(--text-shadow-soft)",
  },
  header: {
    position: "fixed",
    insetInline: "0",
    top: "0",
    zIndex: 20,
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 6)",
    paddingInline: "clamp(16px,4vw,40px)",
    paddingBlock: "calc(var(--spacing) * 3)",
    color: "var(--color-cream-50)",
    transitionProperty: "background-color,box-shadow",
    transitionTimingFunction: "steps(3,end)",
    transitionDuration: ".3s",
  },
  solid: {
    backgroundColor: {
      default: "var(--color-bar-solid)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-bark-900) 92%, transparent)",
    },
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, 0 2px 0 var(--color-bark-900)",
  },
});

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
    <header {...stylex.attrs(sceneStyles.header, solid() && sceneStyles.solid)}>
      <a {...stylex.attrs(sceneStyles.brand)} href={props.copy.home}>
        <img src="/gen/icon-64.png" alt="" width="32" height="32" {...stylex.attrs(viewStyles.barImg)} />
        {props.copy.name}
      </a>
      <nav aria-label={props.copy.title} {...stylex.attrs(viewStyles.barNav)}>
        {(["how", "features", "screens", "start"] as const).map((id) => (
          <a href={`#${id}`} {...stylex.attrs(sceneStyles.sectionLink)}>
            {props.copy.nav[id]}
          </a>
        ))}
        <a href={props.github} {...stylex.attrs(sceneStyles.repositoryLink)}>
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
