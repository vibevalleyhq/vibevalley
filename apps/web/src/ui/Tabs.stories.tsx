import * as stylex from "@stylexjs/stylex";

import { stories, story } from "@vibevalley/stories";

import { useRouter } from "#/infra/router.ts";

import { Tabs, type TabsLook } from "./Tabs";

type Tab = "chat" | "issues" | "crons" | "files";

const styles = stylex.create({
  line: { borderBottomWidth: 1, borderBottomStyle: "solid", borderColor: "var(--color-line)", paddingInline: "calc(var(--spacing) * 3)" },
  width: (width: number) => ({ width }),
});

function LinkedTabs() {
  const router = useRouter();
  return (
    <>
      <Tabs
        label="群聊里"
        look="line"
        value={router.path() === "/tabs/issues" ? "issues" : "chat"}
        items={[
          { value: "chat", label: "聊天", href: "/tabs/chat", icon: "chat" },
          { value: "issues", label: "活", href: "/tabs/issues", icon: "issues" },
        ]}
      />
      <output data-testid="tabs-location">{router.path()}</output>
    </>
  );
}

export default stories({
  title: "组件/工作台/Tabs",
  stories: {
    Links: story({ render: () => <LinkedTabs /> }),
    Sizing: story({
      args: { wide: false },
      render: (a, set) => (
        <>
          <Tabs label="群聊里" value="chat" styles={styles.width(a.wide ? 280 : 200)} items={[{ value: "chat", label: "聊天" }]} />
          <button type="button" data-testid="tabs-resize" onClick={() => set({ wide: !a.wide })}>
            宽度
          </button>
        </>
      ),
    }),
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
            { value: "issues", label: "活", icon: "issues" },
          ]}
        />
      ),
    }),
    Playground: story({
      note: "pills 用在窗格里，line 用在页面的头下面。",
      args: { look: "pills", value: "chat", icons: true },
      controls: { look: { kind: "choice", options: ["pills", "line"] }, value: { kind: "choice", options: ["chat", "issues", "crons", "files"] } },
      render: (a, set) => (
        <Tabs<Tab>
          label="群聊里"
          look={a.look as TabsLook}
          value={a.value as Tab}
          onChange={(value) => set({ value })}
          styles={a.look === "line" && styles.line}
          items={[
            { value: "chat", label: "聊天", icon: a.icons ? "chat" : undefined },
            { value: "issues", label: "活", icon: a.icons ? "issues" : undefined },
            { value: "crons", label: "定时", icon: a.icons ? "clock" : undefined },
            { value: "files", label: "文件", icon: a.icons ? "file" : undefined },
          ]}
        />
      ),
    }),
  },
});
