/** A count that only goes up (queries run, git commands): a test reads it before and after to hold a hot path to its
 * budget. Counters are process-wide, by name. */
export interface Counter {
  readonly name: string;
  readonly add: (n?: number) => void;
  readonly count: () => number;
}

/** A value that goes up and down (sessions open, streams open). */
export interface Gauge {
  readonly name: string;
  readonly set: (n: number) => void;
  readonly add: (n: number) => void;
  readonly value: () => number;
}

const counters = new Map<string, Counter>();
const gauges = new Map<string, Gauge>();

export function counter(name: string): Counter {
  let c = counters.get(name);
  if (c === undefined) {
    let n = 0;
    c = {
      name,
      add: (by = 1) => {
        n += by;
      },
      count: () => n,
    };
    counters.set(name, c);
  }
  return c;
}

export function gauge(name: string): Gauge {
  let g = gauges.get(name);
  if (g === undefined) {
    let v = 0;
    g = {
      name,
      set: (to) => {
        v = to;
      },
      add: (by) => {
        v += by;
      },
      value: () => v,
    };
    gauges.set(name, g);
  }
  return g;
}
