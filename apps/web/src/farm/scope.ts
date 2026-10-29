// One project's farm: the frame with only that project's sessions on it (protocol's farmOf), for what the farm page
// draws and does with its beds. The rest of the frame (the inbox, the chat, the level, the effects) is the whole farm's.

import type { StateFrame } from "@vibevalley/protocol";
import { farmOf } from "@vibevalley/protocol/rules";
const made = new WeakMap<StateFrame, { project: string; frame: StateFrame }>();

/** The same frame and project give back the same object, so a reader comparing frames sees no change. */
export function farmFrameOf(frame: StateFrame | undefined, project: string): StateFrame | undefined {
  if (!frame) return undefined;
  const was = made.get(frame);
  if (was?.project === project) return was.frame;
  const scoped = { ...frame, state: { ...frame.state, sessions: frame.state.sessions.filter((h) => farmOf(h) === project) } };
  made.set(frame, { project, frame: scoped });
  return scoped;
}
