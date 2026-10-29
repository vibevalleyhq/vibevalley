import { For } from "solid-js";
import { stories, story } from "@vibevalley/stories";
import { Button } from "./Button";
import { Dot } from "./Dot";
import { IconButton } from "./IconButton";
import { Card, ListCard, ListRow, Quiet, SecretInput, Split, TextLink, Toggle } from "./layout";

const projects = [
  { id: "vibevalley", line: "3 个在做 · 1 个等你", tone: "leaf" as const },
  { id: "site", line: "没有在做的", tone: "idle" as const },
  { id: "island", line: "1 个出了问题", tone: "berry" as const },
];

export default stories({
  title: "ui/layout",
  stories: {
    "List and detail": story({
      fill: true,
      note: "md 以下列表叠在详情上面。",
      args: { open: "vibevalley" },
      controls: { open: { kind: "choice", options: projects.map((p) => p.id) } },
      render: (a) => (
        <Split
          list={
            <ListCard title="项目" action={<IconButton icon="add" label="新建项目" onClick={() => undefined} />}>
              <For each={projects}>
                {(p) => <ListRow to={`/projects/${p.id}`} item={p.id} active={a.open === p.id} title={p.id} line={p.line} leading={<Dot tone={p.tone} />} />}
              </For>
            </ListCard>
          }
        >
          <Card title={a.open} action={<Button>打开目录</Button>}>
            <Quiet>还没有说明。</Quiet>
          </Card>
        </Split>
      ),
    }),
    Toggle: story({
      args: { checked: true, disabled: false, label: "开机时启动", hint: "登录后自己起来，农场一直在" },
      render: (a, set) => (
        <div class="w-96">
          <Toggle label={a.label} hint={a.hint || undefined} checked={a.checked} disabled={a.disabled} onChange={(checked) => set({ checked })} />
        </div>
      ),
    }),
    Controls: story({
      render: () => (
        <div class="flex w-96 flex-col gap-3">
          <SecretInput placeholder="sk-…" aria-label="钥匙" />
          <div class="flex gap-3 text-sm">
            <TextLink onClick={() => undefined}>换一个</TextLink>
            <TextLink danger onClick={() => undefined}>
              删掉
            </TextLink>
          </div>
        </div>
      ),
    }),
  },
});
