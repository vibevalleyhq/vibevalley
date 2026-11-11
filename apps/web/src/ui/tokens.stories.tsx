import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled, Show } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Button } from "./Button";
import { styleProps } from "./positioner";
import { colors, durations, easing, fonts, leading, media, radii, shadows as shadowTokens, text } from "./tokens.stylex";

const popIn = stylex.keyframes({
  from: { opacity: 0, scale: 0.98 },
});

const fadeIn = stylex.keyframes({
  from: { opacity: 0 },
});

const styles = stylex.create({
  popSample: {
    width: "2.5rem",
    height: "2.5rem",
    animationName: { default: popIn, [media.reducedMotion]: "none" },
    animationDuration: durations.panel,
    animationTimingFunction: easing.out,
    animationFillMode: "both",
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  fadeSample: {
    width: "2.5rem",
    height: "2.5rem",
    animationName: { default: fadeIn, [media.reducedMotion]: "none" },
    animationDuration: durations.state,
    animationTimingFunction: easing.out,
    animationFillMode: "both",
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  colour: (value: string) => ({ backgroundColor: value }),
  radius: (value: string) => ({ borderRadius: value }),
  shadow: (value: string) => ({ boxShadow: value }),
  timing: (value: string) => ({ transitionTimingFunction: value }),
  swatch: { height: "2rem", borderRadius: radii.md, borderWidth: 1, borderStyle: "solid", borderColor: colors.line },
  pixelSwatch: { width: "1.75rem", height: "1.75rem" },
  typeSample: { textOverflow: "ellipsis", whiteSpace: "nowrap", overflow: "hidden" },
  shape: {
    width: "2.5rem",
    height: "2.5rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.line,
    backgroundColor: colors.side,
  },
  raised: { backgroundColor: colors.page, borderRadius: radii.md },
  hidden: { display: "none" },
  tokenName: {
    fontFamily: fonts.mono,
    fontSize: text["2xs"],
    lineHeight: leading["2xs"],
    color: colors.muted,
  },
  rowGrid: {
    display: "flex",
    width: "100%",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: "0.75rem",
  },
  sampleColumn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.25rem",
  },
  curvePlot: {
    width: "3rem",
    height: "3rem",
    color: colors.line,
  },
  easePath: {
    stroke: colors.accent,
  },
  swatchGrid: {
    display: "grid",
    width: "100%",
    gridTemplateColumns: "repeat(auto-fill, minmax(5.5rem, 1fr))",
    gap: "0.5rem",
  },
  swatchItem: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  pixelFrame: {
    display: "flex",
    flexWrap: "wrap",
    gap: "1rem",
    borderRadius: radii.lg,
    backgroundColor: "var(--color-cream-50)",
    padding: "1rem",
  },
  pixelStrip: {
    display: "flex",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-500)",
  },
  pixelLabel: {
    fontFamily: fonts.mono,
    fontSize: text["2xs"],
    lineHeight: leading["2xs"],
    color: "var(--color-bark-600)",
  },
  typeList: {
    display: "flex",
    width: "100%",
    flexDirection: "column",
    gap: "0.25rem",
  },
  typeRow: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.75rem",
  },
  typeLabel: {
    width: "4rem",
    flexShrink: "0",
  },
  motionPair: {
    display: "flex",
    alignItems: "flex-end",
    gap: "0.75rem",
  },
});

const colours: [string, string][] = [
  ["page", colors.page],
  ["side", colors.side],
  ["hover", colors.hover],
  ["selected", colors.selected],
  ["line", colors.line],
  ["faint", colors.faint],
  ["muted", colors.muted],
  ["ink", colors.ink],
  ["accent", colors.accent],
  ["focus", colors.focus],
  ["leaf", colors.leaf],
  ["wheat", colors.wheat],
  ["berry", colors.berry],
  ["water", colors.water],
  ["bark", colors.bark],
  ["idle", colors.idle],
  ["ok-soft", colors.okSoft],
  ["ok-ink", colors.okInk],
  ["bad-soft", colors.badSoft],
  ["warn-ink", colors.warnInk],
  ["rail", colors.rail],
  ["code-bg", colors.codeBg],
];

// The pixel skin's families, darkest last.
const palette: [string, string[]][] = [
  ["cream", ["var(--color-cream-50)", "var(--color-cream-100)", "var(--color-cream-200)", "var(--color-cream-300)"]],
  ["bark", ["var(--color-bark-400)", "var(--color-bark-500)", "var(--color-bark-600)", "var(--color-bark-800)", "var(--color-bark-900)"]],
  ["leaf", ["var(--color-leaf-300)", "var(--color-leaf-500)", "var(--color-leaf-600)", "var(--color-leaf-700)"]],
  ["wheat · berry · water", ["var(--color-hat)", "var(--color-wheat-700)", "var(--color-berry-500)", "var(--color-berry-800)", "var(--color-water-500)"]],
  ["ink", ["var(--color-ink-100)", "var(--color-ink-300)", "var(--color-ink-500)", "var(--color-ink-700)", "var(--color-ink-900)"]],
  ["lcd · dusk · glow", ["var(--color-lcd-pale)", "var(--color-lcd-paper)", "var(--color-lcd-light)", "var(--color-dusk-800)", "var(--color-glow)"]],
];

const typography = stylex.create({
  tiny: { fontSize: text["2xs"], lineHeight: leading["2xs"] },
  xs: { fontSize: text.xs, lineHeight: leading.xs },
  sm: { fontSize: text.sm, lineHeight: leading.sm },
  base: { fontSize: text.base, lineHeight: leading.base },
  lg: { fontSize: text.lg, lineHeight: leading.lg },
  xl: { fontSize: text.xl, lineHeight: leading.xl },
});

const sizes: [string, stylex.StyleXStyles][] = [
  ["text-2xs", typography.tiny],
  ["text-xs", typography.xs],
  ["text-sm", typography.sm],
  ["text-base", typography.base],
  ["text-lg", typography.lg],
  ["text-xl", typography.xl],
];

const radiiList: [string, string][] = [
  ["xs", radii.xs],
  ["sm", radii.sm],
  ["md", radii.md],
  ["lg", radii.lg],
  ["xl", radii.xl],
];

const shadows: [string, string][] = [
  ["raise", shadowTokens.raise],
  ["float", shadowTokens.float],
];

const eases: [string, string][] = [
  ["out", easing.out],
  ["in", easing.in],
  ["in-out", easing.inOut],
  ["spring", easing.spring],
];

function Name(props: { children: string }) {
  return <span {...stylex.attrs(styles.tokenName)}>{props.children}</span>;
}

function Grid(props: { children: JSX.Element }) {
  return <div {...stylex.attrs(styles.rowGrid)}>{props.children}</div>;
}

/** cubic-bezier(a, b, c, d) as its four numbers. */
const bezier = (v: string) => {
  const n = v.match(/-?[\d.]+/gu)?.map(Number) ?? [];
  return n.length === 4 ? (n as [number, number, number, number]) : undefined;
};

/** The curve on a 0–1 square, with room for spring's overshoot, read off a styled element: the curve drawn
 * is the one the pages get. */
function Curve(props: { name: string; styles: stylex.StyleXStyles }) {
  let probe!: HTMLSpanElement;
  const [p, setP] = createSignal<[number, number, number, number]>();
  onSettled(() => {
    setP(bezier(getComputedStyle(probe).transitionTimingFunction));
  });
  const y = (v: number) => 44 - v * 32;
  return (
    <div {...stylex.attrs(styles.sampleColumn)}>
      <span ref={(el) => (probe = el)} {...styleProps([styles.hidden, props.styles])} />
      <svg viewBox="0 0 48 56" {...stylex.attrs(styles.curvePlot)} aria-hidden="true">
        <rect x="8" y="12" width="32" height="32" fill="none" stroke="currentColor" />
        <Show when={p()}>
          {(c) => (
            <path
              d={`M8 ${y(0)} C${8 + c()[0] * 32} ${y(c()[1])} ${8 + c()[2] * 32} ${y(c()[3])} 40 ${y(1)}`}
              fill="none"
              {...stylex.attrs(styles.easePath)}
              stroke-width="2"
              data-testid="ease"
            />
          )}
        </Show>
      </svg>
      <Name>{props.name}</Name>
    </div>
  );
}

export default stories({
  title: "设计体系/令牌",
  stories: {
    Colour: story({
      render: () => (
        <div {...stylex.attrs(styles.swatchGrid)}>
          <For each={colours}>
            {([name, appearance]) => (
              <div {...stylex.attrs(styles.swatchItem)}>
                <span {...styleProps([styles.swatch, styles.colour(appearance)])} />
                <Name>{name}</Name>
              </div>
            )}
          </For>
        </div>
      ),
    }),
    "Pixel palette": story({
      note: "像素皮的颜色不跟主题走。",
      render: () => (
        <div data-theme="light" {...stylex.attrs(styles.pixelFrame)}>
          <For each={palette}>
            {([name, list]) => (
              <div {...stylex.attrs(styles.swatchItem)}>
                <div {...stylex.attrs(styles.pixelStrip)}>
                  <For each={list}>{(appearance) => <span {...styleProps([styles.pixelSwatch, styles.colour(appearance)])} />}</For>
                </div>
                <span {...stylex.attrs(styles.pixelLabel)}>{name}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
    Type: story({
      args: { sample: "工单派给帮工，用户看改动 Ship it" },
      render: (a) => (
        <div {...stylex.attrs(styles.typeList)}>
          <For each={sizes}>
            {([name, appearance]) => (
              <div {...stylex.attrs(styles.typeRow)}>
                <span {...stylex.attrs(styles.typeLabel)}>
                  <Name>{name}</Name>
                </span>
                <span {...styleProps([styles.typeSample, appearance])}>{a.sample}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
    Shape: story({
      render: () => (
        <Grid>
          <For each={radiiList}>
            {([name, appearance]) => (
              <div {...stylex.attrs(styles.sampleColumn)}>
                <span {...styleProps([styles.shape, styles.radius(appearance)])} />
                <Name>{name}</Name>
              </div>
            )}
          </For>
          <For each={shadows}>
            {([name, appearance]) => (
              <div {...stylex.attrs(styles.sampleColumn)}>
                <span {...styleProps([styles.shape, styles.raised, styles.shadow(appearance)])} />
                <Name>{name}</Name>
              </div>
            )}
          </For>
        </Grid>
      ),
    }),
    Motion: story({
      render: () => {
        const [replay, setReplay] = createSignal(0);
        return (
          <Grid>
            <For each={eases}>{([name, appearance]) => <Curve name={name} styles={styles.timing(appearance)} />}</For>
            {/* Keyed by the count, so each press mounts them again and they play again. */}
            <For each={[replay()]}>
              {() => (
                <div {...stylex.attrs(styles.motionPair)}>
                  <div {...stylex.attrs(styles.sampleColumn)}>
                    <span {...stylex.attrs(styles.popSample)} />
                    <Name>pop-in</Name>
                  </div>
                  <div {...stylex.attrs(styles.sampleColumn)}>
                    <span {...stylex.attrs(styles.fadeSample)} />
                    <Name>fade-in</Name>
                  </div>
                </div>
              )}
            </For>
            <Button tone="quiet" icon="refresh" onClick={() => setReplay((n) => n + 1)}>
              再放一遍
            </Button>
          </Grid>
        );
      },
    }),
  },
});
