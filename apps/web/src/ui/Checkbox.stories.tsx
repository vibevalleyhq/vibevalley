import { stories, story } from "@vibevalley/stories";
import { Checkbox } from "./Checkbox";

export default stories({
  title: "组件/工作台/Checkbox",
  stories: {
    States: story({
      args: { state: "on", disabled: false },
      grid: { rows: ["state", ["off", "on", "partly"]], cols: "pseudo" },
      render: (a) => <Checkbox label="完成" checked={a.state === "on"} indeterminate={a.state === "partly"} disabled={a.disabled} onChange={() => undefined} />,
    }),
    Playground: story({
      args: { checked: true, indeterminate: false, disabled: false },
      render: (a, set) => (
        <label class="flex items-center gap-2 text-sm">
          <Checkbox label="完成" checked={a.checked} indeterminate={a.indeterminate} disabled={a.disabled} onChange={(checked) => set({ checked })} />
          完成
        </label>
      ),
    }),
  },
});
