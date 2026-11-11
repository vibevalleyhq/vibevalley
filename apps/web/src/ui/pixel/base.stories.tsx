import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { DashedLine, PxCard, PxFrame, PxWindow } from "./base";
import { PxButton } from "./button";
import { PxTextArea, PxTextInput } from "./field";
import { storyFrame } from "./story.stylex";

const styles = stylex.create({
  baseStoriesPxCard: {
    width: "18rem",
  },
  baseStoriesDashedLine: {
    marginBlock: "0.75rem",
  },
  baseStoriesPxWindow: {
    width: "16rem",
    padding: "1rem",
  },
  baseStoriesPxFrame: {
    width: "14rem",
  },
  composedWindow: (width: number) => ({ width, marginLeft: "12px", padding: "0.75rem" }),
  composedControl: (marginLeft: number) => ({ marginLeft, maxWidth: "240px" }),
  baseStoriesDiv: {
    padding: "0.75rem",
  },
});

const papers = stylex.create({
  "bg-cream-50": { backgroundColor: "var(--color-cream-50)" },
  "bg-cream-100": { backgroundColor: "var(--color-cream-100)" },
  "bg-lcd-paper": { backgroundColor: "var(--color-lcd-paper)" },
});

const paperChoices: Record<string, stylex.StyleXStyles<{ backgroundColor?: string }>> = papers;

export default stories({
  title: "组件/像素/base",
  themes: ["light"],
  frame: storyFrame.pixel,
  stories: {
    Composition: story({
      args: { width: 300, indent: 4, border: true, value: "", well: false, mono: false, disabled: false, reading: false },
      render: (a, set) => (
        <PxWindow testid="pixel-window-composition" border={a.border} styles={styles.composedWindow(a.width)} style={{ "margin-top": "8px" }}>
          <PxTextInput
            testid="pixel-input-composition"
            label="名字"
            value={a.value}
            onChange={(value) => set({ value })}
            styles={styles.composedControl(a.indent)}
            well={a.well}
            mono={a.mono}
            disabled={a.disabled}
            suggestions={["登录页", "首页"]}
          />
          <PxTextArea
            label="说明"
            value={a.value}
            onChange={(value) => set({ value })}
            styles={styles.composedControl(a.indent)}
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
        <PxCard title={a.title} aside={a.aside} styles={[styles.baseStoriesPxCard]}>
          <p>两块熟了，一块缺肥。</p>
          <DashedLine styles={[styles.baseStoriesDashedLine]} />
          <PxButton tone="primary" onClick={() => undefined}>
            去看看
          </PxButton>
        </PxCard>
      ),
    }),
    Window: story({
      args: { border: true },
      render: (a) => (
        <PxWindow border={a.border} styles={[styles.baseStoriesPxWindow]}>
          窗子里的纸
        </PxWindow>
      ),
    }),
    Frame: story({
      args: { paper: "bg-cream-50" },
      controls: { paper: { kind: "choice", options: ["bg-cream-50", "bg-cream-100", "bg-lcd-paper"] } },
      render: (a) => (
        <PxFrame paper={paperChoices[a.paper]} styles={[styles.baseStoriesPxFrame]}>
          <div {...stylex.attrs(styles.baseStoriesDiv)}>框里的东西离边 2 像素</div>
        </PxFrame>
      ),
    }),
  },
});
