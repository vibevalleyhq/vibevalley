import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { MoreMenu } from "./MoreMenu";

const viewStyles = stylex.create({
  moreMenuStoriesDiv: {
    display: "flex",
    justifyContent: "flex-end",
    padding: "calc(var(--spacing) * 4)",
  },
});

const noop = () => undefined;

export default stories({
  title: "组件/工作台/MoreMenu",
  stories: {
    "A place's other actions": story({
      render: () => (
        <div {...stylex.attrs(viewStyles.moreMenuStoriesDiv)}>
          <MoreMenu
            label="更多"
            items={[
              { key: "open", label: "在新标签页打开", icon: "open", onSelect: noop },
              { key: "copy-link", label: "复制链接", icon: "copy", onSelect: noop },
              { key: "delete", label: "删掉", icon: "delete", danger: true, onSelect: noop },
            ]}
          />
        </div>
      ),
    }),
    "Opening upwards, from a toolbar": story({
      render: () => (
        <div class="flex justify-end p-4 pt-40">
          <MoreMenu label="更多" side="top" items={[{ key: "copy-link", label: "复制链接", icon: "copy", onSelect: noop }]} />
        </div>
      ),
    }),
  },
});
