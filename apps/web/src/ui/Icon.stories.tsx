import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Icon, type IconSize } from "./Icon";
import { icons, type IconName } from "./icons";

const viewStyles = stylex.create({
  placement: (offset: number) => ({ marginLeft: offset, color: "var(--color-ink)" }),
  iconStoriesDiv: {
    display: "grid",
    width: "100%",
    gridTemplateColumns: "repeat(auto-fill,minmax(6rem,1fr))",
    gap: "calc(var(--spacing) * 2)",
  },
  iconStoriesDiv2: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--spacing)",
    borderRadius: "var(--radius-md)",
    padding: "calc(var(--spacing) * 2)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  iconStoriesSpan: {
    maxWidth: "100%",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--wb-muted)",
  },
  iconStoriesDiv3: {
    display: "flex",
    alignItems: "flex-end",
    gap: "calc(var(--spacing) * 4)",
  },
  iconStoriesDiv4: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--spacing)",
  },
  iconStoriesSpan2: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--wb-muted)",
  },
});

const ladder: IconSize[] = [10, 12, 14, 16, 20, 24, 48];
const names = Object.keys(icons) as IconName[];

export default stories({
  title: "设计体系/图标",
  stories: {
    Composition: story({
      args: { offset: 12 },
      render: (a, set) => (
        <div>
          <Icon name="check" label="Reference" />
          <Icon name="check" label="Composed" styles={viewStyles.placement(a.offset)} />
          <Icon name="file" label="Document" styles={viewStyles.placement(a.offset)} />
          <button type="button" data-testid="move-icons" onClick={() => set({ offset: 28 })}>
            Move
          </button>
        </div>
      ),
    }),
    All: story({
      note: "一个意思一个图（ui/icons.ts）；名字就是 <Icon name> 收的。",
      args: { size: 20 },
      controls: { size: { kind: "number", min: 10, max: 48 } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.iconStoriesDiv)}>
          <For each={names}>
            {(name) => (
              <div {...stylex.attrs(viewStyles.iconStoriesDiv2)}>
                <Icon name={name} size={a.size as IconSize} />
                <span {...stylex.attrs(viewStyles.iconStoriesSpan)}>{name}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
    Sizes: story({
      note: "只用这一档：10 12 14 16 20 24 48。",
      render: () => (
        <div {...stylex.attrs(viewStyles.iconStoriesDiv3)}>
          <For each={ladder}>
            {(size) => (
              <div {...stylex.attrs(viewStyles.iconStoriesDiv4)}>
                <Icon name="issues" size={size} />
                <span {...stylex.attrs(viewStyles.iconStoriesSpan2)}>{size}</span>
              </div>
            )}
          </For>
        </div>
      ),
    }),
  },
});
