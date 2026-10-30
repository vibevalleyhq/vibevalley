import { stories, story } from "@vibevalley/stories";

import { ConfirmButton } from "./ConfirmButton";

export default stories({
  title: "组件/工作台/ConfirmButton",
  stories: {
    Delete: story({
      note: "按一下就地问，Escape 或焦点离开就收回。",
      args: { label: "删除项目", question: "项目和它的工单都会删掉。", tone: "danger" },
      controls: { tone: { kind: "choice", options: ["danger", "primary"] } },
      render: (a) => <ConfirmButton label={a.label} question={a.question} tone={a.tone as "danger" | "primary"} icon="delete" onConfirm={() => undefined} />,
    }),
  },
});
