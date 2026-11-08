/** @jsxImportSource @solidjs/web */
import * as stylex from "@stylexjs/stylex";

import type { Copy } from "../i18n/zh";
import { GITHUB } from "../lib/links";

const viewStyles = stylex.create({
  footFooter: {
    backgroundColor: "var(--color-bark-900)",
    paddingInline: "clamp(16px,5vw,64px)",
    paddingBlock: "calc(var(--spacing) * 10)",
    fontSize: "15px",
    color: "var(--color-cream-100)",
  },
  footSpan: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2.5)",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-2xl)",
    lineHeight: "1",
    color: "var(--color-cream-50)",
  },
  footImg: {
    width: "calc(var(--spacing) * 10)",
    height: "calc(var(--spacing) * 10)",
  },
});

export default function Foot(props: { copy: Copy }) {
  return (
    <footer {...stylex.attrs(viewStyles.footFooter)}>
      <div class="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-7 gap-y-[18px] *:[a]:text-cream-50 *:[a]:underline">
        <span {...stylex.attrs(viewStyles.footSpan)}>
          <img src="/gen/icon-64.png" alt="" width="40" height="40" {...stylex.attrs(viewStyles.footImg)} />
          {props.copy.title}
        </span>
        <a href={GITHUB}>GitHub</a>
        <a href={`${GITHUB}/blob/main/LICENSE`}>{props.copy.footer.license}</a>
        <a href="/gen/fusion-pixel-OFL.txt">{props.copy.footer.font}</a>
        <span class="ml-auto *:text-cream-50 *:underline">
          <a href={props.copy.other.href}>{props.copy.other.name}</a> · <a href="#top">{props.copy.footer.top}</a>
        </span>
      </div>
    </footer>
  );
}
