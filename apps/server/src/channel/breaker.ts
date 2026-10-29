// The wake breaker: a helper whose launches fail wakeBreaker times running, each before it says a word, is not woken
// again (the audience leaves it out, kick does not hand it messages) until someone speaks to it by name or it leaves.
// Speaking again only clears the count: a tripped breaker stays tripped until it is reset.

import { wakeBreaker } from "./audience.ts";

export class WakeBreaker {
  private readonly failures = new Map<string, number>();
  private readonly open = new Set<string>();

  constructor(private readonly limit = wakeBreaker) {}

  /** A launch ended without a word. The count, and whether this one tripped the breaker. */
  failed(id: string): { readonly count: number; readonly tripped: boolean } {
    const count = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, count);
    if (count < this.limit || this.open.has(id)) return { count, tripped: false };
    this.open.add(id);
    return { count, tripped: true };
  }

  /** It said something: the failures before do not count. */
  spoke(id: string) {
    this.failures.delete(id);
  }

  /** Spoken to by name, or gone: woken again. */
  reset(id: string) {
    this.open.delete(id);
    this.failures.delete(id);
  }

  isOpen(id: string) {
    return this.open.has(id);
  }

  /** Every tripped one, for the audience. */
  tripped(): string[] {
    return [...this.open].sort();
  }
}
