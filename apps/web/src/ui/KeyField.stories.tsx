import type { KeyStatus } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";
import { KeyField, KeyMark, SaveBar } from "./KeyField";
import { SecretInput } from "./layout";

const statusOf = (source: string, hint: string): KeyStatus => (source === "settings" || source === "config" ? { source, hint: hint || undefined } : {});

export default stories({
  title: "ui/KeyField",
  stories: {
    Key: story({
      args: { source: "settings", hint: "a1b2", removing: false, small: false },
      controls: { source: { kind: "choice", options: ["", "settings", "config"] } },
      render: (a, set) => (
        <div class="w-96">
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
        <div class="flex items-center gap-4">
          <KeyMark status={{}} />
          <KeyMark status={{ source: "settings", hint: "a1b2" }} />
          <KeyMark status={{ source: "config" }} />
          <KeyMark status={{ source: "settings", hint: "a1b2" }} removing />
        </div>
      ),
    }),
    "Save bar": story({
      args: { dirty: true, busy: false, problem: "" },
      render: (a) => (
        <div class="w-[32rem]">
          <SaveBar
            dirty={a.dirty}
            busy={a.busy}
            onSave={() => undefined}
            onUndo={() => undefined}
            left={a.problem ? <span class="text-berry">{a.problem}</span> : undefined}
          />
        </div>
      ),
    }),
  },
});
