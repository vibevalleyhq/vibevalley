import { For } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { Button, type Tone } from "./Button";
import { icons, type IconName } from "./icons";

const tones: Tone[] = ["plain", "primary", "quiet", "danger"];

export default stories({
  title: "组件/工作台/Button",
  stories: {
    Playground: story({
      args: { label: "派活", tone: "primary", icon: "add", disabled: false },
      controls: { tone: { kind: "choice", options: tones }, icon: { kind: "choice", options: ["", ...Object.keys(icons)] } },
      render: (a) => (
        <Button tone={a.tone as Tone} icon={(a.icon || undefined) as IconName | undefined} disabled={a.disabled}>
          {a.label}
        </Button>
      ),
    }),
    States: story({
      note: "每种色调在静止、指针下、键盘聚焦、按下时的样子；disabled 在参数里切。",
      args: { label: "派活", icon: "add", tone: "primary", disabled: false },
      grid: { rows: ["tone", tones], cols: "pseudo" },
      render: (a) => (
        <Button tone={a.tone as Tone} icon={(a.icon || undefined) as IconName | undefined} disabled={a.disabled}>
          {a.label}
        </Button>
      ),
    }),
    Tones: story({
      note: "主色一页只有一个；危险的动作用 danger，不用红色的主色。",
      render: () => (
        <div class="flex flex-wrap items-center gap-2">
          <For each={tones}>{(tone) => <Button tone={tone}>{tone}</Button>}</For>
          <Button disabled>disabled</Button>
        </div>
      ),
    }),
    "With icon": story({
      render: () => (
        <div class="flex flex-wrap items-center gap-2">
          <Button tone="primary" icon="add">
            新工单
          </Button>
          <Button icon="refresh">重试</Button>
          <Button tone="quiet" icon="copy">
            复制
          </Button>
          <Button tone="danger" icon="delete">
            删除
          </Button>
        </div>
      ),
    }),
  },
});
