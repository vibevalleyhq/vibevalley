import * as stylex from "@stylexjs/stylex";

import { FACTS } from "../base/facts";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { createReveal } from "../ui/scroll";
import { CountUp, Heading, Section } from "../ui/ui";
import { featureCard } from "./features.stylex";

const sceneStyles = stylex.create({
  hoverIcon: {
    animationName: { default: null, "@media (hover: hover)": { default: null, [stylex.when.ancestor(":hover", featureCard)]: "wiggle" } },
    animationDuration: { default: null, "@media (hover: hover)": { default: null, [stylex.when.ancestor(":hover", featureCard)]: ".4s" } },
    animationTimingFunction: { default: null, "@media (hover: hover)": { default: null, [stylex.when.ancestor(":hover", featureCard)]: "steps(4)" } },
  },
  card: {
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 4px 4px 0 var(--color-drop)",
    padding: "22px",
    transitionProperty: "translate",
    transitionTimingFunction: "steps(2,end)",
    transitionDuration: ".15s",
    translate: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "0 -0.25rem",
      },
    },
  },
  cardIcon: {
    marginBottom: "0.75rem",
    width: "2.75rem",
    height: "2.75rem",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  runtime: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 4px 4px 0 var(--color-drop)",
    paddingInline: "18px",
    paddingBlock: "0.75rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-2xl)",
    lineHeight: "1",
  },
  runtimeIcon: {
    width: "2.5rem",
    height: "2.5rem",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
});

const styles = stylex.create({
  featuresSpan: {
    marginTop: "0.375rem",
    fontSize: "13px",
    lineHeight: "var(--leading-snug)",
    textWrap: "balance",
    color: "var(--color-bark-800)",
  },
  runtimesHeading: { marginTop: "72px" },
  featuresUl: {
    marginBottom: "3rem",
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2,minmax(0,1fr))",
      "@media (width>=40rem)": "repeat(3,minmax(0,1fr))",
      "@media (width>=64rem)": "repeat(6,minmax(0,1fr))",
    },
    gap: "0.75rem",
  },
  featuresLi: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 4px 4px 0 var(--color-drop)",
    paddingInline: "0.5rem",
    paddingTop: "0.75rem",
    paddingBottom: "0.625rem",
    textAlign: "center",
  },
  featuresImg: {
    marginBottom: "0.5rem",
    height: "2.5rem",
    width: "auto",
    maxWidth: "100%",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  featuresSpan2: {
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-4xl)",
    lineHeight: "1",
  },
  featuresDiv: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
      "@media (width>=64rem)": "repeat(4,minmax(0,1fr))",
    },
    gap: "22px",
  },
  featuresH3: {
    marginBottom: "0.375rem",
    fontSize: "var(--text-2xl)",
    lineHeight: "var(--leading-2xl)",
  },
  featuresP: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
    color: "var(--color-bark-800)",
  },
  featuresP2: {
    maxWidth: "44em",
  },
  featuresDiv2: {
    marginTop: "1.75rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "18px",
  },
});

interface Props {
  copy: Pick<Copy, "features" | "runtimes">;
  icons: string[];
  /** VibeValley's own runtime comes last. */
  runtimes: {
    name: string;
    logo: string;
  }[];
  /** Each of the farm's numbers' picture (lib/facts.ts), in its order. */
  tallies: string[];
}
export default function Features(props: Props) {
  const root = createReveal<HTMLElement>();
  return (
    <Section ref={root.set} id="features" alt title={props.copy.features.title}>
      <ul role="list" {...stylex.attrs(styles.featuresUl)}>
        {FACTS.map((f, i) => (
          <li data-reveal={(i % 6) * 60} {...stylex.attrs(styles.featuresLi)}>
            <img loading="lazy" src={props.tallies[i]} alt="" {...stylex.attrs(styles.featuresImg)} />
            <span {...stylex.attrs(styles.featuresSpan2)}>
              <CountUp to={f.n} />
            </span>
            <span {...stylex.attrs(styles.featuresSpan)}>{props.copy.features.tally[f.key]}</span>
          </li>
        ))}
      </ul>
      <div {...stylex.attrs(styles.featuresDiv)}>
        {props.copy.features.items.map((f, i) => (
          <article data-reveal={(i % 4) * 70} {...stylex.attrs(featureCard, sceneStyles.card)}>
            <img loading="lazy" src={props.icons[i]} alt="" {...stylex.attrs(sceneStyles.cardIcon, sceneStyles.hoverIcon)} />
            <h3 {...stylex.attrs(styles.featuresH3)}>{f.title}</h3>
            <p {...stylex.attrs(styles.featuresP)}>{f.text}</p>
          </article>
        ))}
      </div>
      <Heading styles={styles.runtimesHeading}>{props.copy.runtimes.title}</Heading>
      <p data-reveal {...stylex.attrs(styles.featuresP2)}>
        {props.copy.runtimes.text}
      </p>
      <div {...stylex.attrs(styles.featuresDiv2)}>
        {props.runtimes.map((r, i) => (
          <span data-reveal={i * 90} {...stylex.attrs(featureCard, sceneStyles.runtime)}>
            <img loading="lazy" src={r.logo} alt="" {...stylex.attrs(sceneStyles.runtimeIcon, sceneStyles.hoverIcon)} />
            {r.name}
          </span>
        ))}
      </div>
    </Section>
  );
}
