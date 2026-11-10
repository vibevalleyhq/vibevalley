import { Effect } from "effect";

import type { LibraryHandlers } from "@vibevalley/protocol/api";

import { Library } from "#/library/library.ts";

// Over HTTP it is the user (here or through the gate); helpers and assistants reach the library through their tools.
export const libraryHandlers = Effect.gen(function* () {
  const library = yield* Library;
  const done: LibraryHandlers = {
    "library.item.list": (req) => library.list(req),
    "library.item.add": (req) => library.add(req, { kind: "user" }),
    "library.item.delete": ({ id }) => library.remove(id),
    "library.item.previewDelete": ({ id }) => library.previewRemove(id),
  };
  return done;
});
