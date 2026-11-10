import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { PxPick, PxSegmented, PxSwitchField } from "./choice";
import { storyFrame } from "./story.stylex";

const viewStyles = stylex.create({
  choiceStoriesDiv: {
    width: "calc(var(--spacing) * 64)",
  },
  choiceStoriesDiv2: {
    width: "calc(var(--spacing) * 72)",
  },
});

const runtimes = [
  { value: "claude", label: "Claude Code", detail: "Anthropic" },
  { value: "codex", label: "Codex", detail: "OpenAI" },
  { value: "pi", label: "pi" },
];

export default stories({
  title: "组件/像素/choice",
  themes: ["light"],
  frame: storyFrame.pixel,
  stories: {
    Segmented: story({
      args: { value: "day", block: false },
      controls: { value: { kind: "choice", options: ["day", "week", "all"] } },
      render: (a, set) => (
        <PxSegmented
          label="范围"
          value={a.value}
          block={a.block}
          onChange={(value) => set({ value })}
          options={[
            { value: "day", label: "今天" },
            { value: "week", label: "这周" },
            { value: "all", label: "全部" },
          ]}
        />
      ),
    }),
    Pick: story({
      args: { value: "", clearable: true, disabled: false },
      render: (a, set) => (
        <div {...stylex.attrs(viewStyles.choiceStoriesDiv)}>
          <PxPick
            label="农机"
            placeholder="选一台农机"
            value={a.value}
            clearable={a.clearable}
            disabled={a.disabled}
            options={runtimes}
            onChange={(value) => set({ value })}
          />
        </div>
      ),
    }),
    Switch: story({
      args: { checked: true, disabled: false },
      render: (a, set) => (
        <div {...stylex.attrs(viewStyles.choiceStoriesDiv2)}>
          <PxSwitchField label="自动派活" hint="助手看到空闲的帮工就派" checked={a.checked} disabled={a.disabled} onChange={(checked) => set({ checked })} />
        </div>
      ),
    }),
  },
});
