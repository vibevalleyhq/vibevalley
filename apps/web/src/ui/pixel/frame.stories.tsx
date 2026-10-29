import { stories, story } from "@vibevalley/stories";
import { PxFrame } from "./frame";

export default stories({
  title: "组件/像素/PxFrame",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    Frame: story({
      args: { paper: "bg-cream-50" },
      controls: { paper: { kind: "choice", options: ["bg-cream-50", "bg-cream-100", "bg-lcd-paper"] } },
      render: (a) => (
        <PxFrame paper={a.paper} class="w-56">
          <div class="p-3">框里的东西离边 2 像素</div>
        </PxFrame>
      ),
    }),
  },
});
