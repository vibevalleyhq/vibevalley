import { For } from "solid-js";
import type { Attachment } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";
import { AttachmentTile } from "./AttachmentTile";

// A picture's thumbnail is read from the server, which the stories do not have: the kinds drawn here are the others.
const files: Attachment[] = [
  { id: "a", name: "notes.md", type: "text/markdown", size: 2048 },
  { id: "b", name: "design-review.pdf", type: "application/pdf", size: 1_400_000 },
  { id: "c", name: "standup.m4a", type: "audio/mp4", size: 820_000 },
  { id: "d", name: "screen-recording-of-the-whole-bug.mov", type: "video/quicktime", size: 48_000_000 },
];

export default stories({
  title: "ui/AttachmentTile",
  stories: {
    Kinds: story({
      args: { removable: true },
      render: (a) => (
        <div class="flex flex-wrap gap-2">
          <For each={files}>{(file) => <AttachmentTile file={file} onRemove={a.removable ? () => undefined : undefined} />}</For>
        </div>
      ),
    }),
  },
});
