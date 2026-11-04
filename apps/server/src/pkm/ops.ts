// The rule both sides run (packages/protocol/src/rules/pkm.ts): change it there and here together.

import type * as T from "@vibevalley/protocol";
import { applyBlockOps } from "@vibevalley/protocol/rules";

import type { Node } from "./outline.ts";

/** The blocks after the ops in order (a copy: blocks is not changed). newId makes the id of a block inserted without one. */
export const applyOps = (blocks: readonly Node[], ops: readonly T.PkmBlockOp[], newId: () => string): Node[] =>
  applyBlockOps(blocks, ops, (fields): Node => ({ ...fields, explicit: false, children: [] }), newId);
