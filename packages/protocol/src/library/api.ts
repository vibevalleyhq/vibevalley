import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const itemInput = input({ id: z.string() });

export interface LibraryHandlers {
  /** Newest first. */
  readonly "library.item.list": (a: T.LibraryListRequest) => Promise<T.LibraryItem[]>;
  readonly "library.item.add": (a: T.LibraryAddRequest) => Promise<T.LibraryItem>;
  /** Only the item goes: a message that has the file still opens it. */
  readonly "library.item.delete": (a: { readonly id: string }) => Promise<void>;
  readonly "library.item.previewDelete": (a: { readonly id: string }) => Promise<T.Preview>;
}

export const libraryEndpoints: readonly Endpoint[] = [
  { op: "library.item.list", about: [], input: S.LibraryListRequest, result: S.LibraryItems, can: ["user", "remote", "orchestrator", "session"] },
  { op: "library.item.add", about: [], input: S.LibraryAddRequest, result: S.LibraryItem, can: ["user", "remote", "orchestrator", "session"] },
  { op: "library.item.delete", about: ["id"], input: itemInput, result: undefined, can: ["user", "remote"], dryRun: "library.item.previewDelete" },
  { op: "library.item.previewDelete", about: ["id"], input: itemInput, result: S.Preview, can: ["user", "remote"] },
];
