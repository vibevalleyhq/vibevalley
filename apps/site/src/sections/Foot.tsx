import { GITHUB } from "../base/links";
import type { Copy } from "../i18n/zh";

export default function Foot(props: { copy: Copy }) {
  return (
    <footer class="bg-bark-900 px-[clamp(16px,5vw,64px)] py-10 text-[length:15px] text-cream-100">
      <div class="mx-auto flex max-w-280 flex-wrap items-center gap-x-7 gap-y-4.5">
        <span class="flex items-center gap-2.5 font-pixel text-2xl leading-none text-cream-50">
          <img src="/gen/icon-64.png" alt="" width="40" height="40" class="w-10 h-10" />
          {props.copy.title}
        </span>
        <a href={GITHUB} class="text-cream-50 underline">
          GitHub
        </a>
        <a href={`${GITHUB}/blob/main/LICENSE`} class="text-cream-50 underline">
          {props.copy.footer.license}
        </a>
        <a href="/gen/fusion-pixel-OFL.txt" class="text-cream-50 underline">
          {props.copy.footer.font}
        </a>
        <span class="ml-auto">
          <a href={props.copy.other.href} class="text-cream-50 underline">
            {props.copy.other.name}
          </a>{" "}
          ·{" "}
          <a href="#top" class="text-cream-50 underline">
            {props.copy.footer.top}
          </a>
        </span>
      </div>
    </footer>
  );
}
