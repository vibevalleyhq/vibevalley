import type { Memory } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";
import { MemoryItem } from "./Memory";

const now = Date.now();
const day = 86_400_000;

const memory = (text: string, more: Partial<Memory> = {}): Memory => ({
  id: text.slice(0, 6),
  agent: "老周",
  kind: "note",
  text,
  at: now - 3 * day,
  recalled: 4,
  recalledAt: now - day,
  ...more,
});

export default stories({
  title: "组件/记性/一条记性",
  stories: {
    States: story({
      note: "记得的一条：平常的、快要忘掉的（淡一点，带提醒）、能忘掉的（悬停出「忘掉」）。",
      args: { state: "kept" },
      grid: { rows: ["state", ["kept", "fading", "forgettable"]], cols: "pseudo" },
      render: (a) => (
        <div class="w-[30rem]">
          <MemoryItem
            memory={memory("这个项目的测试用 vp test；不要开 next dev。", { fading: a.state === "fading" })}
            meta={["主人写的", "vibevalley", "想起过 4 次"]}
            faded={a.state === "fading"}
            warning={a.state === "fading" ? "30 天没想起，下周会忘掉" : undefined}
            onForget={a.state === "forgettable" ? () => undefined : undefined}
          />
        </div>
      ),
    }),
  },
});
