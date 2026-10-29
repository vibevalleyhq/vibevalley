import { stories, story } from "@vibevalley/stories";
import { Button } from "./Button";
import { Empty } from "./Empty";

export default stories({
  title: "ui/Empty",
  stories: {
    "With a next step": story({
      fill: true,
      args: { words: "还没有工单。写一句要做的事，管家会帮你拆开。" },
      controls: { words: { kind: "text", long: true } },
      render: (a) => (
        <Empty
          icon="issues"
          action={
            <Button tone="primary" icon="add">
              新工单
            </Button>
          }
        >
          {a.words}
        </Empty>
      ),
    }),
    "Nothing to do": story({
      fill: true,
      render: () => <Empty icon="search">没有符合筛选的工单。</Empty>,
    }),
  },
});
