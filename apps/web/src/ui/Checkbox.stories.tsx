import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { Checkbox } from "./Checkbox";

const viewStyles = stylex.create({
  placement: (offset: number) => ({ marginLeft: offset }),
  checkboxStoriesLabel: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
});

export default stories({
  title: "组件/工作台/Checkbox",
  stories: {
    Placement: story({
      args: { checked: false, indeterminate: false, disabled: false, offset: 12 },
      controls: { offset: { kind: "number", min: 0, max: 32 } },
      render: (a, set) => (
        <Checkbox
          testid="checkbox-placement"
          label="Placement"
          checked={a.checked}
          indeterminate={a.indeterminate}
          disabled={a.disabled}
          styles={viewStyles.placement(a.offset)}
          onChange={(checked) => set({ checked })}
        />
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
        <label {...stylex.attrs(viewStyles.checkboxStoriesLabel)}>
          <Checkbox label="完成" checked={a.checked} indeterminate={a.indeterminate} disabled={a.disabled} onChange={(checked) => set({ checked })} />
          完成
        </label>
      ),
    }),
  },
});
