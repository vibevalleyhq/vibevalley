// The phone's calls: the calls are the server's inbox; which were answered or hung up on, the
// call log, and which rings now are the page's, kept for this page's life. The web has no voice, so no call is the
// manager's on the line.

import { useEffect, useSyncExternalStore } from "react";
import type { InboxItem, InboxKind } from "@vibevalley/protocol";
import { useFrames } from "../../data/frame";
import { playSound } from "../sound";
import { farm, farmState, subscribeFarm } from "../store";

export const inboxKindLabel: Readonly<Record<InboxKind, string>> = {
  merge: "活熟了",
  fix: "活没做成",
  conflict: "合不进去",
  quiet: "好久没动静",
  "graph-draft": "计划拆好了",
  "graph-ripe": "计划能收了",
  "task-failed": "计划卡住了",
  mention: "找你",
  "schedule-ask": "定时等你同意",
};

export interface PhoneLogEntry {
  readonly call: InboxItem;
  readonly answered: boolean;
  readonly at: number;
}

export interface PhoneState {
  readonly calls: readonly InboxItem[];
  readonly handled: ReadonlySet<string>;
  readonly ringing: InboxItem | null;
  readonly log: readonly PhoneLogEntry[];
}

export const missedOf = (s: PhoneState) => s.calls.filter((c) => !s.handled.has(c.id));

export const ringFor = 20_000;
export const ringEvery = 4_000;
const logKeep = 40;

/** What the calls touch outside themselves: the phone's open state, the bell and the clock. */
export interface PhoneHost {
  isOpen(): boolean;
  setOpen(open: boolean): void;
  play(sound: "ring" | "voiceOn" | "voiceOff"): void;
  every(ms: number, f: () => void): () => void;
  after(ms: number, f: () => void): () => void;
  now(): number;
}

export class PhoneCalls {
  private state: PhoneState = { calls: [], handled: new Set(), ringing: null, log: [] };
  private readonly listeners = new Set<() => void>();
  /** null until the first look, which rings nothing. */
  private known: Set<string> | null = null;
  /** Only while the farm is on screen does a call ring. */
  private active = false;
  private openedByRing = false;
  private bell: (() => void)[] = [];

  constructor(private readonly host: PhoneHost) {}

  readonly get = () => this.state;

  readonly subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  private set(next: Partial<PhoneState>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((l) => l());
  }

  /** The farm came on screen: the next look at the inbox only primes. */
  resume() {
    this.known = null;
    this.active = true;
  }

  pause() {
    this.active = false;
    this.putAway();
  }

  calls(calls: readonly InboxItem[]) {
    this.set({ calls });
    const missed = missedOf(this.state);
    if (this.known === null) {
      this.known = new Set(missed.map((c) => c.id));
    } else {
      const known = this.known;
      const fresh = missed.find((c) => !known.has(c.id));
      for (const c of missed) known.add(c.id);
      if (fresh && this.active) return this.ring(fresh);
    }
    // Answered elsewhere (the bed harvested, the message read): it stops by itself.
    const ringing = this.state.ringing;
    if (ringing && !missed.some((c) => c.id === ringing.id)) this.endRing();
  }

  private ring(call: InboxItem) {
    this.stopBell();
    if (!this.host.isOpen()) {
      this.openedByRing = true;
      this.host.setOpen(true);
    }
    this.set({ ringing: call });
    this.host.play("ring");
    this.bell = [this.host.every(ringEvery, () => this.host.play("ring")), this.host.after(ringFor, () => this.endRing())];
  }

  private stopBell() {
    for (const stop of this.bell) stop();
    this.bell = [];
  }

  private endRing() {
    this.stopBell();
    if (!this.state.ringing) return;
    this.set({ ringing: null });
    if (this.openedByRing) {
      this.openedByRing = false;
      this.host.setOpen(false);
    }
  }

  silence() {
    this.stopBell();
    this.openedByRing = false;
    if (this.state.ringing) this.set({ ringing: null });
  }

  settle(call: InboxItem, answered: boolean) {
    this.set({
      handled: new Set([...this.state.handled, call.id]),
      log: [{ call, answered, at: this.host.now() }, ...this.state.log].slice(0, logKeep),
    });
    this.host.play(answered ? "voiceOn" : "voiceOff");
    if (this.state.ringing?.id === call.id) {
      if (answered) this.silence();
      else this.endRing();
    }
    if (answered) this.host.setOpen(false);
  }

  putAway() {
    this.openedByRing = false;
    this.stopBell();
    if (this.state.ringing) this.set({ ringing: null });
  }
}

export const phoneCalls = new PhoneCalls({
  isOpen: () => farmState().phoneOpen,
  setOpen: (open) => farm.phoneOpen(open),
  play: playSound,
  every: (ms, f) => {
    const t = setInterval(f, ms);
    return () => clearInterval(t);
  },
  after: (ms, f) => {
    const t = setTimeout(f, ms);
    return () => clearTimeout(t);
  },
  now: () => Date.now(),
});

export const usePhone = () => useSyncExternalStore(phoneCalls.subscribe, phoneCalls.get);

/** Feeds the inbox to the phone while the farm is on screen; putting the phone away stops a ring. */
export function usePhoneCalls() {
  const inbox = useFrames().frame?.inbox;
  useEffect(() => {
    phoneCalls.resume();
    let open = farmState().phoneOpen;
    const off = subscribeFarm(() => {
      const now = farmState().phoneOpen;
      if (open && !now) phoneCalls.putAway();
      open = now;
    });
    return () => {
      off();
      phoneCalls.pause();
    };
  }, []);
  useEffect(() => {
    if (inbox) phoneCalls.calls(inbox);
  }, [inbox]);
}
