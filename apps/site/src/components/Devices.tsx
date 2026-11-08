import type { JSX } from "@solidjs/web";
/** @jsxImportSource @solidjs/web */
import * as stylex from "@stylexjs/stylex";

import { createReveal, createScrollAnimation } from "../animation/scroll";
import type { Copy } from "../i18n/zh";
import { Section, cx } from "./ui";

const viewStyles = stylex.create({
  devicesDiv: {
    display: "grid",
    alignItems: "center",
    gap: "calc(var(--spacing) * 12)",
    gridTemplateColumns: {
      default: null,
      "@media (width>=64rem)": "minmax(0,.85fr) minmax(0,1.15fr)",
    },
  },
  devicesP: {
    maxWidth: "36em",
  },
  devicesUl: {
    marginTop: "calc(var(--spacing) * 6)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 3)",
  },
  devicesLi: {
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 0 0 transparent, 0 0 transparent, 0 0 transparent, 4px 4px 0 var(--color-drop)",
    paddingInline: "calc(var(--spacing) * 3.5)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-lg)",
    lineHeight: "1",
  },
  devicesP2: {
    marginTop: "calc(var(--spacing) * 5)",
    fontSize: "15px",
    color: "var(--color-bark-800)",
  },
  devicesDiv2: {
    position: "relative",
    marginInline: "auto",
    width: "100%",
    maxWidth: "640px",
    paddingBottom: {
      default: null,
      "@media (width>=64rem)": "calc(var(--spacing) * 24)",
    },
  },
  devicesDiv3: {
    marginTop: {
      default: "calc(var(--spacing) * 8)",
      "@media (width>=64rem)": "0",
    },
    display: "flex",
    justifyContent: "center",
    gap: "calc(var(--spacing) * 6)",
  },
  laptopDiv: {
    borderStyle: "solid",
    borderWidth: "6px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-bark-900)",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, 4px 4px 0 var(--color-drop)",
  },
  laptopImg: {
    display: "block",
    height: "auto",
    width: "100%",
  },
  laptopDiv2: {
    marginInline: "-4%",
    height: "calc(var(--spacing) * 3)",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-300)",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, 3px 3px 0 var(--color-drop)",
  },
  phoneDiv: {
    borderRadius: "18px",
    borderStyle: "solid",
    borderWidth: "7px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-bark-900)",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, 4px 4px 0 var(--color-drop)",
  },
  phoneImg: {
    display: "block",
    height: "auto",
    width: "100%",
    borderRadius: "10px",
  },
});
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
      <div {...stylex.attrs(viewStyles.devicesDiv)}>
        <div>
          <p data-reveal {...stylex.attrs(viewStyles.devicesP)}>
            {props.copy.text}
          </p>
          <ul role="list" data-reveal {...stylex.attrs(viewStyles.devicesUl)}>
            {props.copy.platforms.map((p) => (
              <li {...stylex.attrs(viewStyles.devicesLi)}>{p}</li>
            ))}
          </ul>
          <p data-reveal {...stylex.attrs(viewStyles.devicesP2)}>
            {props.copy.note}
          </p>
        </div>
        <div {...stylex.attrs(viewStyles.devicesDiv2)}>
          <Drift rate={0.03}>
            <Laptop shot={props.mac} alt={props.copy.shots.mac} />
          </Drift>
          <div {...stylex.attrs(viewStyles.devicesDiv3)}>
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
      <div {...stylex.attrs(viewStyles.laptopDiv)}>
        <img
          loading="lazy"
          decoding="async"
          src={props.shot.src}
          srcset={props.shot.srcset}
          sizes="(min-width: 1024px) 620px, calc(100vw - 48px)"
          width={props.shot.width}
          height={props.shot.height}
          alt={props.alt}
          {...stylex.attrs(viewStyles.laptopImg)}
        />
      </div>
      <div {...stylex.attrs(viewStyles.laptopDiv2)} />
    </div>
  );
}
/** A phone in the farm's colours: the screen in a thick dark frame. */
function Phone(props: { shot: Shot; alt: string }) {
  return (
    <div {...stylex.attrs(viewStyles.phoneDiv)}>
      <img
        loading="lazy"
        decoding="async"
        src={props.shot.src}
        width={props.shot.width}
        height={props.shot.height}
        alt={props.alt}
        {...stylex.attrs(viewStyles.phoneImg)}
      />
    </div>
  );
}
