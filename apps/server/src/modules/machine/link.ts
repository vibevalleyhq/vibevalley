import { Array as Arr, Effect } from "effect";

import type { Executions } from "./executor.ts";

// Clone every payload in-process so non-serializable values or shared-reference mutations surface in tests.
const across = <A>(value: A): A => structuredClone(value);

export type { Executions };

export const linked = (executor: Executions): Executions => ({
  start: (input) => Effect.map(executor.start(across(input)), across),
  deliver: (id, text, inputId) => Effect.map(executor.deliver(id, text, inputId), across),
  interrupt: (id) => Effect.map(executor.interrupt(id), across),
  close: (id) => executor.close(id),
  failed: (id, why) => Effect.map(executor.failed(id, why), across),
  observe: (id, observer) =>
    executor.observe(id, {
      event: (event) => observer.event(across(event)),
      connection: (connection) => observer.connection(across(connection)),
      input: (input) => observer.input(across(input)),
      report: (report) => observer.report(across(report)),
      tasksChanged: observer.tasksChanged,
      stalled: observer.stalled,
      stallMs: observer.stallMs,
    }),
  detach: executor.detach,
  find: (id) => {
    const execution = executor.find(id);
    return execution === undefined ? undefined : across(execution);
  },
  all: () => Arr.map(executor.all(), across),
});
