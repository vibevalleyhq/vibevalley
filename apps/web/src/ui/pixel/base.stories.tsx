import type { JSX } from "@solidjs/web";

import { stories, story } from "@vibevalley/stories";

import { DashedLine, PxCard, PxFrame, PxWindow } from "./base";
import { PxButton } from "./button";
import { PxTextArea, PxTextInput } from "./field";

const styles = {
  composed: (width: number, indent: number): JSX.CSSProperties => ({ width: `${width}px`, "--indent": `${indent}px` }),
};

const papers = {
  "bg-cream-50": "bg-cream-50",
  "bg-cream-100": "bg-cream-100",
  "bg-lcd-paper": "bg-lcd-paper",
};

const paperChoices: Record<string, string> = papers;

export default stories({
  title: "组件/像素/base",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-(length:--text-xs) text-bark-900",
  stories: {
    Composition: story({
      args: { width: 300, indent: 4, border: true, value: "", well: false, mono: false, disabled: false, reading: false },
      render: (a, set) => (
        <PxWindow testid="pixel-window-composition" border={a.border} class="ml-3 p-3" style={{ ...styles.composed(a.width, a.indent), "margin-top": "8px" }}>
          <PxTextInput
            testid="pixel-input-composition"
            label="名字"
            value={a.value}
            onChange={(value) => set({ value })}
            class="ml-(--indent) max-w-60"
            well={a.well}
            mono={a.mono}
            disabled={a.disabled}
            suggestions={["登录页", "首页"]}
          />
          <PxTextArea
            label="说明"
            value={a.value}
            onChange={(value) => set({ value })}
            class="ml-(--indent) max-w-60"
            reading={a.reading}
            mono={a.mono}
            disabled={a.disabled}
          />
          <PxButton data-testid="resize-pixel-composition" onClick={() => set({ width: 360, indent: 16 })}>
            改尺寸
          </PxButton>
        </PxWindow>
      ),
    }),
    Card: story({
      args: { title: "今天的收成", aside: "3 块地" },
      render: (a) => (
        <PxCard title={a.title} aside={a.aside} class="w-72">
          <p>两块熟了，一块缺肥。</p>
          <DashedLine class="my-3" />
          <PxButton tone="primary" onClick={() => undefined}>
            去看看
          </PxButton>
        </PxCard>
      ),
    }),
    Window: story({
      args: { border: true },
      render: (a) => (
        <PxWindow border={a.border} class="w-64 p-4">
          窗子里的纸
        </PxWindow>
      ),
    }),
    Frame: story({
      args: { paper: "bg-cream-50" },
      controls: { paper: { kind: "choice", options: ["bg-cream-50", "bg-cream-100", "bg-lcd-paper"] } },
      render: (a) => (
        <PxFrame paperClass={paperChoices[a.paper]} class="w-56">
          <div class="p-3">框里的东西离边 2 像素</div>
        </PxFrame>
      ),
    }),
  },
});
