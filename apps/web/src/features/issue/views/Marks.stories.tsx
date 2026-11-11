import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { IssueStatusValues, PriorityValues } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";

import type { Tone } from "#/features/issue/model/cards.ts";

import { FlagChip, NoFaceMark, PriorityMark, ProgressMark, StatusMark } from "./Marks";

const viewStyles = stylex.create({
  marksStoriesDiv: {
    display: "flex",
    flexWrap: "wrap",
    gap: "1rem",
  },
  marksStoriesSpan: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--leading-2xs)",
    color: "var(--color-muted)",
  },
  marksStoriesDiv2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
});

const tones: Tone[] = ["berry", "wheat", "water", "leaf", "faint", "muted"];

export default stories({
  title: "组件/工单/标记",
  stories: {
    Status: story({
      note: "工单的状态圈：画法跟着状态，颜色跟着令牌。",
      render: () => (
        <div {...stylex.attrs(viewStyles.marksStoriesDiv)}>
          <For each={IssueStatusValues}>
            {(status) => (
              <span {...stylex.attrs(viewStyles.marksStoriesSpan)}>
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
        <div {...stylex.attrs(viewStyles.marksStoriesDiv)}>
          <For each={PriorityValues}>
            {(priority) => (
              <span {...stylex.attrs(viewStyles.marksStoriesSpan)}>
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
        <div {...stylex.attrs(viewStyles.marksStoriesDiv2)}>
          <For each={tones}>{(tone) => <FlagChip text={tone} tone={tone} />}</For>
          <NoFaceMark />
        </div>
      ),
    }),
  },
});
