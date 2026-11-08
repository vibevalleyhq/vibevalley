import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled, Show } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Button } from "./Button";
import { styleProps } from "./positioner";

const viewStyles = stylex.create({
  colour: (value: string) => ({ backgroundColor: value }),
  radius: (value: string) => ({ borderRadius: value }),
  shadow: (value: string) => ({ boxShadow: value }),
  timing: (value: string) => ({ transitionTimingFunction: value }),
  swatch: { height: "calc(var(--spacing) * 8)", borderRadius: "var(--radius-md)", borderWidth: 1, borderStyle: "solid", borderColor: "var(--color-line)" },
  pixelSwatch: { width: "calc(var(--spacing) * 7)", height: "calc(var(--spacing) * 7)" },
  typeSample: { textOverflow: "ellipsis", whiteSpace: "nowrap", overflow: "hidden" },
  shape: {
    width: "calc(var(--spacing) * 10)",
    height: "calc(var(--spacing) * 10)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
  },
  raised: { backgroundColor: "var(--color-page)", borderRadius: "var(--radius-md)" },
  hidden: { display: "none" },
  nameSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--color-muted)",
  },
  gridDiv: {
    display: "flex",
    width: "100%",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: "calc(var(--spacing) * 3)",
  },
  curveDiv: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--spacing)",
  },
  curveSvg: {
    width: "calc(var(--spacing) * 12)",
    height: "calc(var(--spacing) * 12)",
    color: "var(--color-line)",
  },
  ease: {
    stroke: "var(--color-accent)",
  },
  tokensStoriesDiv: {
    display: "grid",
    width: "100%",
    gridTemplateColumns: "repeat(auto-fill,minmax(5.5rem,1fr))",
    gap: "calc(var(--spacing) * 2)",
  },
  tokensStoriesDiv2: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  tokensStoriesDiv3: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 4)",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-cream-50)",
    padding: "calc(var(--spacing) * 4)",
  },
  tokensStoriesDiv4: {
    display: "flex",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-500)",
  },
  tokensStoriesSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--color-bark-600)",
  },
  tokensStoriesDiv5: {
    display: "flex",
    width: "100%",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  tokensStoriesDiv6: {
    display: "flex",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 3)",
  },
  tokensStoriesSpan2: {
    width: "calc(var(--spacing) * 16)",
    flexShrink: "0",
  },
  tokensStoriesDiv7: {
    display: "flex",
    alignItems: "flex-end",
    gap: "calc(var(--spacing) * 3)",
  },
});

const colours: [string, string][] = [
  ["page", "var(--color-page)"],
  ["side", "var(--color-side)"],
  ["hover", "var(--color-hover)"],
  ["selected", "var(--color-selected)"],
  ["line", "var(--color-line)"],
  ["faint", "var(--color-faint)"],
  ["muted", "var(--color-muted)"],
  ["ink", "var(--color-ink)"],
  ["accent", "var(--color-accent)"],
  ["focus", "var(--color-focus)"],
  ["leaf", "var(--color-leaf)"],
  ["wheat", "var(--color-wheat)"],
  ["berry", "var(--color-berry)"],
  ["water", "var(--color-water)"],
  ["bark", "var(--color-bark)"],
  ["idle", "var(--color-idle)"],
  ["ok-soft", "var(--color-ok-soft)"],
  ["ok-ink", "var(--color-ok-ink)"],
  ["bad-soft", "var(--color-bad-soft)"],
  ["warn-ink", "var(--color-warn-ink)"],
  ["rail", "var(--color-rail)"],
  ["code-bg", "var(--color-code-bg)"],
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
  tiny: { fontSize: "var(--text-2xs)", lineHeight: "var(--text-2xs--line-height)" },
  xs: { fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)" },
  sm: { fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)" },
  base: { fontSize: "var(--text-base)", lineHeight: "var(--text-base--line-height)" },
  lg: { fontSize: "var(--text-lg)", lineHeight: "var(--text-lg--line-height)" },
  xl: { fontSize: "var(--text-xl)", lineHeight: "var(--text-xl--line-height)" },
});

const sizes: [string, stylex.StyleXStyles][] = [
  ["text-2xs", typography.tiny],
  ["text-xs", typography.xs],
  ["text-sm", typography.sm],
  ["text-base", typography.base],
  ["text-lg", typography.lg],
  ["text-xl", typography.xl],
];

const radii: [string, string][] = [
  ["xs", "var(--radius-xs)"],
  ["sm", "var(--radius-sm)"],
  ["md", "var(--radius-md)"],
  ["lg", "var(--radius-lg)"],
  ["xl", "var(--radius-xl)"],
];

const shadows: [string, string][] = [
  ["raise", "var(--shadow-raise)"],
  ["float", "var(--shadow-float)"],
];

const eases: [string, string][] = [
  ["out", "var(--ease-out)"],
  ["in", "var(--ease-in)"],
  ["in-out", "var(--ease-in-out)"],
  ["spring", "var(--ease-spring)"],
];

function Name(props: { children: string }) {
  return <span {...stylex.attrs(viewStyles.nameSpan)}>{props.children}</span>;
}

function Grid(props: { children: JSX.Element }) {
  return <div {...stylex.attrs(viewStyles.gridDiv)}>{props.children}</div>;
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
    <div {...stylex.attrs(viewStyles.curveDiv)}>
      <span ref={(el) => (probe = el)} {...styleProps([viewStyles.hidden, props.styles])} />
      <svg viewBox="0 0 48 56" {...stylex.attrs(viewStyles.curveSvg)} aria-hidden="true">
        <rect x="8" y="12" width="32" height="32" fill="none" stroke="currentColor" />
        <Show when={p()}>
          {(c) => (
            <path
              d={`M8 ${y(0)} C${8 + c()[0] * 32} ${y(c()[1])} ${8 + c()[2] * 32} ${y(c()[3])} 40 ${y(1)}`}
              fill="none"
              {...stylex.attrs(viewStyles.ease)}
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
        <div {...stylex.attrs(viewStyles.tokensStoriesDiv)}>
          <For each={colours}>
            {([name, appearance]) => (
              <div {...stylex.attrs(viewStyles.tokensStoriesDiv2)}>
                <span {...styleProps([viewStyles.swatch, viewStyles.colour(appearance)])} />
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
        <div data-theme="light" {...stylex.attrs(viewStyles.tokensStoriesDiv3)}>
          <For each={palette}>
            {([name, list]) => (
              <div {...stylex.attrs(viewStyles.tokensStoriesDiv2)}>
                <div {...stylex.attrs(viewStyles.tokensStoriesDiv4)}>
                  <For each={list}>{(appearance) => <span {...styleProps([viewStyles.pixelSwatch, viewStyles.colour(appearance)])} />}</For>
                </div>
                <span {...stylex.attrs(viewStyles.tokensStoriesSpan)}>{name}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
    Type: story({
      args: { sample: "工单派给帮工，主人看改动 Ship it" },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.tokensStoriesDiv5)}>
          <For each={sizes}>
            {([name, appearance]) => (
              <div {...stylex.attrs(viewStyles.tokensStoriesDiv6)}>
                <span {...stylex.attrs(viewStyles.tokensStoriesSpan2)}>
                  <Name>{name}</Name>
                </span>
                <span {...styleProps([viewStyles.typeSample, appearance])}>{a.sample}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
    Shape: story({
      render: () => (
        <Grid>
          <For each={radii}>
            {([name, appearance]) => (
              <div {...stylex.attrs(viewStyles.curveDiv)}>
                <span {...styleProps([viewStyles.shape, viewStyles.radius(appearance)])} />
                <Name>{name}</Name>
              </div>
            )}
          </For>
          <For each={shadows}>
            {([name, appearance]) => (
              <div {...stylex.attrs(viewStyles.curveDiv)}>
                <span {...styleProps([viewStyles.shape, viewStyles.raised, viewStyles.shadow(appearance)])} />
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
            <For each={eases}>{([name, appearance]) => <Curve name={name} styles={viewStyles.timing(appearance)} />}</For>
            {/* Keyed by the count, so each press mounts them again and they play again. */}
            <For each={[replay()]}>
              {() => (
                <div {...stylex.attrs(viewStyles.tokensStoriesDiv7)}>
                  <div {...stylex.attrs(viewStyles.curveDiv)}>
                    <span class="size-10 animate-pop-in rounded-md bg-accent" />
                    <Name>pop-in</Name>
                  </div>
                  <div {...stylex.attrs(viewStyles.curveDiv)}>
                    <span class="size-10 animate-fade-in rounded-md bg-accent" />
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
