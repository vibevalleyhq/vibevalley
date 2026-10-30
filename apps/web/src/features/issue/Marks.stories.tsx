import { For } from "solid-js";

import { IssueStatusValues, PriorityValues } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";

import type { Tone } from "./cards";
import { FlagChip, NoFaceMark, PriorityMark, ProgressMark, StatusMark } from "./Marks";

const tones: Tone[] = ["berry", "wheat", "water", "leaf", "faint", "muted"];

export default stories({
  title: "组件/工单/标记",
  stories: {
    Status: story({
      note: "工单的状态圈：画法跟着状态，颜色跟着令牌。",
      render: () => (
        <div class="flex flex-wrap gap-4">
          <For each={IssueStatusValues}>
            {(status) => (
              <span class="flex items-center gap-1.5 font-mono text-2xs text-muted">
                <StatusMark status={status} />
                {status}
              </span>
            )}
          </For>
        </div>
      ),
    }),
    Priority: story({
      render: () => (
        <div class="flex flex-wrap gap-4">
          <For each={PriorityValues}>
            {(priority) => (
              <span class="flex items-center gap-1.5 font-mono text-2xs text-muted">
                <PriorityMark priority={priority} />
                {priority}
              </span>
            )}
          </For>
        </div>
      ),
    }),
    Progress: story({
      args: { done: 2, total: 5 },
      controls: { done: { kind: "number", min: 0, max: 10 }, total: { kind: "number", min: 1, max: 10 } },
      render: (a) => <ProgressMark done={a.done} total={a.total} />,
    }),
    Flags: story({
      render: () => (
        <div class="flex flex-wrap items-center gap-2">
          <For each={tones}>{(tone) => <FlagChip text={tone} tone={tone} />}</For>
          <NoFaceMark />
        </div>
      ),
    }),
  },
});
