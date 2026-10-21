// The graph both a task's steps and an agent's own tasks are: nodes that wait for
// other nodes. What a node is, and what settles it, is the caller's; these say only what the edges allow.

export interface DagNode {
  readonly id: string;
  readonly after: readonly string[];
}

/** Ids are ASCII only. */
export const dagIDValid = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(id);

/** id is the node at fault; other the id it names (a missing one); circle the nodes waiting on one another. */
export type DagProblem =
  | { readonly kind: "duplicate"; readonly id: string }
  | { readonly kind: "self"; readonly id: string }
  | { readonly kind: "missing"; readonly id: string; readonly other: string }
  | { readonly kind: "circle"; readonly circle: readonly string[] };

/** In the nodes' order: duplicates, then each node's edges in order; a circle only when the edges are otherwise sound. */
export function dagProblems(nodes: readonly DagNode[]): DagProblem[] {
  const problems: DagProblem[] = [];
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) problems.push({ kind: "duplicate", id: n.id });
    ids.add(n.id);
  }
  for (const n of nodes) {
    for (const x of n.after) {
      if (x === n.id) problems.push({ kind: "self", id: n.id });
      else if (!ids.has(x)) problems.push({ kind: "missing", id: n.id, other: x });
    }
  }
  if (problems.length > 0) return problems;
  const laid = new Set(dagLayers(nodes).flat());
  const circle = nodes.filter((n) => !laid.has(n.id)).map((n) => n.id);
  if (circle.length > 0) problems.push({ kind: "circle", circle });
  return problems;
}

/** Longest path from a node that waits for nothing. A node caught in a circle is in no layer; an edge to an unknown node or to itself is ignored. */
export function dagLayers(nodes: readonly DagNode[]): string[][] {
  const known = new Set(nodes.map((n) => n.id));
  const depth = new Map<string, number>();
  // At most one pass per node.
  let changed = true;
  for (let pass = 0; changed && pass <= nodes.length; pass++) {
    changed = false;
    for (const n of nodes) {
      if (depth.has(n.id)) continue;
      let d = 0;
      let ready = true;
      for (const x of n.after) {
        if (!known.has(x) || x === n.id) continue;
        const nd = depth.get(x);
        if (nd === undefined) {
          ready = false;
          break;
        }
        d = Math.max(d, nd + 1);
      }
      if (!ready) continue;
      depth.set(n.id, d);
      changed = true;
    }
  }
  const layers: (string[] | undefined)[] = [];
  for (const n of nodes) {
    const d = depth.get(n.id);
    if (d === undefined) continue;
    while (layers.length <= d) layers.push(undefined);
    (layers[d] ??= []).push(n.id);
  }
  return layers.filter((l): l is string[] => l !== undefined);
}
