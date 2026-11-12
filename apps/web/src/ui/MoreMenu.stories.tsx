import { stories, story } from "@vibevalley/stories";

import { MoreMenu } from "./MoreMenu";

const noop = () => undefined;

export default stories({
  title: "组件/工作台/MoreMenu",
  stories: {
    "A place's other actions": story({
      render: () => (
        <div class="flex justify-end p-4">
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
        <div class="flex justify-end pt-40 pr-4 pb-4 pl-4">
          <MoreMenu label="更多" side="top" items={[{ key: "copy-link", label: "复制链接", icon: "copy", onSelect: noop }]} />
        </div>
      ),
    }),
    "One choice of a kind, under its own icon": story({
      note: "发到哪个频道：触发的图标说是哪一类选择，不是 ⋯。",
      render: () => (
        <div class="flex justify-end p-4">
          <MoreMenu
            label="发到频道"
            icon="send"
            items={[
              { key: "general", label: "#general", icon: "chat", onSelect: noop },
              { key: "design", label: "#设计", icon: "chat", onSelect: noop },
            ]}
          />
        </div>
      ),
    }),
  },
});
