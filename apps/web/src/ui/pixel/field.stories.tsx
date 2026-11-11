import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { PxField, PxTextArea, PxTextInput, PxTip } from "./field";
import { storyFrame } from "./story.stylex";

const viewStyles = stylex.create({
  fieldStoriesDiv: {
    width: "18rem",
  },
  fieldStoriesDiv2: {
    width: "24rem",
  },
  fieldStoriesSpan: {
    borderBottomStyle: "dotted",
    borderBottomWidth: "2px",
    borderStyle: "dotted",
    borderColor: "var(--color-bark-500)",
  },
});

export default stories({
  title: "组件/像素/field",
  themes: ["light"],
  frame: storyFrame.pixel,
  stories: {
    Text: story({
      args: { value: "", error: "", required: true, mono: false, disabled: false },
      render: (a, set) => (
        <div {...stylex.attrs(viewStyles.fieldStoriesDiv)}>
          <PxField label="地的名字" tip="写在地头的木牌上" error={a.error || undefined} required={a.required}>
            {(id) => (
              <PxTextInput
                id={id}
                value={a.value}
                mono={a.mono}
                disabled={a.disabled}
                placeholder="登录页"
                suggestions={["登录页", "设置页", "首页"]}
                onChange={(value) => set({ value })}
              />
            )}
          </PxField>
        </div>
      ),
    }),
    "Long text": story({
      args: { value: "修好登录：过期的会话回到登录页。", reading: true },
      render: (a, set) => (
        <div {...stylex.attrs(viewStyles.fieldStoriesDiv2)}>
          <PxField label="说明">{(id) => <PxTextArea id={id} rows={5} value={a.value} reading={a.reading} onChange={(value) => set({ value })} />}</PxField>
        </div>
      ),
    }),
    Tip: story({
      render: () => (
        <PxTip tip="悬停才出来">
          <span {...stylex.attrs(viewStyles.fieldStoriesSpan)}>这是什么</span>
        </PxTip>
      ),
    }),
  },
});
