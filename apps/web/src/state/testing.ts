// For the rules' tests: a registry whose frames come from the test (infra/testing.ts), not from a server.

import { type TestFrames, testFrames } from "@/infra/testing";

import { createRegistry, framesSource } from "./atom";

export function testRegistry(frames: TestFrames = testFrames()) {
  const registry = createRegistry();
  registry.set(framesSource, frames.source);
  return registry;
}

/** A promise the test settles. */
export function deferred<T>() {
  const ends: { resolve: (value: T) => void; reject: (e: unknown) => void }[] = [];
  const promise = new Promise<T>((resolve, reject) => void ends.push({ resolve, reject }));
  const [end] = ends;
  if (!end) throw new Error("a Promise runs its executor at once");
  return { promise, ...end };
}
