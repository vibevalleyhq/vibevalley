import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { IconButton, IconLink, OutLink } from "./IconButton";
import { icons, type IconName } from "./icons";

const viewStyles = stylex.create({
  iconButtonStoriesDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
});

export default stories({
  title: "组件/工作台/IconButton",
  stories: {
    States: story({
      args: { icon: "pin", danger: false, pressed: false, disabled: false },
      grid: { rows: ["pressed", [false, true]], cols: "pseudo" },
      render: (a) => (
        <IconButton
          icon={a.icon as IconName}
          label="置顶"
          pressed={a.pressed}
          tone={a.danger ? "danger" : undefined}
          disabled={a.disabled}
          onClick={() => undefined}
        />
      ),
    }),
    Playground: story({
      args: { icon: "search", label: "搜索", pressed: false, danger: false, disabled: false },
      controls: { icon: { kind: "choice", options: Object.keys(icons) } },
      render: (a, set) => (
        <IconButton
          icon={a.icon as IconName}
          label={a.label}
          testid="icon-button-control"
          pressed={a.pressed}
          tone={a.danger ? "danger" : undefined}
          disabled={a.disabled}
          onClick={() => set({ pressed: !a.pressed })}
        />
      ),
    }),
    Kinds: story({
      note: "只有图标的链接只去工作台里；去外面的要说去哪（OutLink）。",
      render: () => (
        <div {...stylex.attrs(viewStyles.iconButtonStoriesDiv)}>
          <IconButton icon="search" label="搜索" onClick={() => undefined} />
          <IconButton icon="pin" label="置顶" pressed onClick={() => undefined} />
          <IconButton icon="delete" label="删除" tone="danger" onClick={() => undefined} />
          <IconLink href="/settings/general" label="设置" icon="settings" />
          <OutLink href="https://platform.deepseek.com" label="去 DeepSeek 拿钥匙" />
        </div>
      ),
    }),
  },
});
