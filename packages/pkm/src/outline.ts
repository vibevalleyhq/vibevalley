import type { PkmBlock, PkmBlockOp, PkmMarker, PkmPriority } from "@vibevalley/protocol";

/** A page's name from its title: trimmed, lower case, spaces as dashes, "/" (or "\") as "__". */
export const slugOf = (title: string) => title.trim().replace(/\\/gu, "/").replace(/\//gu, "__").replace(/\s+/gu, "-").toLowerCase();

// What a #tag may follow: anything but a Latin letter, a digit or one of _ / & # (so C#, issue#12, a link's #part, an entity and a ## heading are not tags).
const tagLead = String.raw`(?<![\p{Script=Latin}\p{N}_/&#])#`;
const tagName = String.raw`[\p{L}\p{N}_/-]`;

/** Every #tag in a text (read it with matchAll): the name is group 1. The page draws them, the server links them. */
export const pkmTag = new RegExp(`${tagLead}(${tagName}+)`, "gu");

/** A #tag being typed, ending where the text ends (the caret): its name so far is group 1. */
export const pkmTagTyped = new RegExp(`${tagLead}(${tagName}*)$`, "u");

/** The server's carries more: whether its id is written in the file. */
export interface PkmTreeNode {
  id: string;
  depth: number;
  marker?: PkmMarker;
  priority?: PkmPriority;
  body: string;
  props: Record<string, string>;
  children: PkmTreeNode[];
}

interface Place {
  readonly node: PkmTreeNode;
  readonly siblings: PkmTreeNode[];
  readonly index: number;
  readonly parent: PkmTreeNode | undefined;
}

function locate(siblings: PkmTreeNode[], id: string, parent?: PkmTreeNode): Place | undefined {
  for (const [index, node] of siblings.entries()) {
    if (node.id === id) return { node, siblings, index, parent };
    const inside = locate(node.children, id, node);
    if (inside !== undefined) return inside;
  }
  return undefined;
}

const cycle: Partial<Record<PkmMarker, PkmMarker>> = { TODO: "DOING", DOING: "DONE", DONE: "TODO", LATER: "NOW", NOW: "DONE" };

/** The blocks after the ops in order (a copy: blocks is not changed). an op on a block not on the page changes nothing. */
export function applyBlockOps<N extends PkmTreeNode>(
  blocks: readonly N[],
  ops: readonly PkmBlockOp[],
  made: (fields: PkmTreeNode) => N,
  newId: () => string,
): N[] {
  const roots = structuredClone([...blocks]);
  const fresh = (op: { id?: string; body: string; marker?: PkmMarker; priority?: PkmPriority; props?: Record<string, string> }) =>
    made({
      id: op.id ?? newId(),
      depth: 0,
      ...(op.marker !== undefined ? { marker: op.marker } : {}),
      ...(op.priority !== undefined ? { priority: op.priority } : {}),
      body: op.body,
      props: { ...op.props },
      children: [],
    });
  for (const op of ops) applyOne(roots, op, fresh);
  renumber(roots);
  return roots;
}

function applyOne(roots: PkmTreeNode[], op: PkmBlockOp, fresh: (op: Extract<PkmBlockOp, { body: string }>) => PkmTreeNode) {
  if (op.op === "append") {
    roots.push(fresh(op));
    return;
  }
  const at = locate(roots, op.block);
  if (at === undefined) return;
  const { node, siblings, index } = at;
  switch (op.op) {
    case "insert_before":
      siblings.splice(index, 0, fresh(op));
      return;
    case "insert_after":
      siblings.splice(index + 1, 0, fresh(op));
      return;
    case "insert_child":
      node.children.push(fresh(op));
      return;
    case "update":
      if (op.body !== undefined) node.body = op.body;
      if (op.priority !== undefined) node.priority = op.priority;
      if (op.props !== undefined) Object.assign(node.props, op.props);
      return;
    case "set_marker":
      if (op.marker !== undefined) node.marker = op.marker;
      else delete node.marker;
      return;
    case "toggle_marker":
      node.marker = node.marker !== undefined ? (cycle[node.marker] ?? "DONE") : "TODO";
      return;
    case "delete":
      siblings.splice(index, 1);
      return;
    case "indent": {
      const before = siblings[index - 1];
      if (before === undefined) return;
      siblings.splice(index, 1);
      before.children.push(node);
      return;
    }
    case "outdent": {
      if (at.parent === undefined) return;
      const up = locate(roots, at.parent.id);
      if (up === undefined) return;
      siblings.splice(index, 1);
      up.siblings.splice(up.index + 1, 0, node);
      return;
    }
    case "move_to": {
      // Out of the outline first, then the target found again: where it is may have shifted by the block taken out.
      if (op.target === node.id || locate(node.children, op.target) !== undefined) return;
      siblings.splice(index, 1);
      const there = locate(roots, op.target);
      if (there === undefined) {
        siblings.splice(index, 0, node);
        return;
      }
      if (op.at === "inside") there.node.children.unshift(node);
      else there.siblings.splice(there.index + (op.at === "after" ? 1 : 0), 0, node);
      return;
    }
    case "move": {
      const to = op.direction === "up" ? index - 1 : index + 1;
      const other = siblings[to];
      if (other === undefined) return;
      siblings[to] = node;
      siblings[index] = other;
      return;
    }
  }
}

function renumber(nodes: PkmTreeNode[], depth = 0) {
  for (const node of nodes) {
    node.depth = depth;
    renumber(node.children, depth + 1);
  }
}

const headOf = (body: string) => (body.split("\n")[0] ?? "").replace(/^#+\s*/u, "").trim();

/** The outline as the wire has it: in order, each with its parent and the path of first lines above it. */
export function flatBlocks(nodes: readonly PkmTreeNode[]): PkmBlock[] {
  const out: PkmBlock[] = [];
  const go = (list: readonly PkmTreeNode[], parent: string | undefined, path: readonly string[]) => {
    for (const node of list) {
      out.push({
        id: node.id,
        ...(parent !== undefined && parent !== "" ? { parent } : {}),
        depth: node.depth,
        ...(node.marker !== undefined ? { marker: node.marker } : {}),
        ...(node.priority !== undefined ? { priority: node.priority } : {}),
        body: node.body,
        props: { ...node.props },
        path: path.join(" > "),
      });
      go(node.children, node.id, [...path, headOf(node.body)]);
    }
  };
  go(nodes, undefined, []);
  return out;
}

export function treeOfBlocks(blocks: readonly PkmBlock[]): PkmTreeNode[] {
  const roots: PkmTreeNode[] = [];
  const byId = new Map<string, PkmTreeNode>();
  for (const b of blocks) {
    const node: PkmTreeNode = {
      id: b.id,
      depth: b.depth,
      ...(b.marker !== undefined ? { marker: b.marker } : {}),
      ...(b.priority !== undefined ? { priority: b.priority } : {}),
      body: b.body,
      props: { ...b.props },
      children: [],
    };
    byId.set(b.id, node);
    const parent = b.parent === undefined ? undefined : byId.get(b.parent);
    if (parent !== undefined) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
