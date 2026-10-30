import { stories, story } from "@vibevalley/stories";

import { CrossMark, TickMark } from "./glyphs";

export default stories({
  title: "组件/像素/glyphs",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    Marks: story({
      args: { size: 16 },
      controls: { size: { kind: "number", min: 8, max: 48, step: 4 } },
      render: (a) => (
        <div class="flex items-center gap-4">
          <TickMark size={a.size} color="var(--color-leaf-600)" label="对" />
          <CrossMark size={a.size} color="var(--color-berry-500)" label="错" />
        </div>
      ),
    }),
  },
});
