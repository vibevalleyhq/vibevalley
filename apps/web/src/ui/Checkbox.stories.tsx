import { stories, story } from "@vibevalley/stories";
import { Checkbox } from "./Checkbox";

export default stories({
  title: "ui/Checkbox",
  stories: {
    Playground: story({
      args: { checked: true, indeterminate: false, disabled: false },
      render: (a, set) => (
        <label class="flex items-center gap-2 text-sm">
          <Checkbox label="完成" checked={a.checked} indeterminate={a.indeterminate} disabled={a.disabled} onChange={(checked) => set({ checked })} />
          完成
        </label>
      ),
    }),
    States: story({
      render: () => (
        <div class="flex items-center gap-3">
          <Checkbox label="没勾" checked={false} onChange={() => undefined} />
          <Checkbox label="勾上" checked onChange={() => undefined} />
          <Checkbox label="一部分" checked={false} indeterminate onChange={() => undefined} />
          <Checkbox label="不能改" checked disabled onChange={() => undefined} />
        </div>
      ),
    }),
  },
});
