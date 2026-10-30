import { stories, story } from "@vibevalley/stories";

import { ChangesBody, ChangesHead } from "./CloseDialog";
import { sampleChanges as changes } from "./issue.samples";

export default stories({
  title: "界面/工单/改动",
  stories: {
    Changes: story({
      note: "合进主分支之前看的：提交、文件，点开文件看补丁（按语言上色）。",
      render: () => (
        <div class="flex w-full max-w-2xl flex-col gap-2">
          <ChangesHead changes={changes} />
          <ChangesBody changes={changes} />
        </div>
      ),
    }),
  },
});
