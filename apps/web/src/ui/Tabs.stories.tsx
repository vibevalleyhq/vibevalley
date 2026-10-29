import { stories, story } from "@vibevalley/stories";
import { Tabs, type TabsLook } from "./Tabs";

type Tab = "chat" | "jobs" | "crons" | "files";

export default stories({
  title: "组件/工作台/Tabs",
  stories: {
    States: story({
      args: { look: "pills" },
      grid: { rows: ["look", ["pills", "line"]], cols: "pseudo" },
      render: (a) => (
        <Tabs<Tab>
          label="群聊里"
          look={a.look as TabsLook}
          value="chat"
          items={[
            { value: "chat", label: "聊天", icon: "chat" },
            { value: "jobs", label: "活", icon: "issues" },
          ]}
        />
      ),
    }),
    Playground: story({
      note: "pills 用在窗格里，line 用在页面的头下面。",
      args: { look: "pills", value: "chat", icons: true },
      controls: { look: { kind: "choice", options: ["pills", "line"] }, value: { kind: "choice", options: ["chat", "jobs", "crons", "files"] } },
      render: (a, set) => (
        <Tabs<Tab>
          label="群聊里"
          look={a.look as TabsLook}
          value={a.value as Tab}
          onChange={(value) => set({ value })}
          class={a.look === "line" ? "border-b border-line px-3" : undefined}
          items={[
            { value: "chat", label: "聊天", icon: a.icons ? "chat" : undefined },
            { value: "jobs", label: "活", icon: a.icons ? "issues" : undefined },
            { value: "crons", label: "定时", icon: a.icons ? "clock" : undefined },
            { value: "files", label: "文件", icon: a.icons ? "file" : undefined },
          ]}
        />
      ),
    }),
  },
});
