/** @jsxImportSource @solidjs/web */
import { en } from "../i18n/en";
import { zh } from "../i18n/zh";
import { pixelArt } from "../lib/assets";
import { PixelLink } from "./ui";

export default function NotFound() {
  return (
    <main class="panel w-[min(560px,100%)] px-[clamp(20px,6vw,48px)] pt-9 pb-10 text-center">
      <div aria-hidden="true" class="mb-6 flex items-end justify-center gap-1.5">
        <img class="pixelated w-[204px]" src={pixelArt("plot-dry")} alt="" />
        <img class="animate-scratch pixelated w-[102px]" src={pixelArt("dog-scratch")} alt="" />
      </div>
      {[zh, en].map((copy, index) => (
        <section lang={copy.lang} class={index > 0 ? "mt-7 border-t-2 border-dashed border-cream-300 pt-6" : undefined}>
          {index === 0 ? <h1 class="text-[32px]">{copy.lost.title}</h1> : <h2 class="text-[32px]">{copy.lost.title}</h2>}
          <p class="mt-2.5 mb-5 text-pretty text-bark-800">{copy.lost.text}</p>
          <PixelLink primary href={copy.home} hreflang={copy.lang}>
            {copy.lost.home}
          </PixelLink>
        </section>
      ))}
    </main>
  );
}
