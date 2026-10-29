import { For } from "solid-js";
import { stories, story } from "@vibevalley/stories";
import { DashedLine, PxCard, PxWindow } from "./base";
import { PxButton } from "./button";

// The skin's families, darkest last; whole class names, so Tailwind sees each one.
const palette: [string, string[]][] = [
  ["cream", ["bg-cream-50", "bg-cream-100", "bg-cream-200", "bg-cream-300"]],
  ["bark", ["bg-bark-400", "bg-bark-500", "bg-bark-600", "bg-bark-800", "bg-bark-900"]],
  ["leaf", ["bg-leaf-300", "bg-leaf-500", "bg-leaf-600", "bg-leaf-700"]],
  ["wheat · berry · water", ["bg-hat", "bg-wheat-700", "bg-berry-500", "bg-berry-800", "bg-water-500"]],
  ["ink", ["bg-ink-100", "bg-ink-300", "bg-ink-500", "bg-ink-700", "bg-ink-900"]],
  ["lcd · dusk · glow", ["bg-lcd-pale", "bg-lcd-paper", "bg-lcd-light", "bg-dusk-800", "bg-glow"]],
];

export default stories({
  title: "pixel/base",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    Palette: story({
      note: "像素皮的颜色不跟主题走。",
      render: () => (
        <div class="flex flex-wrap gap-4">
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
    Card: story({
      args: { title: "今天的收成", aside: "3 块地" },
      render: (a) => (
        <PxCard title={a.title} aside={a.aside} class="w-72">
          <p>两块熟了，一块缺肥。</p>
          <DashedLine class="my-3" />
          <PxButton tone="primary" onClick={() => undefined}>
            去看看
          </PxButton>
        </PxCard>
      ),
    }),
    Window: story({
      args: { border: true },
      render: (a) => (
        <PxWindow border={a.border} class="w-64 p-4">
          窗子里的纸
        </PxWindow>
      ),
    }),
  },
});
