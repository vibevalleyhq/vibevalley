import { pixelArt } from "../base/assets";
import { en } from "../i18n/en";
import { zh } from "../i18n/zh";
import { PixelLink } from "../ui/ui";

export default function NotFound() {
  return (
    <main class="w-[min(560px,100%)] border-2 border-bark-900 bg-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-rim),_4px_4px_0_var(--color-drop)] px-[clamp(20px,6vw,48px)] pt-9 pb-10 text-center">
      <div aria-hidden="true" class="mb-6 flex items-end justify-center gap-1.5">
        <img class="w-51 [image-rendering:pixelated]" src={pixelArt("plot-dry")} alt="" />
        <img
          class="w-25.5 [animation-name:scratch] [animation-duration:900ms] [animation-timing-function:steps(1)] [animation-iteration-count:infinite] [image-rendering:pixelated]"
          src={pixelArt("dog-scratch")}
          alt=""
        />
      </div>
      {[zh, en].map((copy, index) => (
        <section
          lang={copy.lang}
          class={
            index > 0 &&
            "mt-7 [border-top-style:dashed] border-t-2 [border-right-style:dashed] [border-bottom-style:dashed] [border-left-style:dashed] border-cream-300 pt-6"
          }
        >
          {index === 0 ? <h1 class="text-[length:32px]">{copy.lost.title}</h1> : <h2 class="text-[length:32px]">{copy.lost.title}</h2>}
          <p class="mt-2.5 mb-5 text-pretty text-bark-800">{copy.lost.text}</p>
          <PixelLink primary href={copy.home} hreflang={copy.lang}>
            {copy.lost.home}
          </PixelLink>
        </section>
      ))}
    </main>
  );
}
