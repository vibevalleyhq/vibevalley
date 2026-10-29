import { stories, story } from "@vibevalley/stories";
import { Segmented } from "./Segmented";

type View = "list" | "board" | "farm";

export default stories({
  title: "组件/工作台/Segmented",
  stories: {
    States: story({
      args: { block: false },
      grid: { cols: "pseudo" },
      render: (a) => (
        <Segmented<View>
          label="视图"
          value="list"
          block={a.block}
          onChange={() => undefined}
          options={[
            { value: "list", label: "列表" },
            { value: "board", label: "看板" },
          ]}
        />
      ),
    }),
    Playground: story({
      note: "换选项时底块滑过去。",
      args: { value: "list", block: false },
      controls: { value: { kind: "choice", options: ["list", "board", "farm"] } },
      render: (a, set) => (
        <Segmented<View>
          label="视图"
          value={a.value as View}
          block={a.block}
          onChange={(value) => set({ value })}
          options={[
            { value: "list", label: "列表" },
            { value: "board", label: "看板" },
            { value: "farm", label: "农场", disabled: true, title: "还没有" },
          ]}
        />
      ),
    }),
  },
});
