import { stories, story } from "@vibevalley/stories";
import { Splitter, usePaneWidth } from "./Splitter";

export default stories({
  title: "组件/工作台/Splitter",
  stories: {
    Pane: story({
      fill: true,
      note: "拖边、← → 每次 16px、双击回到默认；宽度记在这台电脑上。",
      render: () => {
        const width = usePaneWidth("story", 240, 160, 400);
        return (
          <div class="flex rounded-md border border-line">
            <div class="relative shrink-0 border-r border-line bg-side p-3 text-sm" style={{ width: `${width()}px` }}>
              列表
              <Splitter pane="story" side="right" width={width()} min={160} max={400} label="列表的宽度" />
            </div>
            <div class="flex-1 p-3 text-sm text-muted">详情</div>
          </div>
        );
      },
    }),
  },
});
