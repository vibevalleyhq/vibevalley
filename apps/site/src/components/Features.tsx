import * as stylex from "@stylexjs/stylex";

import { createReveal } from "../animation/scroll";
/** @jsxImportSource @solidjs/web */
import type { Copy } from "../i18n/zh";
import { FACTS } from "../lib/facts";
import { featureCard } from "./features.stylex";
import { CountUp, Heading, Section } from "./ui";

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
    boxShadow: "inset 0 0 0 2px var(--color-rim), 0 0 transparent, 0 0 transparent, 0 0 transparent, 4px 4px 0 var(--color-drop)",
    padding: "22px",
    transitionProperty: "translate",
    transitionTimingFunction: "steps(2,end)",
    transitionDuration: ".15s",
    translate: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "0 calc(var(--spacing) * -1)",
      },
    },
  },
  cardIcon: {
    marginBottom: "calc(var(--spacing) * 3)",
    width: "calc(var(--spacing) * 11)",
    height: "calc(var(--spacing) * 11)",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  runtime: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 0 0 transparent, 0 0 transparent, 0 0 transparent, 4px 4px 0 var(--color-drop)",
    paddingInline: "18px",
    paddingBlock: "calc(var(--spacing) * 3)",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-2xl)",
    lineHeight: "1",
  },
  runtimeIcon: {
    width: "calc(var(--spacing) * 10)",
    height: "calc(var(--spacing) * 10)",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
});

const recipeStyles = stylex.create({
  featuresSpan: {
    marginTop: "calc(var(--spacing) * 1.5)",
    fontSize: "13px",
    lineHeight: "var(--leading-snug)",
    textWrap: "balance",
    color: "var(--color-bark-800)",
  },
});

const viewStyles = stylex.create({
  runtimesHeading: { marginTop: "72px" },
  featuresUl: {
    marginBottom: "calc(var(--spacing) * 12)",
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2,minmax(0,1fr))",
      "@media (width>=40rem)": "repeat(3,minmax(0,1fr))",
      "@media (width>=64rem)": "repeat(6,minmax(0,1fr))",
    },
    gap: "calc(var(--spacing) * 3)",
  },
  featuresLi: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 0 0 transparent, 0 0 transparent, 0 0 transparent, 4px 4px 0 var(--color-drop)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingTop: "calc(var(--spacing) * 3)",
    paddingBottom: "calc(var(--spacing) * 2.5)",
    textAlign: "center",
  },
  featuresImg: {
    marginBottom: "calc(var(--spacing) * 2)",
    height: "calc(var(--spacing) * 10)",
    width: "auto",
    maxWidth: "100%",
    objectFit: "contain",
    imageRendering: "pixelated",
  },
  featuresSpan: {
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-4xl)",
    lineHeight: "1",
  },
  featuresDiv: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(1,minmax(0,1fr))",
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
      "@media (width>=64rem)": "repeat(4,minmax(0,1fr))",
    },
    gap: "22px",
  },
  featuresH3: {
    marginBottom: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-2xl)",
    lineHeight: "var(--text-2xl--line-height)",
  },
  featuresP: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    color: "var(--color-bark-800)",
  },
  featuresP2: {
    maxWidth: "44em",
  },
  featuresDiv2: {
    marginTop: "calc(var(--spacing) * 7)",
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
      <ul role="list" {...stylex.attrs(viewStyles.featuresUl)}>
        {FACTS.map((f, i) => (
          <li data-reveal={(i % 6) * 60} {...stylex.attrs(viewStyles.featuresLi)}>
            <img loading="lazy" src={props.tallies[i]} alt="" {...stylex.attrs(viewStyles.featuresImg)} />
            <span {...stylex.attrs(viewStyles.featuresSpan)}>
              <CountUp to={f.n} />
            </span>
            <span {...stylex.attrs(recipeStyles.featuresSpan)}>{props.copy.features.tally[f.key]}</span>
          </li>
        ))}
      </ul>
      <div {...stylex.attrs(viewStyles.featuresDiv)}>
        {props.copy.features.items.map((f, i) => (
          <article data-reveal={(i % 4) * 70} {...stylex.attrs(featureCard, sceneStyles.card)}>
            <img loading="lazy" src={props.icons[i]} alt="" {...stylex.attrs(sceneStyles.cardIcon, sceneStyles.hoverIcon)} />
            <h3 {...stylex.attrs(viewStyles.featuresH3)}>{f.title}</h3>
            <p {...stylex.attrs(viewStyles.featuresP)}>{f.text}</p>
          </article>
        ))}
      </div>
      <Heading styles={viewStyles.runtimesHeading}>{props.copy.runtimes.title}</Heading>
      <p data-reveal {...stylex.attrs(viewStyles.featuresP2)}>
        {props.copy.runtimes.text}
      </p>
      <div {...stylex.attrs(viewStyles.featuresDiv2)}>
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
