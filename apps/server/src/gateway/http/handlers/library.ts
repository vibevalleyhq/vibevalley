import type { LibraryHandlers } from "@vibevalley/protocol/api";

import type { Media } from "#/modules/media/media.ts";

// Over HTTP it is the user (here or through the gate); helpers and assistants reach the library through their tools.
export function libraryHandlers(deps: { readonly media: Media }): LibraryHandlers {
  const { media } = deps;
  return {
    "library.item.list": (req) => media.libraryItems(req),
    "library.item.add": (req) => media.addLibraryItem(req, { kind: "user" }),
    "library.item.delete": ({ id }) => media.removeLibraryItem(id),
    "library.item.previewDelete": ({ id }) => media.previewRemoveLibraryItem(id),
  };
}
