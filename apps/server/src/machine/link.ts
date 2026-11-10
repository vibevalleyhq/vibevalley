import { Array as Arr, Effect } from "effect";

import type { Executor } from "#/executor/executor.ts";

// What crosses between the server and a machine goes over a wire. In one process the link copies every value, so what
// would not survive the wire fails here, in the tests, before a second process exists: a function is refused, and no
// object is shared by both sides.

/** value as it arrives on the other side of the link: a copy, none of its objects the sender's. */
export const across = <A>(value: A): A => structuredClone(value);

/** A machine's executions as the server reaches them: the calls Session makes on the helpers' runs there. */
export type Executions = Executor["Service"];

/** A machine's executor, reached over the link in this process. */
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
