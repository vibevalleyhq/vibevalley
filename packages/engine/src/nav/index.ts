export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface NavMap {
  /** A way from `from` to `to` as waypoints, both ends included. Unreachable: straight there. */
  route(from: Point, to: Point): Point[];
  walkable(p: Point): boolean;
}

export interface NavOptions {
  w: number;
  h: number;
  /** Cell size in world pixels: smaller follows narrow paths more closely and costs more to search. */
  cell?: number;
  walkable: (p: Point) => boolean;
  /** What one step on this spot costs, 1 or more: lower on paths, so walkers keep to them. */
  cost?: (p: Point) => number;
  /** Walkers keep this far (world pixels) from anything they cannot walk on, where there is room. */
  clearance?: number;
}

const SQRT2 = Math.SQRT2;

/** Builds the grid once; route() is then cheap enough to call on every walk. */
export function navMap({ w, h, cell = 8, walkable, cost, clearance = 24 }: NavOptions): NavMap {
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const n = cols * rows;
  const centre = (i: number): Point => ({ x: ((i % cols) + 0.5) * cell, y: (Math.floor(i / cols) + 0.5) * cell });
  const index = (p: Point) => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor(p.x / cell)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor(p.y / cell)));
    return r * cols + c;
  };

  const free = new Uint8Array(n);
  for (let i = 0; i < n; i++) free[i] = walkable(centre(i)) ? 1 : 0;

  // How many cells to the nearest blocked one (a two-pass chamfer distance), for keeping off the edges.
  const far = new Float32Array(n);
  for (let i = 0; i < n; i++) far[i] = free[i] === 1 ? 1e9 : 0;
  const relax = (i: number, j: number, d: number) => {
    const next = (far[j] ?? 0) + d;
    if (next < (far[i] ?? 0)) far[i] = next;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c > 0) relax(i, i - 1, 1);
      if (r > 0) {
        relax(i, i - cols, 1);
        if (c > 0) relax(i, i - cols - 1, SQRT2);
        if (c < cols - 1) relax(i, i - cols + 1, SQRT2);
      }
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (c < cols - 1) relax(i, i + 1, 1);
      if (r < rows - 1) {
        relax(i, i + cols, 1);
        if (c < cols - 1) relax(i, i + cols + 1, SQRT2);
        if (c > 0) relax(i, i + cols - 1, SQRT2);
      }
    }
  }

  // The price of attention on each cell: its own cost, plus a little more the closer it is to an edge.
  const room = clearance / cell;
  const weight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const base = Math.max(1, cost?.(centre(i)) ?? 1);
    const f = far[i] ?? 0;
    weight[i] = base + (f < room ? (room - f) / room : 0);
  }

  /** The nearest walkable cell, searching outwards ring by ring. */
  const nearestFree = (i: number): number => {
    if (free[i] === 1) return i;
    const c0 = i % cols;
    const r0 = Math.floor(i / cols);
    for (let ring = 1; ring < Math.max(cols, rows); ring++) {
      let best = -1;
      let bestD = Infinity;
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        for (let c = c0 - ring; c <= c0 + ring; c++) {
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue;
          const j = r * cols + c;
          const d = (r - r0) ** 2 + (c - c0) ** 2;
          if (free[j] === 1 && d < bestD) {
            best = j;
            bestD = d;
          }
        }
      }
      if (best >= 0) return best;
    }
    return i;
  };

  const g = new Float32Array(n);
  const came = new Int32Array(n);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();

  const search = (start: number, goal: number): number[] | null => {
    g.fill(Infinity);
    came.fill(-1);
    closed.fill(0);
    heap.clear();
    const gc = goal % cols;
    const gr = Math.floor(goal / cols);
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - gc);
      const dy = Math.abs(Math.floor(i / cols) - gr);
      return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
    };
    g[start] = 0;
    heap.push(start, h(start));
    while (heap.size > 0) {
      const i = heap.pop();
      if (i === goal) {
        const cells = [i];
        for (let k = came[i] ?? -1; k >= 0; k = came[k] ?? -1) cells.push(k);
        return cells.toReversed();
      }
      if (closed[i] === 1) continue;
      closed[i] = 1;
      const c = i % cols;
      const r = Math.floor(i / cols);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const j = nr * cols + nc;
          if (free[j] !== 1 || closed[j] === 1) continue;
          // No squeezing diagonally between two blocked cells.
          if (dr !== 0 && dc !== 0 && (free[r * cols + nc] !== 1 || free[nr * cols + c] !== 1)) continue;
          const step = (dr !== 0 && dc !== 0 ? SQRT2 : 1) * ((weight[i] ?? 1) + (weight[j] ?? 1)) * 0.5;
          const tentative = (g[i] ?? Infinity) + step;
          if (tentative < (g[j] ?? Infinity)) {
            g[j] = tentative;
            came[j] = i;
            heap.push(j, tentative + h(j));
          }
        }
      }
    }
    return null;
  };

  /** What walking a straight line costs (cells crossed times their price), or Infinity if it leaves the ground. */
  const lineCost = (a: Point, b: Point): number => {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(length / (cell * 0.5)));
    let sum = 0;
    for (let s = 0; s <= steps; s++) {
      const i = index({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
      if (free[i] !== 1) return Infinity;
      sum += weight[i] ?? 1;
    }
    return (sum / (steps + 1)) * (length / cell);
  };

  /** A grid step's cost; the ends may sit off the grid's walkable cells (they were snapped there), so never Infinity. */
  const stepCost = (a: Point, b: Point): number => {
    const c = lineCost(a, b);
    return Number.isFinite(c) ? c : Math.hypot(b.x - a.x, b.y - a.y) / cell;
  };

  return {
    walkable: (p) => free[index(p)] === 1,
    route(from, to) {
      const start = nearestFree(index(from));
      const goal = nearestFree(index(to));
      const cells = search(start, goal);
      if (!cells) return [from, to];
      const points: Point[] = cells.map(centre);
      points[0] = from;
      points[points.length - 1] = to;
      // What the grid way costs up to each point, to judge shortcuts against.
      const spent = [0];
      for (let k = 1; k < points.length; k++) spent.push((spent[k - 1] ?? 0) + stepCost(points[k - 1] ?? from, points[k] ?? to));
      // Cut corners: from each kept point, jump to the farthest one a straight line reaches no dearer.
      const kept: Point[] = [points[0]];
      let at = 0;
      while (at < points.length - 1) {
        let next = at + 1;
        const atPoint = points[at] ?? from;
        const atSpent = spent[at] ?? 0;
        for (let k = points.length - 1; k > at + 1; k--) {
          if (lineCost(atPoint, points[k] ?? to) <= ((spent[k] ?? 0) - atSpent) * 1.03) {
            next = k;
            break;
          }
        }
        kept.push(points[next] ?? to);
        at = next;
      }
      return kept;
    },
  };
}

/** A binary heap of cell indices by priority, smallest first. */
class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];

  get size() {
    return this.items.length;
  }

  clear() {
    this.items.length = 0;
    this.keys.length = 0;
  }

  push(item: number, key: number) {
    const items = this.items;
    const keys = this.keys;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const parentKey = keys[parent] ?? 0;
      const parentItem = items[parent] ?? 0;
      if (parentKey <= key) break;
      items[i] = parentItem;
      keys[i] = parentKey;
      i = parent;
    }
    items[i] = item;
    keys[i] = key;
  }

  /** The smallest item; -1 when empty. */
  pop(): number {
    const items = this.items;
    const keys = this.keys;
    const top = items[0] ?? -1;
    const lastItem = items.pop();
    const lastKey = keys.pop();
    if (lastItem !== undefined && lastKey !== undefined && items.length > 0) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        if (left >= items.length) break;
        const right = left + 1;
        const child = right < items.length && (keys[right] ?? Infinity) < (keys[left] ?? Infinity) ? right : left;
        const childKey = keys[child] ?? Infinity;
        const childItem = items[child] ?? 0;
        if (childKey >= lastKey) break;
        items[i] = childItem;
        keys[i] = childKey;
        i = child;
      }
      items[i] = lastItem;
      keys[i] = lastKey;
    }
    return top;
  }
}
