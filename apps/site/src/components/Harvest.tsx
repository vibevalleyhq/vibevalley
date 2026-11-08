import * as stylex from "@stylexjs/stylex";

import { observeVisibility, createReveal, createScrollAnimation } from "../animation/scroll";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { JOB } from "../lib/story";
import { CountUp } from "./ui";

const viewStyles = stylex.create({
  harvestDiv: {
    position: "absolute",
    top: "6%",
    left: "-10%",
    display: "flex",
    width: "120%",
    alignItems: "flex-end",
    gap: "calc(var(--spacing) * 5)",
    opacity: ".6",
  },
  harvestImg: {
    width: {
      default: "68px",
      "@media (width>=40rem)": "102px",
    },
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  harvestDiv2: {
    position: "absolute",
    bottom: "-4%",
    left: "-10%",
    display: "flex",
    width: "120%",
    alignItems: "flex-end",
    gap: "calc(var(--spacing) * 6)",
  },
  harvestImg2: {
    width: {
      default: "102px",
      "@media (width>=40rem)": "136px",
    },
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  harvestDiv3: {
    position: "relative",
    marginInline: "auto",
    maxWidth: "920px",
    textAlign: "center",
    color: "var(--color-cream-50)",
  },
  harvestDiv4: {
    marginBottom: "calc(var(--spacing) * 4)",
    display: "flex",
    justifyContent: "center",
    gap: "calc(var(--spacing) * 3)",
  },
  harvestSpan: {
    display: "block",
  },
  harvestListDiv: {
    marginInline: "auto",
    marginTop: "calc(var(--spacing) * 9)",
    width: "min(480px,100%)",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 0 0 transparent, 0 0 transparent, 0 0 transparent, 4px 4px 0 var(--color-drop)",
    padding: "calc(var(--spacing) * 4)",
    textAlign: "left",
    color: "var(--color-bark-900)",
  },
  harvestListDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2.5)",
  },
  harvestListImg: {
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  harvestListDiv3: {
    minWidth: "0",
  },
  harvestListP: {
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-lg)",
    lineHeight: "1",
  },
  harvestListP2: {
    marginTop: "var(--spacing)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-bark-800)",
  },
  harvestListDl: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "grid",
    gridTemplateColumns: "repeat(3,minmax(0,1fr))",
    gap: "calc(var(--spacing) * 2)",
    textAlign: "center",
  },
  harvestListDiv4: {
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  harvestListDt: {
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: "0",
    position: "absolute",
    overflow: "hidden",
  },
  harvestListDd: {
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-3xl)",
    lineHeight: "1",
  },
  harvestListDd2: {
    marginTop: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-bark-800)",
  },
  harvestListDd3: {
    fontFamily: "var(--font-pixel)",
    fontSize: {
      default: "var(--text-xl)",
      "@media (width>=40rem)": "var(--text-2xl)",
    },
    lineHeight: {
      default: "1",
      "@media (width>=40rem)": "1",
    },
    whiteSpace: "nowrap",
  },
  harvestListSpan: {
    color: "var(--color-leaf-700)",
  },
  harvestListSpan2: {
    color: "var(--color-berry)",
  },
  harvestListDiv5: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "calc(var(--spacing) * 3)",
  },
  harvestListSpan3: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-leaf-700)",
  },
  harvestListImg2: {
    width: "calc(var(--spacing) * 4)",
    height: "calc(var(--spacing) * 4)",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
});
/** While the band crosses the screen, from its top at the screen's bottom to its bottom at the screen's top. */
const CROSSING = ["start end", "end start"] as ["start end", "end start"];
interface Props {
  copy: Copy["harvest"];
  /** The ripe plots, the row behind and the row in front. */
  rows: [string[], string[]];
  coins: string;
  /** The harvest list's icon and its check. */
  icons: {
    harvest: string;
    check: string;
  };
}
export default function Harvest(props: Props) {
  const ref = createReveal<HTMLElement>();
  const back = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(-50px)", "translateX(50px)"] } }]);
  const front = createScrollAnimation<HTMLDivElement>(ref, CROSSING, () => [{ keyframes: { transform: ["translateX(110px)", "translateX(-110px)"] } }]);
  observeVisibility(ref);
  return (
    <section
      ref={ref.set}
      id="harvest"
      aria-labelledby="harvest-title"
      class="relative overflow-hidden border-y-2 border-bark-900 bg-[linear-gradient(180deg,#f6dc94_0%,#eab654_55%,#c98d32_100%)] px-4 py-[clamp(96px,13vw,170px)]"
    >
      <div ref={back.set} aria-hidden="true" {...stylex.attrs(viewStyles.harvestDiv)}>
        {props.rows[0].map((src) => (
          <img loading="lazy" src={src} alt="" {...stylex.attrs(viewStyles.harvestImg)} />
        ))}
      </div>
      <div ref={front.set} aria-hidden="true" {...stylex.attrs(viewStyles.harvestDiv2)}>
        {props.rows[1].map((src) => (
          <img loading="lazy" src={src} alt="" {...stylex.attrs(viewStyles.harvestImg2)} />
        ))}
      </div>
      {/* A shade behind the words, so they read over the field. */}
      <div aria-hidden="true" class="absolute inset-0 bg-[radial-gradient(ellipse_60%_55%_at_50%_50%,rgb(30_20_10/0.55),transparent_75%)]" />
      <div {...stylex.attrs(viewStyles.harvestDiv3)}>
        <div aria-hidden="true" {...stylex.attrs(viewStyles.harvestDiv4)}>
          {[0, 1, 2].map((i) => (
            <img
              loading="lazy"
              src={props.coins}
              alt=""
              class="pixelated motion-safe:animate-float w-9 sm:w-11"
              style={{
                "animation-delay": `${i * -1.6}s`,
              }}
            />
          ))}
        </div>
        <h2 id="harvest-title" data-reveal class="text-shadow-title text-[clamp(40px,8vw,104px)]/[1.2]">
          {props.copy.title.map((line) => (
            <span {...stylex.attrs(viewStyles.harvestSpan)}>{line}</span>
          ))}
        </h2>
        <p data-reveal={120} class="text-shadow-thin mx-auto mt-5 max-w-[34em] text-lg text-balance sm:text-xl">
          {props.copy.text}
        </p>
        <HarvestList copy={props.copy.card} icons={props.icons} />
      </div>
    </section>
  );
}
/** The story's job as the app's harvest list shows it. */
function HarvestList(props: {
  copy: Copy["harvest"]["card"];
  icons: {
    harvest: string;
    check: string;
  };
}) {
  return (
    <div data-reveal={240} {...stylex.attrs(viewStyles.harvestListDiv)}>
      <div {...stylex.attrs(viewStyles.harvestListDiv2)}>
        <img src={props.icons.harvest} alt="" {...stylex.attrs(viewStyles.harvestListImg)} />
        <div {...stylex.attrs(viewStyles.harvestListDiv3)}>
          <p {...stylex.attrs(viewStyles.harvestListP)}>{props.copy.title}</p>
          <p {...stylex.attrs(viewStyles.harvestListP2)}>{props.copy.job}</p>
        </div>
      </div>
      <dl {...stylex.attrs(viewStyles.harvestListDl)}>
        <div {...stylex.attrs(viewStyles.harvestListDiv4)}>
          <dt {...stylex.attrs(viewStyles.harvestListDt)}>{props.copy.commits}</dt>
          <dd {...stylex.attrs(viewStyles.harvestListDd)}>
            <CountUp to={JOB.commits} />
          </dd>
          <dd {...stylex.attrs(viewStyles.harvestListDd2)}>{props.copy.commits}</dd>
        </div>
        <div {...stylex.attrs(viewStyles.harvestListDiv4)}>
          <dt {...stylex.attrs(viewStyles.harvestListDt)}>{props.copy.files}</dt>
          <dd {...stylex.attrs(viewStyles.harvestListDd)}>
            <CountUp to={JOB.files} />
          </dd>
          <dd {...stylex.attrs(viewStyles.harvestListDd2)}>{props.copy.files}</dd>
        </div>
        <div {...stylex.attrs(viewStyles.harvestListDiv4)}>
          <dt {...stylex.attrs(viewStyles.harvestListDt)}>{props.copy.lines}</dt>
          <dd {...stylex.attrs(viewStyles.harvestListDd3)}>
            <span {...stylex.attrs(viewStyles.harvestListSpan)}>
              +<CountUp to={JOB.plus} />
            </span>{" "}
            <span {...stylex.attrs(viewStyles.harvestListSpan2)}>
              −<CountUp to={JOB.minus} />
            </span>
          </dd>
          <dd {...stylex.attrs(viewStyles.harvestListDd2)}>{props.copy.lines}</dd>
        </div>
      </dl>
      <div {...stylex.attrs(viewStyles.harvestListDiv5)}>
        <span {...stylex.attrs(viewStyles.harvestListSpan3)}>
          <img src={props.icons.check} alt="" {...stylex.attrs(viewStyles.harvestListImg2)} />
          {props.copy.clean}
        </span>
        <span class="inset-shadow-lit shadow-hard-sm border-2 border-bark-900 bg-leaf-500 px-3 py-1.5 font-pixel text-base/none text-cream-50 inset-shadow-leaf-hover">
          {props.copy.take}
        </span>
      </div>
    </div>
  );
}
