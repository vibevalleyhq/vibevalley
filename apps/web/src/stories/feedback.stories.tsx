import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, Switch } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Button } from "#/ui/Button.tsx";
import { Empty } from "#/ui/layout.tsx";
import { ToastHost } from "#/ui/ToastHost.tsx";
import { toast } from "#/ui/toasts.ts";

const styles = stylex.create({
  list: {
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: "var(--color-line)",
  },
  feedbackStoriesDiv: {
    display: "flex",
    flexDirection: "column",
  },
  feedbackStoriesP: {
    padding: "1rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  feedbackStoriesLi: {
    borderTopStyle: { default: null, ":not(:last-child)": "solid" },
    borderBottomStyle: { default: null, ":not(:last-child)": "solid" },
    borderTopWidth: { default: null, ":not(:last-child)": 0 },
    borderBottomWidth: { default: null, ":not(:last-child)": 1 },
    borderColor: { default: null, ":not(:last-child)": "var(--color-line)" },
    paddingInline: "1rem",
    paddingBlock: "0.625rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
});

export default stories({
  title: "交互/空的、加载和出错",
  stories: {
    "Three states": story({
      fill: true,
      note: "一个地方的空、加载中、出错三种样子都要有（docs/style/design.md 的自查）：空的说为什么和下一步，加载只是一行淡字，出错说原因、给重试。",
      args: { state: "empty" },
      controls: { state: { kind: "choice", options: ["empty", "loading", "failed", "full"] } },
      render: (a, set) => {
        const [rows, setRows] = createSignal<string[]>([]);
        return (
          <div {...stylex.attrs(styles.feedbackStoriesDiv)}>
            <Switch>
              <Match when={a.state === "empty"}>
                <Empty
                  icon="issues"
                  action={
                    <Button
                      tone="primary"
                      icon="add"
                      onClick={() => {
                        setRows(["修好登录"]);
                        set({ state: "full" });
                      }}
                    >
                      新工单
                    </Button>
                  }
                >
                  还没有工单。写一句要做的事，助手会帮你拆开。
                </Empty>
              </Match>
              <Match when={a.state === "loading"}>
                <p {...stylex.attrs(styles.feedbackStoriesP)} aria-busy="true">
                  在读……
                </p>
              </Match>
              <Match when={a.state === "failed"}>
                <Empty icon="warn" action={<Button onClick={() => toast("还是没连上，稍后再试", "bad")}>重试</Button>}>
                  没读到工单：服务端没开。
                </Empty>
              </Match>
              <Match when={a.state === "full"}>
                <ul {...stylex.attrs(styles.list)}>
                  <For each={rows().length > 0 ? rows() : ["修好登录", "补齐看板的测试"]}>
                    {(r) => <li {...stylex.attrs(styles.feedbackStoriesLi)}>{r}</li>}
                  </For>
                </ul>
              </Match>
            </Switch>
            <ToastHost />
          </div>
        );
      },
    }),
  },
});
