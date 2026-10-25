import { Cause, Effect, Queue, Stream } from "effect";

export const bounded = <A>(source: Stream.Stream<A>, name: string, capacity = 64): Stream.Stream<A> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<A, Cause.Done>(capacity);
      let overflowed = false;
      yield* Effect.gen(function* () {
        yield* Stream.runDrain(
          source.pipe(
            Stream.tap((value) => {
              if (overflowed) return Effect.void;
              if (Queue.offerUnsafe(queue, value)) return Effect.void;
              overflowed = true;
              return Effect.logWarning(`vibevalley: ${name}: slow subscription closed`).pipe(Effect.andThen(Queue.shutdown(queue)));
            }),
          ),
        );
        yield* Queue.end(queue);
      }).pipe(Effect.forkScoped);
      return Stream.fromQueue(queue);
    }),
  );
