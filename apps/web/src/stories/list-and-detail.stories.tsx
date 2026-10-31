import { For, Show } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { useRouter } from "@/infra/router";
import { Button } from "@/ui/Button";
import { Dot, type DotTone } from "@/ui/Dot";
import { Empty } from "@/ui/Empty";
import { IconButton } from "@/ui/IconButton";
import { Card, ListCard, ListRow, Quiet, Split } from "@/ui/layout";

const projects: { id: string; line: string; tone: DotTone; about?: string }[] = [
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
        const open = () => projects.find((p) => router.path() === `/projects/${p.id}`);
        return (
          <Split
            list={
              <ListCard title="项目" action={<IconButton icon="add" label="新建项目" onClick={() => undefined} />}>
                <For each={projects}>
                  {(p) => (
                    <ListRow to={`/projects/${p.id}`} item={p.id} active={open()?.id === p.id} title={p.id} line={p.line} leading={<Dot tone={p.tone} />} />
                  )}
                </For>
              </ListCard>
            }
          >
            <Show when={open()} fallback={<Empty icon="folder">选一个项目看它的工单和改动。</Empty>}>
              {(p) => (
                <Card title={p().id} action={<Button>打开目录</Button>}>
                  <Show when={p().about} fallback={<Quiet>还没有说明。</Quiet>}>
                    <p class="text-sm">{p().about}</p>
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
