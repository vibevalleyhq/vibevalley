import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { SessionActionValues, type Phase, type SessionAction } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";

import { ActionGlyph, Marked, PhaseGlyph, SpriteIcon } from "./icons";
import { storyFrame } from "./story.stylex";

const viewStyles = stylex.create({
  composed: (offset: number) => ({ marginLeft: offset, rotate: "90deg" }),
  iconsStoriesDiv: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 3)",
  },
  iconsStoriesDiv2: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 4)",
  },
  iconsStoriesSpan: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  iconsStoriesSpan2: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
  },
  iconsStoriesDiv3: {
    width: "calc(var(--spacing) * 64)",
  },
});

const sprites = ["icon-seeds", "icon-shovel", "icon-water", "icon-bell", "icon-coin", "icon-shed", "icon-tree", "icon-bug", "icon-trophy", "icon-wrench"];
const working = (action: SessionAction) => ({ _tag: "working", since: 0, doing: { action } }) as Phase;
const phases: [string, Phase][] = [
  ["starting", working("none")],
  ["working", working("edit_file")],
  ["done", { _tag: "done" }],
  ["failed", { _tag: "failed" }],
  ["resting", { _tag: "resting" }],
];

export default stories({
  title: "组件/像素/icons",
  themes: ["light"],
  frame: storyFrame.pixel,
  stories: {
    Composition: story({
      args: { size: 24, offset: 12 },
      controls: {
        size: { kind: "number", min: 12, max: 48, step: 4 },
        offset: { kind: "number", min: 0, max: 32, step: 4 },
      },
      render: (a) => (
        <SpriteIcon name="button-next" size={a.size} label="Composed sprite" styles={viewStyles.composed(a.offset)} style={{ "margin-top": "8px" }} />
      ),
    }),
    Sprites: story({
      args: { size: 24 },
      controls: { size: { kind: "number", min: 12, max: 48, step: 4 } },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.iconsStoriesDiv)}>
          <For each={sprites}>{(name) => <SpriteIcon name={name} size={a.size} label={name} />}</For>
        </div>
      ),
    }),
    Actions: story({
      note: "帮工这会儿在做的事。",
      render: () => (
        <div {...stylex.attrs(viewStyles.iconsStoriesDiv2)}>
          <For each={SessionActionValues}>
            {(action) => (
              <span {...stylex.attrs(viewStyles.iconsStoriesSpan)}>
                <ActionGlyph action={action} />
                <span {...stylex.attrs(viewStyles.iconsStoriesSpan2)}>{action}</span>
              </span>
            )}
          </For>
        </div>
      ),
    }),
    Phases: story({
      render: () => (
        <div {...stylex.attrs(viewStyles.iconsStoriesDiv2)}>
          <For each={phases}>
            {([name, phase]) => (
              <span {...stylex.attrs(viewStyles.iconsStoriesSpan)}>
                <PhaseGlyph phase={phase} />
                <span {...stylex.attrs(viewStyles.iconsStoriesSpan2)}>{name}</span>
              </span>
            )}
          </For>
        </div>
      ),
    }),
    Marked: story({
      render: () => (
        <div {...stylex.attrs(viewStyles.iconsStoriesDiv3)}>
          <Marked mark="icon-bell">管家说：两块地熟了，可以去看改动了。</Marked>
        </div>
      ),
    }),
  },
});
