import { For } from "solid-js";
import { stories, story } from "@vibevalley/stories";
import { Kbd, Shortcuts } from "./ShortcutSheet";

export default stories({
  title: "组件/工作台/ShortcutSheet",
  stories: {
    List: story({
      note: "页面上按 ? 打开的那张单子里的内容。",
      render: () => (
        <div class="w-[30rem]">
          <Shortcuts />
        </div>
      ),
    }),
    Keys: story({
      render: () => (
        <div class="flex gap-1">
          <For each={["⌘", "K", "?", "Esc", "↵"]}>{(k) => <Kbd>{k}</Kbd>}</For>
        </div>
      ),
    }),
  },
});
