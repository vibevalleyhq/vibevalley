import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Button } from "./Button";

// Each swatch reads the colour's variable, so it is the colour the pages get in this theme.
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

const sizes: [string, JSX.ClassValue][] = [
  ["text-2xs", "text-2xs"],
  ["text-xs", "text-xs"],
  ["text-sm", "text-sm"],
  ["text-base", "text-base"],
  ["text-lg", "text-lg"],
  ["text-xl", "text-xl"],
];

const radiiList: [string, string][] = [
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
  return <span class="font-mono text-2xs text-muted">{props.children}</span>;
}

function Grid(props: { children: JSX.Element }) {
  return <div class="flex w-full flex-wrap items-end gap-3">{props.children}</div>;
}

/** cubic-bezier(a, b, c, d) as its four numbers. */
const bezier = (v: string) => {
  const n = v.match(/-?[\d.]+/gu)?.map(Number) ?? [];
  return n.length === 4 ? (n as [number, number, number, number]) : undefined;
};

/** The curve on a 0–1 square, with room for spring's overshoot, read off a styled element: the curve drawn
 * is the one the pages get. */
function Curve(props: { name: string; class: JSX.ClassValue | undefined }) {
  let probe!: HTMLSpanElement;
  const [p, setP] = createSignal<[number, number, number, number]>();
  onSettled(() => {
    setP(bezier(getComputedStyle(probe).transitionTimingFunction));
  });
  const y = (v: number) => 44 - v * 32;
  return (
    <div class="flex flex-col items-center gap-1">
      <span ref={(el) => (probe = el)} class={["hidden", props.class]} />
      <svg viewBox="0 0 48 56" class="w-12 h-12 text-line" aria-hidden="true">
        <rect x="8" y="12" width="32" height="32" fill="none" stroke="currentColor" />
        <Show when={p()}>
          {(c) => (
            <path
              d={`M8 ${y(0)} C${8 + c()[0] * 32} ${y(c()[1])} ${8 + c()[2] * 32} ${y(c()[3])} 40 ${y(1)}`}
              fill="none"
              class="stroke-accent"
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
        <div class="grid w-full grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
          <For each={colours}>
            {([name, appearance]) => (
              <div class="flex flex-col gap-1">
                <span class="h-8 rounded-md border border-line" style={{ "background-color": appearance }} />
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
        <div data-theme="light" class="flex flex-wrap gap-4 rounded-lg bg-cream-50 p-4">
          <For each={palette}>
            {([name, list]) => (
              <div class="flex flex-col gap-1">
                <div class="flex border-2 border-bark-500">
                  <For each={list}>{(appearance) => <span class="w-7 h-7" style={{ "background-color": appearance }} />}</For>
                </div>
                <span class="font-mono text-2xs text-bark-600">{name}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
    Type: story({
      args: { sample: "工单派给帮工，用户看改动 Ship it" },
      render: (a) => (
        <div class="flex w-full flex-col gap-1">
          <For each={sizes}>
            {([name, appearance]) => (
              <div class="flex items-baseline gap-3">
                <span class="w-16 shrink-0">
                  <Name>{name}</Name>
                </span>
                <span class={["truncate", appearance]}>{a.sample}</span>
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
              <div class="flex flex-col items-center gap-1">
                <span class={["w-10 h-10 border border-line bg-side", appearance]} />
                <Name>{name}</Name>
              </div>
            )}
          </For>
          <For each={shadows}>
            {([name, appearance]) => (
              <div class="flex flex-col items-center gap-1">
                <span class={["w-10 h-10 rounded-md border border-line bg-page", appearance]} />
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
            <For each={eases}>{([name, appearance]) => <Curve name={name} class={appearance} />}</For>
            {/* Keyed by the count, so each press mounts them again and they play again. */}
            <For each={[replay()]}>
              {() => (
                <div class="flex items-end gap-3">
                  <div class="flex flex-col items-center gap-1">
                    <span class="animate-pop-in w-10 h-10 rounded-md bg-accent" />
                    <Name>pop-in</Name>
                  </div>
                  <div class="flex flex-col items-center gap-1">
                    <span class="animate-fade-in w-10 h-10 rounded-md bg-accent" />
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
