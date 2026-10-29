import { For } from "solid-js";
import { stories, story } from "@vibevalley/stories";
import { Icon, type IconSize } from "./Icon";
import { icons, type IconName } from "./icons";

const ladder: IconSize[] = [10, 12, 14, 16, 20, 24, 48];
const names = Object.keys(icons) as IconName[];

export default stories({
  title: "设计体系/图标",
  stories: {
    All: story({
      note: "一个意思一个图（ui/icons.ts）；名字就是 <Icon name> 收的。",
      args: { size: 20 },
      controls: { size: { kind: "number", min: 10, max: 48 } },
      render: (a) => (
        <div class="grid w-full grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2">
          <For each={names}>
            {(name) => (
              <div class="flex flex-col items-center gap-1 rounded-md p-2 hover:bg-hover">
                <Icon name={name} size={a.size as IconSize} />
                <span class="max-w-full truncate font-mono text-2xs text-muted">{name}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
    Sizes: story({
      note: "只用这一档：10 12 14 16 20 24 48。",
      render: () => (
        <div class="flex items-end gap-4">
          <For each={ladder}>
            {(size) => (
              <div class="flex flex-col items-center gap-1">
                <Icon name="issues" size={size} />
                <span class="font-mono text-2xs text-muted">{size}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
  },
});
