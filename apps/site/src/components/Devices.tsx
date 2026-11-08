/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";

import { createReveal, createScrollAnimation } from "../animation/scroll";
import type { Copy } from "../i18n/zh";
import { Section, cx } from "./ui";
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
      <div class="grid items-center gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div>
          <p data-reveal class="max-w-[36em]">
            {props.copy.text}
          </p>
          <ul role="list" data-reveal class="mt-6 flex flex-wrap gap-3">
            {props.copy.platforms.map((p) => (
              <li class="panel px-3.5 py-2 font-pixel text-lg/none">{p}</li>
            ))}
          </ul>
          <p data-reveal class="mt-5 text-[15px] text-bark-800">
            {props.copy.note}
          </p>
        </div>
        <div class="relative mx-auto w-full max-w-[640px] lg:pb-24">
          <Drift rate={0.03}>
            <Laptop shot={props.mac} alt={props.copy.shots.mac} />
          </Drift>
          <div class="mt-8 flex justify-center gap-6 lg:mt-0">
            <Drift rate={-0.06} className="w-[42%] max-w-[180px] lg:absolute lg:right-[17%] lg:bottom-[-4px] lg:w-[25%]">
              <Phone shot={props.phones[0]} alt={props.copy.shots.chat} />
            </Drift>
            <Drift rate={-0.11} className="w-[42%] max-w-[180px] lg:absolute lg:right-[-7%] lg:bottom-[-44px] lg:w-[25%]">
              <Phone shot={props.phones[1]} alt={props.copy.shots.tickets} />
            </Drift>
          </div>
        </div>
      </div>
    </Section>
  );
}
/** A device's place on the page, moving against the page by its rate while it crosses the screen. */
function Drift(props: { rate: number; className?: string; children: JSX.Element }) {
  const ref = createScrollAnimation<HTMLDivElement>("self", ["start end", "end start"], () => [
    { keyframes: { transform: [`translateY(${600 * props.rate}px)`, `translateY(${-600 * props.rate}px)`] } },
  ]);
  return (
    <div ref={ref.set} class={cx("relative", props.className)}>
      {props.children}
    </div>
  );
}
/** A Mac in the farm's colours: the screen in a dark frame, a strip of a base under it. */
function Laptop(props: { shot: Shot; alt: string }) {
  return (
    <div>
      <div class="shadow-hard-lg border-[6px] border-bark-900 bg-bark-900">
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
      <div class="shadow-hard mx-[-4%] h-3 border-2 border-bark-900 bg-cream-300" />
    </div>
  );
}
/** A phone in the farm's colours: the screen in a thick dark frame. */
function Phone(props: { shot: Shot; alt: string }) {
  return (
    <div class="shadow-hard-lg rounded-[18px] border-[7px] border-bark-900 bg-bark-900">
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
