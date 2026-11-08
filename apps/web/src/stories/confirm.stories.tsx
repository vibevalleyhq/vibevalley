import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { Empty } from "#/ui/layout.tsx";
import { ToastHost } from "#/ui/ToastHost.tsx";
import { toast } from "#/ui/toasts.ts";

const variantStyles = stylex.create({
  list: {
    display: "flex",
    width: "100%",
    maxWidth: "var(--container-xl)",
    flexDirection: "column",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: "var(--color-line)",
  },
  confirmStoriesDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  confirmStoriesLi: {
    borderTopStyle: { default: null, ":not(:last-child)": "solid" },
    borderBottomStyle: { default: null, ":not(:last-child)": "solid" },
    borderTopWidth: { default: null, ":not(:last-child)": 0 },
    borderBottomWidth: { default: null, ":not(:last-child)": 1 },
    borderColor: { default: null, ":not(:last-child)": "var(--color-line)" },
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 2.5)",
  },
  confirmStoriesSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
});

const all = ["登录页改版", "补齐看板的测试", "灵动岛的动画"];

export default stories({
  title: "交互/确认危险操作",
  stories: {
    "Delete in place": story({
      fill: true,
      note: "第一下就地问，第二下才删；Escape 或焦点离开就收回。删掉以后底下说一声。没有 window.confirm。",
      render: () => {
        const [left, setLeft] = createSignal(all);
        return (
          <div {...stylex.attrs(variantStyles.confirmStoriesDiv)}>
            <Show when={left().length > 0} fallback={<Empty icon="issues">都删掉了。</Empty>}>
              <ul {...stylex.attrs(variantStyles.list)}>
                <For each={left()}>
                  {(title) => (
                    <li {...stylex.attrs(variantStyles.confirmStoriesLi)}>
                      <span {...stylex.attrs(variantStyles.confirmStoriesSpan)}>{title}</span>
                      <ConfirmButton
                        label="删除"
                        icon="delete"
                        question="改动和它的分支一起删掉。"
                        onConfirm={() => {
                          setLeft(left().filter((t) => t !== title));
                          toast(`删掉了「${title}」`);
                        }}
                      />
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <ToastHost />
          </div>
        );
      },
    }),
  },
});
