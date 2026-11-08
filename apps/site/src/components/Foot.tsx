/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { GITHUB } from "../lib/links";

export default function Foot(props: { copy: Copy }) {
  return (
    <footer class="bg-bark-900 px-[clamp(16px,5vw,64px)] py-10 text-[15px] text-cream-100">
      <div class="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-7 gap-y-[18px] *:[a]:text-cream-50 *:[a]:underline">
        <span class="flex items-center gap-2.5 font-pixel text-2xl/none text-cream-50">
          <img src="/gen/icon-64.png" alt="" width="40" height="40" class="size-10" />
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
