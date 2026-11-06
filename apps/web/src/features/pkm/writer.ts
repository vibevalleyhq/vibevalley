import { type PageServer, PageWriter as BasePageWriter, type WriterHooks } from "@vibevalley/pkm/writer";
import type { PkmBlock } from "@vibevalley/protocol";

import { api, reasonOf } from "#/infra/api.ts";

export { type PageServer, type WriterHooks };

export const pageServer: PageServer = { apply: (page, ops) => api.pkm.block.apply({ page, ops: [...ops] }), undo: () => api.pkm.undo() };

export class PageWriter extends BasePageWriter {
  constructor(slug: string, blocks: PkmBlock[], to: PageServer, hooks: WriterHooks) {
    super(slug, blocks, to, hooks, reasonOf);
  }
}
