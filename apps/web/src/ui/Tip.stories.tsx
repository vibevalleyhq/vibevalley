import { stories, story } from "@vibevalley/stories";

import { Button } from "./Button";
import { Hint, Tip } from "./Tip";

export default stories({
  title: "组件/工作台/Tip",
  stories: {
    Hover: story({
      note: "悬停或聚焦才出来；提示说明它，不给它起名字。",
      args: { text: "派给一个帮工，它在工单的 worktree 里干活" },
      render: (a) => (
        <div class="flex items-center gap-4">
          <Tip text={a.text}>
            <Button tone="primary">派活</Button>
          </Tip>
          <span class="flex items-center gap-1 text-sm">
            工作目录
            <Hint text={a.text} />
          </span>
          <span class="flex items-center gap-1 text-sm">
            存在哪
            <Hint text="~/.vibevalley/vibevalley.yaml" icon="folder" />
          </span>
        </div>
      ),
    }),
  },
});
