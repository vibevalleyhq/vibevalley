import { For } from "solid-js";
import { stories, story } from "@vibevalley/stories";
import { RuntimeIcon } from "./RuntimeIcon";

const runtimes = ["claude", "codex", "pi", "cursor", "opencode", "kimi", "grok", "antigravity", "dsh", "unknown"];

export default stories({
  title: "组件/像素/RuntimeIcon",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    Runtimes: story({
      args: { size: 24 },
      controls: { size: { kind: "number", min: 12, max: 48, step: 4 } },
      render: (a) => (
        <div class="flex flex-wrap gap-3">
          <For each={runtimes}>{(r) => <RuntimeIcon runtime={r} size={a.size} />}</For>
        </div>
      ),
    }),
  },
});
