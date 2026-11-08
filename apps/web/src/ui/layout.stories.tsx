import * as stylex from "@stylexjs/stylex";
import { createSignal, For } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Card, Empty, ListCard, ListRow, Quiet, SecretInput, Split, TextLink, Toggle } from "./layout";
import { Dot } from "./Tag";

const viewStyles = stylex.create({
  splitExample: { height: "calc(var(--spacing) * 100)", width: "100%" },
  dynamicCard: (width: number) => ({ width, maxWidth: width }),
  layoutStoriesDiv: {
    width: "calc(var(--spacing) * 72)",
  },
  layoutStoriesDiv2: {
    width: "calc(var(--spacing) * 96)",
  },
  layoutStoriesUl: {
    width: "calc(var(--spacing) * 56)",
  },
  layoutStoriesDiv3: {
    display: "flex",
    width: "calc(var(--spacing) * 96)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  layoutStoriesDiv4: {
    display: "flex",
    gap: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
});

const repos = [
  { id: "vibevalley", line: "3 个在做 · 1 个等你", tone: "leaf" as const },
  { id: "site", line: "没有在做的", tone: "idle" as const },
  { id: "island", line: "1 个出了问题", tone: "berry" as const },
];

export default stories({
  title: "组件/工作台/layout",
  stories: {
    "Split boundaries": story({
      args: { edge: true },
      render: (a) => (
        <div data-testid="split-boundaries" {...stylex.attrs(viewStyles.splitExample)}>
          <Split
            edge={a.edge}
            list={
              <ListCard title="List" bare={a.edge} testid="split-list">
                <ListRow to="/repos/first" item="first" title="First" active />
                <ListRow to="/repos/second" item="second" title="Second" />
              </ListCard>
            }
          >
            <Card title="Detail">
              <Quiet>Content</Quiet>
            </Card>
          </Split>
        </div>
      ),
    }),
    "List card": story({
      note: "列表和详情怎么放在一起，见「交互 / 列表和详情」。",
      args: { active: "vibevalley" },
      controls: { active: { kind: "choice", options: repos.map((p) => p.id) } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.layoutStoriesDiv)}>
          <ListCard title="仓库" action={<IconButton icon="add" label="新建仓库" onClick={() => undefined} />}>
            <For each={repos}>
              {(p) => <ListRow to={`/repos/${p.id}`} item={p.id} active={a.active === p.id} title={p.id} line={p.line} leading={<Dot tone={p.tone} />} />}
            </For>
          </ListCard>
        </div>
      ),
    }),
    Card: story({
      render: () => (
        <div {...stylex.attrs(viewStyles.layoutStoriesDiv2)}>
          <Card title="vibevalley" action={<Button>打开目录</Button>}>
            <Quiet>还没有说明。</Quiet>
          </Card>
        </div>
      ),
    }),
    "Dynamic card": story({
      render: () => {
        const [wide, setWide] = createSignal(false);
        return (
          <Card
            testid="styled-card"
            title="Card"
            styles={viewStyles.dynamicCard(wide() ? 320 : 240)}
            action={
              <Button data-testid="card-resize" onClick={() => setWide(!wide())}>
                Resize
              </Button>
            }
          >
            <Quiet>Content</Quiet>
          </Card>
        );
      },
    }),
    "Toggle states": story({
      args: { checked: true, disabled: false },
      grid: { rows: ["checked", [false, true]], cols: "pseudo" },
      render: (a) => <Toggle label="开机时启动" checked={a.checked} disabled={a.disabled} onChange={() => undefined} />,
    }),
    "Row states": story({
      note: "列表的一行：选中和没选中，各种交互状态。",
      args: { active: false },
      grid: { rows: ["active", [false, true]], cols: "pseudo" },
      render: (a) => (
        <ul {...stylex.attrs(viewStyles.layoutStoriesUl)}>
          <ListRow to="/repos/vibevalley" title="vibevalley" line="3 个在做" active={a.active} leading={<Dot tone="leaf" />} />
        </ul>
      ),
    }),
    Toggle: story({
      args: { checked: true, disabled: false, label: "开机时启动", hint: "登录后自己起来，农场一直在" },
      render: (a, set) => (
        <div {...stylex.attrs(viewStyles.layoutStoriesDiv2)}>
          <Toggle label={a.label} hint={a.hint || undefined} checked={a.checked} disabled={a.disabled} onChange={(checked) => set({ checked })} />
        </div>
      ),
    }),
    Controls: story({
      render: () => (
        <div {...stylex.attrs(viewStyles.layoutStoriesDiv3)}>
          <SecretInput placeholder="sk-…" aria-label="钥匙" />
          <div {...stylex.attrs(viewStyles.layoutStoriesDiv4)}>
            <TextLink onClick={() => undefined}>换一个</TextLink>
            <TextLink danger onClick={() => undefined}>
              删掉
            </TextLink>
          </div>
        </div>
      ),
    }),
    "Empty with a next step": story({
      fill: true,
      args: { words: "还没有工单。写一句要做的事，管家会帮你拆开。" },
      controls: { words: { kind: "text", long: true } },
      render: (a) => (
        <Empty
          icon="issues"
          action={
            <Button tone="primary" icon="add">
              新工单
            </Button>
          }
        >
          {a.words}
        </Empty>
      ),
    }),
    "Empty with nothing to do": story({
      fill: true,
      render: () => <Empty icon="search">没有符合筛选的工单。</Empty>,
    }),
  },
});
