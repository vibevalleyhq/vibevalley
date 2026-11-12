# @vibevalley/async

The few async pieces the repository builds on instead of Effect: plain promises, `AbortSignal` and `await using`, no
dependencies, the same in Node and the page. How to use them in this repository (who owns a task, where a signal comes
from, how a test drives the clock): [vv-typescript](.agents/skills/vv-typescript/SKILL.md).

| File | Exports | For |
|---|---|---|
| `src/abort.ts` | `abortError`, `isAbort`, `throwIfAborted`, `reasonOf`, `anySignal`, `abortable` | telling an abort from a failure, joining signals, a promise that gives up when its signal aborts |
| `src/clock.ts` | `Clock`, `sleep`, `systemClock` | time passed in as a value, so a test hands its own clock |
| `src/tasks.ts` | `TaskGroup`, `Task` | background work owned by a service: every task gets a signal, `close()` aborts them and waits for them all; keyed tasks replace the one before |
| `src/queue.ts` | `Queue` | one reader at a time; `offer` never waits, overflow `unbounded`, `sliding` or `dropping` |
| `src/hub.ts` | `Hub`, `Subscription` | news for many readers: each subscription gets what was published after it subscribed |
| `src/semaphore.ts` | `Semaphore` | n permits, first come first served; a lock is a semaphore of one |
| `src/retry.ts` | `retry`, `exponential`, `withTimeout`, `timeoutError` | trying again with a delay (never after an abort), a deadline on a call |
| `src/streams.ts` | `merge`, `map`, `lines`, `collect`, `mapConcurrent` | async iterables: several into one, text into lines, a list with bounded concurrency |

```bash
vp run test     # vitest: src/async.test.ts
```
