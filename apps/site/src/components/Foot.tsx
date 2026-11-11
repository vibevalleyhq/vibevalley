/** @jsxImportSource @solidjs/web */
import * as stylex from "@stylexjs/stylex";

import type { Copy } from "../i18n/zh";
import { GITHUB } from "../lib/links";

const sceneStyles = stylex.create({
  content: {
    marginInline: "auto",
    display: "flex",
    maxWidth: "1120px",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "1.75rem",
    rowGap: "18px",
  },
  navigation: {
    marginLeft: "auto",
  },
  link: {
    color: "var(--color-cream-50)",
    textDecorationLine: "underline",
  },
});

const viewStyles = stylex.create({
  footFooter: {
    backgroundColor: "var(--color-bark-900)",
    paddingInline: "clamp(16px,5vw,64px)",
    paddingBlock: "2.5rem",
    fontSize: "15px",
    color: "var(--color-cream-100)",
  },
  footSpan: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-2xl)",
    lineHeight: "1",
    color: "var(--color-cream-50)",
  },
  footImg: {
    width: "2.5rem",
    height: "2.5rem",
  },
});

export default function Foot(props: { copy: Copy }) {
  return (
    <footer {...stylex.attrs(viewStyles.footFooter)}>
      <div {...stylex.attrs(sceneStyles.content)}>
        <span {...stylex.attrs(viewStyles.footSpan)}>
          <img src="/gen/icon-64.png" alt="" width="40" height="40" {...stylex.attrs(viewStyles.footImg)} />
          {props.copy.title}
        </span>
        <a href={GITHUB} {...stylex.attrs(sceneStyles.link)}>
          GitHub
        </a>
        <a href={`${GITHUB}/blob/main/LICENSE`} {...stylex.attrs(sceneStyles.link)}>
          {props.copy.footer.license}
        </a>
        <a href="/gen/fusion-pixel-OFL.txt" {...stylex.attrs(sceneStyles.link)}>
          {props.copy.footer.font}
        </a>
        <span {...stylex.attrs(sceneStyles.navigation)}>
          <a href={props.copy.other.href} {...stylex.attrs(sceneStyles.link)}>
            {props.copy.other.name}
          </a>{" "}
          ·{" "}
          <a href="#top" {...stylex.attrs(sceneStyles.link)}>
            {props.copy.footer.top}
          </a>
        </span>
      </div>
    </footer>
  );
}
