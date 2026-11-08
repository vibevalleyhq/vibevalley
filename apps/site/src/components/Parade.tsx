import * as stylex from "@stylexjs/stylex";

import { observeVisibility, createReveal, createScrollAnimation } from "../animation/scroll";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";

const sceneStyles = stylex.create({
  field: {
    containerType: "inline-size",
    position: "relative",
    height: "400px",
    overflow: "hidden",
    borderBlockStyle: "solid",
    borderBlockWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundImage: "var(--scene-parade-background)",
  },
});

const recipeStyles = stylex.create({
  paradeDiv: {
    position: "absolute",
    bottom: "54px",
    left: "0",
    height: "84px",
    width: "calc(var(--spacing) * 12)",
    animationName: "walk-across",
    animationDuration: "30s",
    animationDelay: "0s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
  },
  paradeImg: {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    animationName: "walk-frame",
    animationDuration: ".6s",
    animationDelay: "0s",
    animationTimingFunction: "steps(1)",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
    objectFit: "contain",
    objectPosition: "bottom",
    opacity: "0",
    imageRendering: "pixelated",
  },
});

const viewStyles = stylex.create({
  paradeDiv: {
    position: "absolute",
    bottom: "108px",
    left: "-10%",
    display: "flex",
    width: "120%",
    alignItems: "flex-end",
    gap: "calc(var(--spacing) * 6)",
  },
  paradeImg: {
    width: "102px",
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  paradeDiv2: {
    position: "absolute",
    bottom: "38px",
    height: "calc(var(--spacing) * 16)",
    width: "100%",
    borderBlockStyle: "solid",
    borderBlockWidth: "2px",
    borderColor: "var(--color-path-edge)",
    backgroundImage: "repeating-linear-gradient(90deg,var(--color-path) 0 22px,var(--color-path-groove) 22px 26px)",
  },
  paradeDiv3: {
    position: "absolute",
    bottom: "-18px",
    left: "-10%",
    display: "flex",
    width: "120%",
    alignItems: "flex-end",
    gap: "120px",
  },
  paradeImg2: {
    width: "150px",
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  paradeDiv4: {
    position: "absolute",
    insetInline: "0",
    top: "22px",
    zIndex: "2",
    marginInline: "auto",
    width: "min(760px,100% - 32px)",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 0 0 transparent, 0 0 transparent, 0 0 transparent, 4px 4px 0 var(--color-drop)",
    paddingInline: "22px",
    paddingBlock: "calc(var(--spacing) * 3.5)",
    textAlign: "center",
  },
  paradeH2: {
    fontSize: {
      default: "var(--text-2xl)",
      "@media (width>=40rem)": "30px",
    },
    lineHeight: "var(--text-2xl--line-height)",
  },
  paradeP: {
    marginTop: "calc(var(--spacing) * 1.5)",
    fontSize: {
      default: "var(--text-sm)",
      "@media (width>=40rem)": "var(--text-base)",
    },
    lineHeight: {
      default: "var(--text-sm--line-height)",
      "@media (width>=40rem)": "var(--text-base--line-height)",
    },
  },
});
/** While the section crosses the screen, from its top at the screen's bottom to its bottom at the screen's top. */
const CROSSING: ["start end", "end start"] = ["start end", "end start"];
interface Props {
  copy: Copy["parade"];
  /** The plots behind, left to right. */
  plots: string[];
  /** Each helper's side frames in a step: step, stand, step, stand. */
  walkers: string[][];
  front: string[];
}
export default function Parade(props: Props) {
  const ref = createReveal<HTMLElement>();
  const back = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(60px)", "translateX(-60px)"] } }]);
  const near = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(-150px)", "translateX(150px)"] } }]);
  observeVisibility(ref);
  return (
    <>
      <section ref={ref.set} id="parade" aria-labelledby="parade-title" {...stylex.attrs(sceneStyles.field)}>
        <div ref={back.set} aria-hidden="true" {...stylex.attrs(viewStyles.paradeDiv)}>
          {props.plots.map((src) => (
            <img loading="lazy" src={src} alt="" {...stylex.attrs(viewStyles.paradeImg)} />
          ))}
        </div>
        <div aria-hidden="true" {...stylex.attrs(viewStyles.paradeDiv2)} />
        {props.walkers.map((frames, i) => (
          <div
            aria-hidden="true"
            {...stylex.attrs(recipeStyles.paradeDiv)}
            style={{
              "animation-duration": `${26 + (i % 3) * 7}s`,
              "animation-delay": `${-i * 5.3}s`,
            }}
          >
            {frames.map((src, j) => (
              <img
                src={src}
                alt=""
                loading="lazy"
                {...stylex.attrs(recipeStyles.paradeImg)}
                style={{
                  "animation-delay": `${j * 0.15}s`,
                }}
              />
            ))}
          </div>
        ))}
        <div ref={near.set} aria-hidden="true" {...stylex.attrs(viewStyles.paradeDiv3)}>
          {props.front.map((src) => (
            <img loading="lazy" src={src} alt="" {...stylex.attrs(viewStyles.paradeImg2)} />
          ))}
        </div>
        <div data-reveal {...stylex.attrs(viewStyles.paradeDiv4)}>
          <h2 id="parade-title" {...stylex.attrs(viewStyles.paradeH2)}>
            {props.copy.title}
          </h2>
          <p {...stylex.attrs(viewStyles.paradeP)}>{props.copy.text}</p>
        </div>
      </section>
    </>
  );
}
