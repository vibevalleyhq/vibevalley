/** @jsxImportSource @solidjs/web */
import * as stylex from "@stylexjs/stylex";

import { en } from "../i18n/en";
import { zh } from "../i18n/zh";
import { pixelArt } from "../lib/assets";
import { PixelLink } from "./ui";

const sceneStyles = stylex.create({
  translation: {
    marginTop: "calc(var(--spacing) * 7)",
    borderTopStyle: "dashed",
    borderTopWidth: "2px",
    borderRightStyle: "dashed",
    borderBottomStyle: "dashed",
    borderLeftStyle: "dashed",
    borderColor: "var(--color-cream-300)",
    paddingTop: "calc(var(--spacing) * 6)",
  },
});

const recipeStyles = stylex.create({
  notFoundImg: {
    width: "102px",
    animationName: "scratch",
    animationDuration: ".9s",
    animationDelay: "0s",
    animationTimingFunction: "steps(1)",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
    imageRendering: "pixelated",
  },
  notFoundP: {
    marginTop: "calc(var(--spacing) * 2.5)",
    marginBottom: "calc(var(--spacing) * 5)",
    textWrap: "pretty",
    color: "var(--color-bark-800)",
  },
});

const viewStyles = stylex.create({
  notFoundMain: {
    width: "min(560px,100%)",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "inset 0 0 0 2px var(--color-rim), 0 0 transparent, 0 0 transparent, 0 0 transparent, 4px 4px 0 var(--color-drop)",
    paddingInline: "clamp(20px,6vw,48px)",
    paddingTop: "calc(var(--spacing) * 9)",
    paddingBottom: "calc(var(--spacing) * 10)",
    textAlign: "center",
  },
  notFoundDiv: {
    marginBottom: "calc(var(--spacing) * 6)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  notFoundImg: {
    width: "204px",
    imageRendering: "pixelated",
  },
  notFoundH1: {
    fontSize: "32px",
  },
});

export default function NotFound() {
  return (
    <main {...stylex.attrs(viewStyles.notFoundMain)}>
      <div aria-hidden="true" {...stylex.attrs(viewStyles.notFoundDiv)}>
        <img {...stylex.attrs(viewStyles.notFoundImg)} src={pixelArt("plot-dry")} alt="" />
        <img {...stylex.attrs(recipeStyles.notFoundImg)} src={pixelArt("dog-scratch")} alt="" />
      </div>
      {[zh, en].map((copy, index) => (
        <section lang={copy.lang} {...stylex.attrs(index > 0 && sceneStyles.translation)}>
          {index === 0 ? (
            <h1 {...stylex.attrs(viewStyles.notFoundH1)}>{copy.lost.title}</h1>
          ) : (
            <h2 {...stylex.attrs(viewStyles.notFoundH1)}>{copy.lost.title}</h2>
          )}
          <p {...stylex.attrs(recipeStyles.notFoundP)}>{copy.lost.text}</p>
          <PixelLink primary href={copy.home} hreflang={copy.lang}>
            {copy.lost.home}
          </PixelLink>
        </section>
      ))}
    </main>
  );
}
