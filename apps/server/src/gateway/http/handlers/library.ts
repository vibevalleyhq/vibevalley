import type { LibraryHandlers } from "@vibevalley/protocol/api";

import type { Library } from "#/modules/library/library.ts";

// Over HTTP it is the user (here or through the gate); helpers and assistants reach the library through their tools.
export function libraryHandlers(deps: { readonly library: Library }): LibraryHandlers {
  const { library } = deps;
  return {
    "library.item.list": (req) => library.list(req),
    "library.item.add": (req) => library.add(req, { kind: "user" }),
    "library.item.delete": ({ id }) => library.remove(id),
    "library.item.previewDelete": ({ id }) => library.previewRemove(id),
  };
}
