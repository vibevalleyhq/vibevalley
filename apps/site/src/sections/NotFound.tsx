import { tileArt } from "../base/assets";
import { en } from "../i18n/en";
import { zh } from "../i18n/zh";
import { PaperLink } from "../ui/ui";

export default function NotFound() {
  return (
    <main class="w-[min(560px,100%)] rounded-lg border border-border-soft/50 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card-lg)] px-[clamp(20px,6vw,48px)] pt-9 pb-10 text-center">
      <div aria-hidden="true" class="mb-6 flex items-end justify-center gap-3">
        <img class="w-40 drop-shadow-[0_6px_10px_rgb(91_67_43_/_0.2)]" src={tileArt("t_soil_bed")} alt="" />
        <img
          class="w-20 drop-shadow-[0_6px_10px_rgb(91_67_43_/_0.25)] motion-safe:[animation-name:paper-bob] motion-safe:[animation-duration:2400ms] motion-safe:[animation-timing-function:ease-in-out] motion-safe:[animation-iteration-count:infinite]"
          src={tileArt("a_bear")}
          alt=""
        />
      </div>
      {[zh, en].map((copy, index) => (
        <section lang={copy.lang} class={index > 0 && "mt-7 border-t border-dashed border-cream-300 pt-6"}>
          {index === 0 ? <h1 class="text-[length:30px]">{copy.lost.title}</h1> : <h2 class="text-[length:28px]">{copy.lost.title}</h2>}
          <p class="mt-2.5 mb-5 text-pretty text-bark-800">{copy.lost.text}</p>
          <PaperLink primary href={copy.home} hreflang={copy.lang}>
            {copy.lost.home}
          </PaperLink>
        </section>
      ))}
    </main>
  );
}
