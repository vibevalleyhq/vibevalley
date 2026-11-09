import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { Splitter, usePaneWidth } from "./Splitter";

const viewStyles = stylex.create({
  splitterStoriesDiv: {
    display: "flex",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
  },
  splitterStoriesDiv2: {
    position: "relative",
    flexShrink: "0",
    borderRightStyle: "solid",
    borderRightWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
    padding: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  splitterStoriesDiv3: {
    flex: "1",
    padding: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
});

export default stories({
  title: "组件/工作台/Splitter",
  stories: {
    Pane: story({
      fill: true,
      note: "拖边、← → 每次 16px、双击回到默认；宽度记在这台电脑上。",
      render: () => {
        const width = usePaneWidth("story", 240, 160, 400);
        return (
          <div {...stylex.attrs(viewStyles.splitterStoriesDiv)}>
            <div {...stylex.attrs(viewStyles.splitterStoriesDiv2)} style={{ width: `${width()}px` }}>
              列表
              <Splitter pane="story" side="right" width={width()} min={160} max={400} label="列表的宽度" />
            </div>
            <div {...stylex.attrs(viewStyles.splitterStoriesDiv3)}>详情</div>
          </div>
        );
      },
    }),
  },
});
