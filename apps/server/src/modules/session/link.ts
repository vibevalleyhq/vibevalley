import type { Executions } from "./executor.ts";

// Clone every payload in-process so non-serializable values or shared-reference mutations surface in tests.
const across = <A>(value: A): A => structuredClone(value);

export type { Executions };

export const linked = (executor: Executions): Executions => ({
  start: async (input) => across(await executor.start(across(input))),
  deliver: async (id, text, inputId) => across(await executor.deliver(id, text, inputId)),
  interrupt: async (id) => across(await executor.interrupt(id)),
  close: (id, signal) => executor.close(id, signal),
  failed: async (id, why) => across(await executor.failed(id, why)),
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
  all: () => executor.all().map(across),
});
