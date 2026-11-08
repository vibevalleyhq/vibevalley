import * as stylex from "@stylexjs/stylex";

import type { KeyStatus } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";

import { KeyField, KeyMark, SaveBar } from "./KeyField";
import { SecretInput } from "./layout";

const viewStyles = stylex.create({
  keyFieldStoriesDiv: {
    width: "calc(var(--spacing) * 96)",
  },
  keyFieldStoriesDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 4)",
  },
  keyFieldStoriesDiv3: {
    width: "32rem",
  },
  keyFieldStoriesSpan: {
    color: "var(--wb-berry)",
  },
});

const statusOf = (source: string, hint: string): KeyStatus =>
  source === "settings" || source === "config" ? { source, ...(hint ? { hint } : {}) } : { source: null };

export default stories({
  title: "组件/工作台/KeyField",
  stories: {
    Key: story({
      args: { source: "settings", hint: "a1b2", removing: false, small: false },
      controls: { source: { kind: "choice", options: ["", "settings", "config"] } },
      render: (a, set) => (
        <div {...stylex.attrs(viewStyles.keyFieldStoriesDiv)}>
          <KeyField
            label="DeepSeek"
            status={statusOf(a.source, a.hint)}
            removing={a.removing}
            onRemove={(removing) => set({ removing })}
            link={{ href: "https://platform.deepseek.com", label: "拿钥匙" }}
            tip="管家和记性用它"
            small={a.small}
          >
            <SecretInput placeholder="sk-…" />
          </KeyField>
        </div>
      ),
    }),
    Marks: story({
      render: () => (
        <div {...stylex.attrs(viewStyles.keyFieldStoriesDiv2)}>
          <KeyMark status={{ source: null }} />
          <KeyMark status={{ source: "settings", hint: "a1b2" }} />
          <KeyMark status={{ source: "config" }} />
          <KeyMark status={{ source: "settings", hint: "a1b2" }} removing />
        </div>
      ),
    }),
    "Save bar": story({
      args: { dirty: true, busy: false, problem: "" },
      render: (a) => (
        <div {...stylex.attrs(viewStyles.keyFieldStoriesDiv3)}>
          <SaveBar
            dirty={a.dirty}
            busy={a.busy}
            onSave={() => undefined}
            onUndo={() => undefined}
            left={a.problem ? <span {...stylex.attrs(viewStyles.keyFieldStoriesSpan)}>{a.problem}</span> : undefined}
          />
        </div>
      ),
    }),
  },
});
