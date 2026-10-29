import { stories, story } from "@vibevalley/stories";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field, TextInput } from "./Field";

export default stories({
  title: "ui/Dialog",
  stories: {
    Form: story({
      note: "模态的 <dialog> 盖在整页上：一次只开一个主题看。",
      args: { open: false, wide: false, title: "新建项目" },
      render: (a, set) => (
        <>
          <Button onClick={() => set({ open: true })}>打开</Button>
          <Dialog open={a.open} wide={a.wide} title={a.title} onClose={() => set({ open: false })}>
            <div class="flex flex-col gap-3">
              <Field label="名字">
                <TextInput placeholder="vibevalley" />
              </Field>
              <div class="flex justify-end gap-2">
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
