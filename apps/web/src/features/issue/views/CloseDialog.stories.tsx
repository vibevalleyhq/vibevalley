import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { sampleChanges as changes } from "#/features/issue/model/issue.samples.ts";

import { ChangesBody, ChangesHead } from "./CloseDialog";

const viewStyles = stylex.create({
  closeDialogStoriesDiv: {
    display: "flex",
    width: "100%",
    maxWidth: "var(--container-2xl)",
    flexDirection: "column",
    gap: "0.5rem",
  },
});

export default stories({
  title: "界面/工单/改动",
  stories: {
    Changes: story({
      note: "合进主分支之前看的：提交、文件，点开文件看补丁（按语言上色）。",
      render: () => (
        <div {...stylex.attrs(viewStyles.closeDialogStoriesDiv)}>
          <ChangesHead changes={changes} />
          <ChangesBody changes={changes} />
        </div>
      ),
    }),
  },
});
