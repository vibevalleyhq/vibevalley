// The phone's calls: the calls are the server's inbox; which were answered or hung up on, the
// call log, and which rings now are the page's, kept for this page's life. The phone and the chat's call button are one
// call (features/voice/call.ts): answering a ring opens it, and while it is on nothing rings: the orchestrator says it on the call.

import type { InboxItem } from "@vibevalley/protocol";
import { freshOf } from "@vibevalley/protocol/rules";
import { voiceCall } from "@/features/voice";
import { playSound } from "@/ui/pixel/sound";
import { farm, farmState } from "@/farm/store";

export interface PhoneLogEntry {
  readonly call: InboxItem;
  readonly answered: boolean;
  readonly at: number;
}

export interface PhoneState {
  readonly calls: readonly InboxItem[];
  readonly handled: ReadonlySet<string>;
  readonly ringing: InboxItem | undefined;
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
  /** The call is on (or getting on): the orchestrator tells it there, so the phone does not ring. */
  inCall(): boolean;
  every(ms: number, f: () => void): () => void;
  after(ms: number, f: () => void): () => void;
  now(): number;
}

export class PhoneCalls {
  private state: PhoneState = { calls: [], handled: new Set(), ringing: undefined, log: [] };
  private readonly listeners = new Set<() => void>();
  /** undefined until the first look, which rings nothing. */
  private known: Set<string> | undefined;
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
    this.known = undefined;
    this.active = true;
  }

  pause() {
    this.active = false;
    this.putAway();
  }

  calls(calls: readonly InboxItem[]) {
    this.set({ calls });
    const missed = missedOf(this.state);
    const news = freshOf(this.known, missed);
    this.known = news.known;
    const fresh = news.fresh[0];
    if (fresh && this.active && !this.host.inCall()) return this.ring(fresh);
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
    this.set({ ringing: undefined });
    if (this.openedByRing) {
      this.openedByRing = false;
      this.host.setOpen(false);
    }
  }

  silence() {
    this.stopBell();
    this.openedByRing = false;
    if (this.state.ringing) this.set({ ringing: undefined });
  }

  settle(call: InboxItem, answered: boolean) {
    this.set({
      handled: new Set([...this.state.handled, call.id]),
      log: [{ call, answered, at: this.host.now() }, ...this.state.log].slice(0, logKeep),
    });
    this.host.play(answered ? "voiceOn" : "voiceOff");
    // Answered, the phone stays out: the call is on it, and the page unfolds it to 田头, where what is said shows.
    if (this.state.ringing?.id === call.id) {
      if (answered) this.silence();
      else this.endRing();
    }
  }

  putAway() {
    this.openedByRing = false;
    this.stopBell();
    if (this.state.ringing) this.set({ ringing: undefined });
  }
}

export const phoneCalls = new PhoneCalls({
  isOpen: () => farmState().phoneOpen,
  setOpen: (open) => farm.phoneOpen(open),
  play: playSound,
  inCall: () => voiceCall.phase !== "idle",
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
