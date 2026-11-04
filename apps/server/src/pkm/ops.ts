// The ops on a page's outline (T.PkmBlockOp), in memory: a pure function of the blocks and the op. An op on a block not on
// the page changes nothing.

import type * as T from "@vibevalley/protocol";

import type { Node } from "./outline.ts";

interface Place {
  readonly node: Node;
  readonly siblings: Node[];
  readonly index: number;
  readonly parent: Node | undefined;
}

function locate(siblings: Node[], id: string, parent?: Node): Place | undefined {
  for (const [index, node] of siblings.entries()) {
    if (node.id === id) return { node, siblings, index, parent };
    const inside = locate(node.children, id, node);
    if (inside) return inside;
  }
  return undefined;
}

const cycle: Partial<Record<T.PkmMarker, T.PkmMarker>> = { TODO: "DOING", DOING: "DONE", DONE: "TODO", LATER: "NOW", NOW: "DONE" };

/** A new block from what an insert gives; id when the inserter gave none. */
const made = (op: { id?: string; body: string; marker?: T.PkmMarker; priority?: T.PkmPriority; props?: Record<string, string> }, id: () => string): Node => ({
  id: op.id ?? id(),
  depth: 0,
  ...(op.marker ? { marker: op.marker } : {}),
  ...(op.priority ? { priority: op.priority } : {}),
  body: op.body,
  props: { ...op.props },
  explicit: false,
  children: [],
});

/** The blocks after the ops in order (a copy: blocks is not changed). newId makes the id of a block inserted without one. */
export function applyOps(blocks: readonly Node[], ops: readonly T.PkmBlockOp[], newId: () => string): Node[] {
  const roots = structuredClone([...blocks]);
  for (const op of ops) applyOne(roots, op, newId);
  return renumber(roots);
}

function applyOne(roots: Node[], op: T.PkmBlockOp, newId: () => string) {
  if (op.op === "append") {
    roots.push(made(op, newId));
    return;
  }
  const at = locate(roots, op.block);
  if (!at) return;
  const { node, siblings, index } = at;
  switch (op.op) {
    case "insert_after":
      siblings.splice(index + 1, 0, made(op, newId));
      return;
    case "insert_child":
      node.children.push(made(op, newId));
      return;
    case "update":
      if (op.body !== undefined) node.body = op.body;
      if (op.priority !== undefined) node.priority = op.priority;
      if (op.props) Object.assign(node.props, op.props);
      return;
    case "set_marker":
      if (op.marker) node.marker = op.marker;
      else delete node.marker;
      return;
    case "toggle_marker":
      node.marker = node.marker ? (cycle[node.marker] ?? "DONE") : "TODO";
      return;
    case "delete":
      siblings.splice(index, 1);
      return;
    case "indent": {
      // Under the sibling before it, with everything under it.
      const before = siblings[index - 1];
      if (!before) return;
      siblings.splice(index, 1);
      before.children.push(node);
      return;
    }
    case "outdent": {
      // Right after its parent, with everything under it.
      if (!at.parent) return;
      const up = locate(roots, at.parent.id);
      if (!up) return;
      siblings.splice(index, 1);
      up.siblings.splice(up.index + 1, 0, node);
      return;
    }
    case "move": {
      const to = op.direction === "up" ? index - 1 : index + 1;
      const other = siblings[to];
      if (!other) return;
      siblings[to] = node;
      siblings[index] = other;
      return;
    }
  }
}

/** Each block's depth from where it now is. */
function renumber(nodes: Node[], depth = 0): Node[] {
  for (const node of nodes) {
    node.depth = depth;
    renumber(node.children, depth + 1);
  }
  return nodes;
}
