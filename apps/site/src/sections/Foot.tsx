import { GITHUB } from "../base/links";
import type { Copy } from "../i18n/zh";

export default function Foot(props: { copy: Copy }) {
  return (
    <footer class="border-t border-border-soft/35 bg-bark-900 px-[clamp(16px,5vw,64px)] py-10 text-[length:15px] text-cream-100">
      <div class="mx-auto flex max-w-280 flex-wrap items-center gap-x-7 gap-y-4.5">
        <span class="flex items-center gap-2.5 font-display text-xl font-bold leading-none text-paper-core">
          <img src="/gen/icon-64.png" alt="" width="36" height="36" class="w-9 h-9 rounded-sm" />
          {props.copy.title}
        </span>
        <a href={GITHUB} class="text-cream-50 underline decoration-cream-300/60 underline-offset-4 hover:text-lantern">
          GitHub
        </a>
        <a href={`${GITHUB}/blob/main/LICENSE`} class="text-cream-50 underline decoration-cream-300/60 underline-offset-4 hover:text-lantern">
          {props.copy.footer.license}
        </a>
        <span class="ml-auto">
          <a href={props.copy.other.href} class="text-cream-50 underline decoration-cream-300/60 underline-offset-4 hover:text-lantern">
            {props.copy.other.name}
          </a>{" "}
          ·{" "}
          <a href="#top" class="text-cream-50 underline decoration-cream-300/60 underline-offset-4 hover:text-lantern">
            {props.copy.footer.top}
          </a>
        </span>
      </div>
    </footer>
  );
}
