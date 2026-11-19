import { z } from "zod";

import { transport } from "../../infra/transport";

const Playback = z.object({ phase: z.enum(["idle", "playing", "draining", "stopping"]), problem: z.string().nullable() });

export function playSpeech(id: string, changed: (state: "playing" | "done" | "finished") => void, failed: (error: string) => void) {
  const bridge = transport();
  let stopped = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const call = async (op: string, payload: Record<string, unknown>) => {
    const reply = await bridge.call(op, { ...payload, id });
    if (reply.bizCode !== 0) throw new Error(reply.message);
    return Playback.parse(reply.data);
  };
  const problem = (error: unknown) => failed(error instanceof Error ? error.message : String(error));
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    void call("host.speechStop", {}).catch(problem);
  };
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const state = await call("host.speechState", {});
      if (stopped) return;
      if (state.problem) {
        clearInterval(timer);
        failed(state.problem);
      } else if (state.phase === "idle") {
        clearInterval(timer);
        changed("finished");
      } else if (state.phase === "draining") changed("done");
    } catch (error) {
      stop();
      problem(error);
    } finally {
      polling = false;
    }
  };
  void call("host.speechStart", { id })
    .then(async () => {
      if (stopped) {
        await call("host.speechStop", {});
        return;
      }
      changed("playing");
      timer = setInterval(() => void poll(), 100);
    })
    .catch((error: unknown) => {
      if (!stopped) {
        stopped = true;
        problem(error);
      }
    });
  return stop;
}
