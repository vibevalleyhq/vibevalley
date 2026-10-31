// How the board looks on this machine: kept across reloads (state/stored.ts), each part falling back on its own.

import { Schema } from "effect";

import { defineStored, orFallback } from "@/state/stored";

import { boardViews, defaultLook, groupings, orderings } from "./display";

export const boardLook = defineStored(
  "board.look",
  Schema.Struct({
    view: orFallback(Schema.Literals(boardViews), defaultLook.view),
    grouping: orFallback(Schema.Literals(groupings), defaultLook.grouping),
    ordering: orFallback(Schema.Literals(orderings), defaultLook.ordering),
  }),
  defaultLook,
);
