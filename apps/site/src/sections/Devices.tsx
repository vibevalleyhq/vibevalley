import type { JSX } from "@solidjs/web";

import type { Copy } from "../i18n/zh";
import { createReveal, createScrollAnimation } from "../ui/scroll";
import { Section } from "../ui/ui";
interface Shot {
  src: string;
  srcset: string;
  width: number;
  height: number;
}
interface Props {
  copy: Copy["devices"];
  mac: Shot;
  phones: [Shot, Shot];
}
export default function Devices(props: Props) {
  const root = createReveal<HTMLElement>();
  return (
    <Section ref={root.set} id="devices" title={props.copy.title}>
      <div class="grid items-center gap-12 lg:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)]">
        <div>
          <p data-reveal class="max-w-[36em]">
            {props.copy.text}
          </p>
          <ul role="list" data-reveal class="mt-6 flex flex-wrap gap-3">
            {props.copy.platforms.map((p) => (
              <li class="border-2 border-bark-900 bg-cream-50 [box-shadow:inset_0_0_0_2px_var(--color-rim),_4px_4px_0_var(--color-drop)] px-3.5 py-2 font-pixel text-lg leading-none">
                {p}
              </li>
            ))}
          </ul>
          <p data-reveal class="mt-5 text-[length:15px] text-bark-800">
            {props.copy.note}
          </p>
        </div>
        <div class="relative mx-auto w-full max-w-160 lg:pb-24">
          <Drift rate={0.03}>
            <Laptop shot={props.mac} alt={props.copy.shots.mac} />
          </Drift>
          <div class="mt-8 lg:mt-0 flex justify-center gap-6">
            <Drift rate={-0.06} class={["w-[42%] lg:w-1/4 max-w-45 relative lg:absolute", "lg:right-[17%] lg:-bottom-1"]}>
              <Phone shot={props.phones[0]} alt={props.copy.shots.chat} />
            </Drift>
            <Drift rate={-0.11} class={["w-[42%] lg:w-1/4 max-w-45 relative lg:absolute", "lg:-right-[7%] lg:-bottom-11"]}>
              <Phone shot={props.phones[1]} alt={props.copy.shots.tickets} />
            </Drift>
          </div>
        </div>
      </div>
    </Section>
  );
}
function Drift(props: { rate: number; class?: JSX.ClassValue | undefined; children: JSX.Element }) {
  const ref = createScrollAnimation<HTMLDivElement>("self", ["start end", "end start"], () => [
    { keyframes: { transform: [`translateY(${600 * props.rate}px)`, `translateY(${-600 * props.rate}px)`] } },
  ]);
  return (
    <div ref={ref.set} class={["relative", props.class]}>
      {props.children}
    </div>
  );
}
function Laptop(props: { shot: Shot; alt: string }) {
  return (
    <div>
      <div class="border-6 border-bark-900 bg-bark-900 [box-shadow:4px_4px_0_var(--color-drop)]">
        <img
          loading="lazy"
          decoding="async"
          src={props.shot.src}
          srcset={props.shot.srcset}
          sizes="(min-width: 1024px) 620px, calc(100vw - 48px)"
          width={props.shot.width}
          height={props.shot.height}
          alt={props.alt}
          class="block h-auto w-full"
        />
      </div>
      <div class="-mx-[4%] h-3 border-2 border-bark-900 bg-cream-300 [box-shadow:3px_3px_0_var(--color-drop)]" />
    </div>
  );
}
function Phone(props: { shot: Shot; alt: string }) {
  return (
    <div class="rounded-[18px] border-7 border-bark-900 bg-bark-900 [box-shadow:4px_4px_0_var(--color-drop)]">
      <img
        loading="lazy"
        decoding="async"
        src={props.shot.src}
        width={props.shot.width}
        height={props.shot.height}
        alt={props.alt}
        class="block h-auto w-full rounded-[10px]"
      />
    </div>
  );
}
