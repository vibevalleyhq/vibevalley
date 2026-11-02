interface Entry {
  readonly text: string;
  readonly bytes: number;
}

/** A bounded LRU of serialized resource snapshots. Pagination slices one stable string until offset 0 refreshes it. */
export class TextCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.text;
  }

  put(key: string, text: string): boolean {
    const bytes = new TextEncoder().encode(text).byteLength;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.bytes -= previous.bytes;
    }
    if (bytes > this.maxBytes) return false;
    while (this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
    this.entries.set(key, { text, bytes });
    this.bytes += bytes;
    return true;
  }
}
