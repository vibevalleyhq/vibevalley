import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { useRouter } from "#/infra/router.ts";
import { Button } from "#/ui/Button.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { Card, Empty, ListCard, ListRow, Quiet, Split } from "#/ui/layout.tsx";
import { Dot, type DotTone } from "#/ui/Tag.tsx";

const styles = stylex.create({
  listAndDetailStoriesP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
});

const repos: { id: string; line: string; tone: DotTone; about?: string }[] = [
  { id: "vibevalley", line: "3 个在做 · 1 个等你", tone: "leaf", about: "本机管编码 agent 的工作台。" },
  { id: "site", line: "没有在做的", tone: "idle" },
  { id: "island", line: "1 个出了问题", tone: "berry", about: "刘海上的灵动岛。" },
];

export default stories({
  title: "交互/列表和详情",
  stories: {
    "Pick a row": story({
      fill: true,
      note: "点左边一行，右边换成它；md 以下列表叠在详情上面（宽度换成 400 看）。",
      render: () => {
        const router = useRouter();
        const open = () => repos.find((p) => router.path() === `/repos/${p.id}`);
        return (
          <Split
            list={
              <ListCard title="仓库" action={<IconButton icon="add" label="新建仓库" onClick={() => undefined} />}>
                <For each={repos}>
                  {(p) => <ListRow to={`/repos/${p.id}`} item={p.id} active={open()?.id === p.id} title={p.id} line={p.line} leading={<Dot tone={p.tone} />} />}
                </For>
              </ListCard>
            }
          >
            <Show when={open()} fallback={<Empty icon="folder">选一个仓库看它的工单和改动。</Empty>}>
              {(p) => (
                <Card title={p().id} action={<Button>打开目录</Button>}>
                  <Show when={p().about} fallback={<Quiet>还没有说明。</Quiet>}>
                    <p {...stylex.attrs(styles.listAndDetailStoriesP)}>{p().about}</p>
                  </Show>
                </Card>
              )}
            </Show>
          </Split>
        );
      },
    }),
  },
});
