import type { PkmBlock, PkmBlockOp, PkmPage, PkmUndo } from "@vibevalley/protocol";

import { applied } from "./editing.ts";

export interface PageServer {
  readonly apply: (page: string, ops: readonly PkmBlockOp[]) => Promise<PkmPage>;
  readonly undo: () => Promise<PkmUndo>;
}

export interface WriterHooks {
  readonly changed: (blocks: PkmBlock[]) => void;
  readonly answered: (page: PkmPage) => void;
  /** The server refused a batch, in the user's words; the blocks went back to `server`. */
  readonly refused: (why: string) => void;
}

const defaultFormatError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class PageWriter {
  private readonly slug: string;
  private readonly to: PageServer;
  private readonly hooks: WriterHooks;
  private readonly formatError: (e: unknown) => string;
  private blocks: PkmBlock[];
  private server: PkmBlock[];
  private waiting: PkmBlockOp[] = [];
  private flying = false;

  constructor(slug: string, blocks: PkmBlock[], to: PageServer, hooks: WriterHooks, formatError: (e: unknown) => string = defaultFormatError) {
    this.slug = slug;
    this.to = to;
    this.hooks = hooks;
    this.formatError = formatError;
    this.blocks = blocks;
    this.server = blocks;
  }

  /** Whether edits of ours are on the way: the server's copy read meanwhile is older than what is drawn. */
  get busy() {
    return this.flying || this.waiting.length > 0;
  }

  apply(ops: readonly PkmBlockOp[]) {
    if (ops.length === 0) return;
    this.blocks = applied(this.blocks, ops);
    this.hooks.changed(this.blocks);
    this.waiting.push(...ops);
    this.flush();
  }

  /** The server's copy read again (a refetch, another editor's change to the file): taken when nothing of ours is on
   * the way; returns whether it was. */
  take(blocks: PkmBlock[]): boolean {
    this.server = blocks;
    if (this.busy) return false;
    this.blocks = blocks;
    this.hooks.changed(blocks);
    return true;
  }

  private flush() {
    if (this.flying || this.waiting.length === 0) return;
    const ops = this.waiting;
    this.waiting = [];
    this.flying = true;
    this.to.apply(this.slug, ops).then(
      (page) => {
        this.flying = false;
        this.server = page.blocks;
        this.blocks = this.waiting.length === 0 ? page.blocks : applied(page.blocks, this.waiting);
        this.hooks.changed(this.blocks);
        this.hooks.answered(page);
        this.flush();
      },
      (e: unknown) => {
        this.flying = false;
        this.waiting = [];
        this.blocks = this.server;
        this.hooks.changed(this.blocks);
        this.hooks.refused(this.formatError(e));
      },
    );
  }

  /** Puts back the file the last change wrote, once nothing of ours is on the way; undefined while something is. */
  undo(): Promise<PkmUndo> | undefined {
    return this.busy ? undefined : this.to.undo();
  }
}
