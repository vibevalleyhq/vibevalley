import { For } from "solid-js";
import { stories, story } from "@vibevalley/stories";
import { RuntimeBadge } from "./RuntimeBadge";

const runtimes = ["claude", "codex", "pi", "cursor", "opencode", "kimi", "grok", "antigravity", "dsh", "unknown"];

export default stories({
  title: "组件/工作台/RuntimeBadge",
  stories: {
    Runtimes: story({
      note: "叠在头像右下角；没有 logo 的是扳手。",
      args: { size: 16 },
      controls: { size: { kind: "number", min: 10, max: 24 } },
      render: (a) => (
        <div class="flex flex-wrap gap-4">
          <For each={runtimes}>
            {(runtime) => (
              <span class="relative inline-block size-10 rounded-sm bg-hover">
                <RuntimeBadge runtime={runtime} size={a.size} />
              </span>
            )}
          </For>
        </div>
      ),
    }),
  },
});
