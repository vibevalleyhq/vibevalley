import type { JSX } from "@solidjs/web";

import { stories, story } from "@vibevalley/stories";

import { Checkbox } from "./Checkbox";

const viewStyles = {
  placement: (offset: number): JSX.CSSProperties => ({ "--offset": `${offset}px` }),
};

export default stories({
  title: "组件/工作台/Checkbox",
  stories: {
    Placement: story({
      args: { checked: false, indeterminate: false, disabled: false, offset: 12 },
      controls: { offset: { kind: "number", min: 0, max: 32 } },
      render: (a, set) => (
        <div class="contents" style={viewStyles.placement(a.offset)}>
          <Checkbox
            testid="checkbox-placement"
            label="Placement"
            checked={a.checked}
            indeterminate={a.indeterminate}
            disabled={a.disabled}
            class="ml-(--offset)"
            onChange={(checked) => set({ checked })}
          />
        </div>
      ),
    }),
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
