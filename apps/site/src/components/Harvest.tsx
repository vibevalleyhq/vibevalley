import * as stylex from "@stylexjs/stylex";

import { observeVisibility, createReveal, createScrollAnimation } from "../animation/scroll";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { JOB } from "../lib/story";
import { CountUp } from "./ui";

const sceneStyles = stylex.create({
  field: {
    position: "relative",
    overflow: "hidden",
    borderBlockStyle: "solid",
    borderBlockWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundImage: "var(--scene-harvest-background)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "clamp(96px,13vw,170px)",
  },
  shade: {
    position: "absolute",
    inset: "0",
    backgroundImage: "var(--scene-harvest-shade)",
  },
  title: {
    fontSize: "clamp(40px,8vw,104px)",
    lineHeight: "1.2",
    textShadow: "var(--text-shadow-title)",
  },
  description: {
    marginInline: "auto",
    marginTop: "calc(var(--spacing) * 5)",
    maxWidth: "34em",
    fontSize: {
      default: "var(--text-lg)",
      "@media (width>=40rem)": "var(--text-xl)",
    },
    lineHeight: {
      default: "var(--text-lg--line-height)",
      "@media (width>=40rem)": "var(--text-xl--line-height)",
    },
    textWrap: "balance",
    textShadow: "var(--text-shadow-thin)",
  },
  take: {
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-leaf-500)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-base)",
    lineHeight: "1",
    color: "var(--color-cream-50)",
    boxShadow: "inset 2px 2px 0 var(--color-leaf-hover), 0 0 transparent, 0 0 transparent, 0 0 transparent, var(--shadow-hard-sm)",
  },
});

const styles = stylex.create({
  harvestImg: {
    width: {
      default: "calc(var(--spacing) * 9)",
      "@media (width>=40rem)": "calc(var(--spacing) * 11)",
    },
    imageRendering: "pixelated",
    animationName: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "title-float",
    },
    animationDuration: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "5s",
    },
    animationDelay: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "0s",
    },
    animationTimingFunction: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "ease-in-out",
    },
    animationIterationCount: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "infinite",
    },
    animationDirection: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "normal",
    },
    animationFillMode: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "none",
    },
    animationPlayState: {
      default: null,
      "@media (prefers-reduced-motion:no-preference)": "running",
    },
  },
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
  harvestImg2: {
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
  harvestImg22: {
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
const CROSSING: ["start end", "end start"] = ["start end", "end start"];
interface Props {
  copy: Copy["harvest"];
  /** The ripe plots, the row behind and the row in front. */
  rows: [string[], string[]];
  coins: string;
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
    <section ref={ref.set} id="harvest" aria-labelledby="harvest-title" {...stylex.attrs(sceneStyles.field)}>
      <div ref={back.set} aria-hidden="true" {...stylex.attrs(styles.harvestDiv)}>
        {props.rows[0].map((src) => (
          <img loading="lazy" src={src} alt="" {...stylex.attrs(styles.harvestImg2)} />
        ))}
      </div>
      <div ref={front.set} aria-hidden="true" {...stylex.attrs(styles.harvestDiv2)}>
        {props.rows[1].map((src) => (
          <img loading="lazy" src={src} alt="" {...stylex.attrs(styles.harvestImg22)} />
        ))}
      </div>
      {/* Keep the words readable over the field. */}
      <div aria-hidden="true" {...stylex.attrs(sceneStyles.shade)} />
      <div {...stylex.attrs(styles.harvestDiv3)}>
        <div aria-hidden="true" {...stylex.attrs(styles.harvestDiv4)}>
          {[0, 1, 2].map((i) => (
            <img
              loading="lazy"
              src={props.coins}
              alt=""
              {...stylex.attrs(styles.harvestImg)}
              style={{
                "animation-delay": `${i * -1.6}s`,
              }}
            />
          ))}
        </div>
        <h2 id="harvest-title" data-reveal {...stylex.attrs(sceneStyles.title)}>
          {props.copy.title.map((line) => (
            <span {...stylex.attrs(styles.harvestSpan)}>{line}</span>
          ))}
        </h2>
        <p data-reveal={120} {...stylex.attrs(sceneStyles.description)}>
          {props.copy.text}
        </p>
        <HarvestList copy={props.copy.card} icons={props.icons} />
      </div>
    </section>
  );
}
function HarvestList(props: {
  copy: Copy["harvest"]["card"];
  icons: {
    harvest: string;
    check: string;
  };
}) {
  return (
    <div data-reveal={240} {...stylex.attrs(styles.harvestListDiv)}>
      <div {...stylex.attrs(styles.harvestListDiv2)}>
        <img src={props.icons.harvest} alt="" {...stylex.attrs(styles.harvestListImg)} />
        <div {...stylex.attrs(styles.harvestListDiv3)}>
          <p {...stylex.attrs(styles.harvestListP)}>{props.copy.title}</p>
          <p {...stylex.attrs(styles.harvestListP2)}>{props.copy.job}</p>
        </div>
      </div>
      <dl {...stylex.attrs(styles.harvestListDl)}>
        <div {...stylex.attrs(styles.harvestListDiv4)}>
          <dt {...stylex.attrs(styles.harvestListDt)}>{props.copy.commits}</dt>
          <dd {...stylex.attrs(styles.harvestListDd)}>
            <CountUp to={JOB.commits} />
          </dd>
          <dd {...stylex.attrs(styles.harvestListDd2)}>{props.copy.commits}</dd>
        </div>
        <div {...stylex.attrs(styles.harvestListDiv4)}>
          <dt {...stylex.attrs(styles.harvestListDt)}>{props.copy.files}</dt>
          <dd {...stylex.attrs(styles.harvestListDd)}>
            <CountUp to={JOB.files} />
          </dd>
          <dd {...stylex.attrs(styles.harvestListDd2)}>{props.copy.files}</dd>
        </div>
        <div {...stylex.attrs(styles.harvestListDiv4)}>
          <dt {...stylex.attrs(styles.harvestListDt)}>{props.copy.lines}</dt>
          <dd {...stylex.attrs(styles.harvestListDd3)}>
            <span {...stylex.attrs(styles.harvestListSpan)}>
              +<CountUp to={JOB.plus} />
            </span>{" "}
            <span {...stylex.attrs(styles.harvestListSpan2)}>
              −<CountUp to={JOB.minus} />
            </span>
          </dd>
          <dd {...stylex.attrs(styles.harvestListDd2)}>{props.copy.lines}</dd>
        </div>
      </dl>
      <div {...stylex.attrs(styles.harvestListDiv5)}>
        <span {...stylex.attrs(styles.harvestListSpan3)}>
          <img src={props.icons.check} alt="" {...stylex.attrs(styles.harvestListImg2)} />
          {props.copy.clean}
        </span>
        <span {...stylex.attrs(sceneStyles.take)}>{props.copy.take}</span>
      </div>
    </div>
  );
}
