import { BlockEditor as BaseBlockEditor, EditBlock } from "@vibevalley/artifact/editor";
import type { ArtifactId, VibeValleyApi } from "@vibevalley/protocol";

import { reasonOf } from "#/infra/api.ts";

export { EditBlock };

export class BlockEditor extends BaseBlockEditor {
  constructor(api: VibeValleyApi, artifactId: ArtifactId) {
    super(api, artifactId, reasonOf);
  }
}
