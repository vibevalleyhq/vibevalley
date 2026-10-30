// Whole class names, so Tailwind sees each one.

import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Button } from "./Button";

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
    <div class="flex flex-col items-center gap-1">
      <span ref={(el) => (probe = el)} class={["hidden", props.class]} />
      <svg viewBox="0 0 48 56" class="size-12 text-line" aria-hidden="true">
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
            {([name, cls]) => (
              <div class="flex flex-col gap-1">
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
        <div data-theme="light" class="flex flex-wrap gap-4 rounded-lg bg-cream-50 p-4">
          <For each={palette}>
            {([name, list]) => (
              <div class="flex flex-col gap-1">
                <div class="flex border-2 border-bark-500">
                  <For each={list}>{(cls) => <span class={["size-7", cls]} />}</For>
                </div>
                <span class="font-mono text-2xs text-bark-600">{name}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
    Type: story({
      args: { sample: "工单派给帮工，主人看改动 Ship it" },
      render: (a) => (
        <div class="flex w-full flex-col gap-1">
          <For each={sizes}>
            {([name, cls]) => (
              <div class="flex items-baseline gap-3">
                <span class="w-16 shrink-0">
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
              <div class="flex flex-col items-center gap-1">
                <span class={["size-10 border border-line bg-side", cls]} />
                <Name>{name}</Name>
              </div>
            )}
          </For>
          <For each={shadows}>
            {([name, cls]) => (
              <div class="flex flex-col items-center gap-1">
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
                <div class="flex items-end gap-3">
                  <div class="flex flex-col items-center gap-1">
                    <span class="size-10 animate-pop-in rounded-md bg-accent" />
                    <Name>pop-in</Name>
                  </div>
                  <div class="flex flex-col items-center gap-1">
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
