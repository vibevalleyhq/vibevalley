import { z } from "zod";

import { transport } from "../../infra/transport";

const Playback = z.object({ phase: z.enum(["idle", "playing", "draining", "stopping"]), problem: z.string().nullable() });
const POLL_MS = 250;

export function playSpeech(id: string, changed: (state: "playing" | "done" | "finished") => void, failed: (error: string) => void) {
  const bridge = transport();
  let stopped = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const call = async (op: string, payload: Record<string, unknown>) => {
    const reply = await bridge.call(op, { ...payload, id });
    if (reply.bizCode !== 0) throw new Error(reply.message);
    return Playback.parse(reply.data);
  };
  const problem = (error: unknown) => failed(error instanceof Error ? error.message : String(error));
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clear();
    void call("host.speechStop", {}).catch(problem);
  };
  const schedule = () => {
    if (!stopped && !finished) {
      timer = setTimeout(() => void poll(), POLL_MS);
    }
  };
  const poll = async () => {
    if (stopped || finished) return;
    try {
      const state = await call("host.speechState", {});
      if (stopped) return;
      if (state.problem) {
        finished = true;
        clear();
        failed(state.problem);
      } else if (state.phase === "idle") {
        finished = true;
        clear();
        changed("finished");
      } else if (state.phase === "draining") {
        changed("done");
      }
    } catch (error) {
      finished = true;
      stop();
      problem(error);
    } finally {
      if (!stopped && !finished) {
        schedule();
      }
    }
  };
  void call("host.speechStart", { id })
    .then(async () => {
      if (stopped) {
        await call("host.speechStop", {});
        return;
      }
      changed("playing");
      schedule();
    })
    .catch((error: unknown) => {
      if (!stopped) {
        stopped = true;
        problem(error);
      }
    });
  return stop;
}
