// The day clock: one world day lasts `daySeconds` of real time. It moves only when told how much time passed
// (`advance`), so a test, a ticker or a debug slider drives it; `run` ties it to a timer.

export interface Day {
  /** Time of day, 0..1 (0.5 is noon). */
  readonly tod: number;
  /** How many times faster than real time it runs. */
  readonly speed: number;
  readonly paused: boolean;
}

export interface DayClock {
  readonly daySeconds: number;
  readonly day: () => Day;
  /** Moves the clock on by `seconds` of real time (times its speed), unless paused. */
  readonly advance: (seconds: number) => void;
  readonly setTimeOfDay: (tod: number) => void;
  /** 0 pauses; anything else runs that many times faster than real time. */
  readonly setSpeed: (speed: number) => void;
  /** Calls `fn` on every change; returns how to stop. */
  readonly subscribe: (fn: (day: Day) => void) => () => void;
  /** Advances every `tickMs` by the time that really passed (`now`, ms); returns how to stop. */
  readonly run: (tickMs?: number, now?: () => number) => () => void;
}

const wrap = (tod: number) => ((tod % 1) + 1) % 1;

export function dayClock({ daySeconds, start = 0.42 }: { daySeconds: number; start?: number }): DayClock {
  let day: Day = { tod: wrap(start), speed: 1, paused: false };
  const listeners = new Set<(day: Day) => void>();
  const set = (next: Day) => {
    day = next;
    for (const fn of listeners) fn(day);
  };
  const clock: DayClock = {
    daySeconds,
    day: () => day,
    advance: (seconds) => {
      if (day.paused || seconds <= 0) return;
      set({ ...day, tod: wrap(day.tod + (seconds * day.speed) / daySeconds) });
    },
    setTimeOfDay: (tod) => set({ ...day, tod: wrap(tod) }),
    setSpeed: (speed) => set(speed <= 0 ? { ...day, paused: true } : { ...day, paused: false, speed }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    run: (tickMs = 250, now = () => performance.now()) => {
      let last = now();
      const timer = setInterval(() => {
        const t = now();
        clock.advance((t - last) / 1000);
        last = t;
      }, tickMs);
      return () => clearInterval(timer);
    },
  };
  return clock;
}

const smooth = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** 1 at full day, 0 at night. Sunrise around 06:00, sunset around 19:00. */
export function sunOf(tod: number): number {
  return smooth(0.22, 0.3, tod) * (1 - smooth(0.76, 0.84, tod));
}

/** Peaks at sunrise and sunset. */
export function duskOf(tod: number): number {
  const at = (c: number) => Math.max(0, 1 - Math.abs(tod - c) / 0.06);
  return Math.max(at(0.26), at(0.8));
}

/** "HH:MM", the minutes in fives. */
export function clockText(tod: number): string {
  const minutes = Math.floor(wrap(tod) * 24 * 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m - (m % 5)).padStart(2, "0")}`;
}
