import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled, Show } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Button } from "./Button";

const viewStyles = stylex.create({
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
  ["page", "bg-page"],
  ["side", "bg-side"],
  ["hover", "bg-hover"],
  ["selected", "bg-selected"],
  ["line", "bg-line"],
  ["faint", "bg-faint"],
  ["muted", "bg-muted"],
  ["ink", "bg-ink"],
  ["accent", "bg-accent"],
  ["focus", "bg-focus"],
  ["leaf", "bg-leaf"],
  ["wheat", "bg-wheat"],
  ["berry", "bg-berry"],
  ["water", "bg-water"],
  ["bark", "bg-bark"],
  ["idle", "bg-idle"],
  ["ok-soft", "bg-ok-soft"],
  ["ok-ink", "bg-ok-ink"],
  ["bad-soft", "bg-bad-soft"],
  ["warn-ink", "bg-warn-ink"],
  ["rail", "bg-rail"],
  ["code-bg", "bg-code-bg"],
];

// The pixel skin's families, darkest last.
const palette: [string, string[]][] = [
  ["cream", ["bg-cream-50", "bg-cream-100", "bg-cream-200", "bg-cream-300"]],
  ["bark", ["bg-bark-400", "bg-bark-500", "bg-bark-600", "bg-bark-800", "bg-bark-900"]],
  ["leaf", ["bg-leaf-300", "bg-leaf-500", "bg-leaf-600", "bg-leaf-700"]],
  ["wheat · berry · water", ["bg-hat", "bg-wheat-700", "bg-berry-500", "bg-berry-800", "bg-water-500"]],
  ["ink", ["bg-ink-100", "bg-ink-300", "bg-ink-500", "bg-ink-700", "bg-ink-900"]],
  ["lcd · dusk · glow", ["bg-lcd-pale", "bg-lcd-paper", "bg-lcd-light", "bg-dusk-800", "bg-glow"]],
];

const sizes: [string, string][] = [
  ["text-2xs", "text-2xs"],
  ["text-xs", "text-xs"],
  ["text-sm", "text-sm"],
  ["text-base", "text-base"],
  ["text-lg", "text-lg"],
  ["text-xl", "text-xl"],
];

const radii: [string, string][] = [
  ["xs", "rounded-xs"],
  ["sm", "rounded-sm"],
  ["md", "rounded-md"],
  ["lg", "rounded-lg"],
  ["xl", "rounded-xl"],
];

const shadows: [string, string][] = [
  ["raise", "shadow-raise"],
  ["float", "shadow-float"],
];

const eases: [string, string][] = [
  ["out", "ease-out"],
  ["in", "ease-in"],
  ["in-out", "ease-in-out"],
  ["spring", "ease-spring"],
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

/** The curve on a 0–1 square, with room for spring's overshoot, read off an element wearing the class: the curve drawn
 * is the one the pages get. */
function Curve(props: { name: string; class: string }) {
  let probe!: HTMLSpanElement;
  const [p, setP] = createSignal<[number, number, number, number]>();
  onSettled(() => {
    setP(bezier(getComputedStyle(probe).transitionTimingFunction));
  });
  const y = (v: number) => 44 - v * 32;
  return (
    <div {...stylex.attrs(viewStyles.curveDiv)}>
      <span ref={(el) => (probe = el)} class={["hidden", props.class]} />
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
            {([name, cls]) => (
              <div {...stylex.attrs(viewStyles.tokensStoriesDiv2)}>
                <span class={["h-8 rounded-md border border-line", cls]} />
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
                  <For each={list}>{(cls) => <span class={["size-7", cls]} />}</For>
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
            {([name, cls]) => (
              <div {...stylex.attrs(viewStyles.tokensStoriesDiv6)}>
                <span {...stylex.attrs(viewStyles.tokensStoriesSpan2)}>
                  <Name>{name}</Name>
                </span>
                <span class={["truncate", cls]}>{a.sample}</span>
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
            {([name, cls]) => (
              <div {...stylex.attrs(viewStyles.curveDiv)}>
                <span class={["size-10 border border-line bg-side", cls]} />
                <Name>{name}</Name>
              </div>
            )}
          </For>
          <For each={shadows}>
            {([name, cls]) => (
              <div {...stylex.attrs(viewStyles.curveDiv)}>
                <span class={["size-10 rounded-md border border-line bg-page", cls]} />
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
            <For each={eases}>{([name, cls]) => <Curve name={name} class={cls} />}</For>
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
