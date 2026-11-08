import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field, TextInput } from "./Field";

const viewStyles = stylex.create({
  dialogStoriesDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  dialogStoriesDiv2: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "calc(var(--spacing) * 2)",
  },
});

export default stories({
  title: "组件/工作台/Dialog",
  stories: {
    Form: story({
      note: "模态的 <dialog> 盖在整页上：一次只开一个主题看。",
      args: { open: false, wide: false, title: "新建仓库" },
      render: (a, set) => (
        <>
          <Button onClick={() => set({ open: true })}>打开</Button>
          <Dialog open={a.open} wide={a.wide} title={a.title} onClose={() => set({ open: false })}>
            <div {...stylex.attrs(viewStyles.dialogStoriesDiv)}>
              <Field label="名字">
                <TextInput placeholder="vibevalley" />
              </Field>
              <div {...stylex.attrs(viewStyles.dialogStoriesDiv2)}>
                <Button onClick={() => set({ open: false })}>取消</Button>
                <Button tone="primary" onClick={() => set({ open: false })}>
                  建好
                </Button>
              </div>
            </div>
          </Dialog>
        </>
      ),
    }),
  },
});
