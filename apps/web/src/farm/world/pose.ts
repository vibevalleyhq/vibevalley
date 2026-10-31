import type { Pose } from "./world.ts";

/** How long one pose stays on screen, so fast tool calls are seen one at a time. */
export const poseMinMs = 800;

/** The pose an actor shows: the newest wanted one, but only after the last change has been up for poseMinMs. A burst of
 * actions keeps only the newest, and when the burst ends the picture catches up within one poseMinMs. */
export class PoseHold {
  private shown: Pose;
  private wanted: Pose;
  private since: number;

  constructor(pose: Pose, now: number) {
    this.shown = pose;
    this.wanted = pose;
    this.since = now;
  }

  next(want: Pose, now: number): Pose {
    this.wanted = want;
    if (want !== this.shown && now - this.since >= poseMinMs) {
      this.shown = want;
      this.since = now;
    }
    return this.shown;
  }
}
