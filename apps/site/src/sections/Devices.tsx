import type { Screenshot } from "../base/images";
import type { Copy } from "../i18n/zh";
import { createReveal, createScrollAnimation } from "../ui/scroll";
import { Section } from "../ui/ui";

export default function Devices(props: { copy: Copy["devices"]; mac: Screenshot }) {
  const root = createReveal<HTMLElement>();
  const screen = createScrollAnimation<HTMLDivElement>("self", ["start end", "end start"], () => [
    { keyframes: { transform: ["translateY(18px)", "translateY(-18px)"] } },
  ]);
  return (
    <Section ref={root.set} id="devices" title={props.copy.title}>
      <div class="grid items-center gap-12 lg:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)]">
        <div>
          <p data-reveal class="max-w-[36em] text-bark-900">
            {props.copy.text}
          </p>
          <p data-reveal class="mt-5 text-[length:15px] text-bark-800">
            {props.copy.note}
          </p>
        </div>
        <div ref={screen.set} class="relative mx-auto w-full max-w-160">
          <div class="overflow-hidden rounded-lg border-4 border-slate-900 bg-slate-900 shadow-card-lg">
            <img
              loading="lazy"
              decoding="async"
              src={props.mac.src}
              srcset={props.mac.srcset}
              sizes="(min-width: 1024px) 620px, calc(100vw - 48px)"
              width={props.mac.width}
              height={props.mac.height}
              alt={props.copy.shot}
              class="block h-auto w-full"
            />
          </div>
          <div class="-mx-[3%] mt-1 h-3 rounded-b-md border border-border-soft/50 bg-cream-300 shadow-card-sm" />
        </div>
      </div>
    </Section>
  );
}
