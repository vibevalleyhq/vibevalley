import { stories, story } from "@vibevalley/stories";
import { PxChipsInput } from "./forms";

export default stories({
  title: "组件/像素/forms",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    Chips: story({
      args: { words: "frontend,urgent", disabled: false },
      render: (a, set) => (
        <div class="w-80">
          <PxChipsInput
            label="标签"
            placeholder="加一个"
            value={a.words ? a.words.split(",") : []}
            disabled={a.disabled}
            onChange={(v) => set({ words: v.join(",") })}
          />
        </div>
      ),
    }),
  },
});
