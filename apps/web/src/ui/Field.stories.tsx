import { stories, story } from "@vibevalley/stories";
import { Field, Select, TextArea, TextInput } from "./Field";

const runtimes = [
  { value: "", label: "选一个" },
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "pi", label: "pi", disabled: true },
];

export default stories({
  title: "ui/Field",
  stories: {
    Text: story({
      args: { label: "项目名", hint: "工作目录下的文件夹名", placeholder: "vibevalley", disabled: false },
      render: (a) => (
        <div class="w-80">
          <Field label={a.label} hint={a.hint || undefined}>
            <TextInput placeholder={a.placeholder} disabled={a.disabled} />
          </Field>
        </div>
      ),
    }),
    "Long text": story({
      render: () => (
        <div class="w-96">
          <Field label="说明">
            <TextArea rows={4} placeholder="要做什么、做到什么样算完" />
          </Field>
        </div>
      ),
    }),
    Select: story({
      note: "值为空的那一项是占位；选它就是不选。",
      args: { value: "", quiet: false, filter: false, disabled: false },
      controls: { value: { kind: "choice", options: runtimes.map((r) => r.value) } },
      render: (a, set) => (
        <div class="w-64">
          <Field label="农机">
            <Select
              label="农机"
              value={a.value}
              options={runtimes}
              quiet={a.quiet}
              filter={a.filter}
              disabled={a.disabled}
              onChange={(value) => set({ value })}
            />
          </Field>
        </div>
      ),
    }),
  },
});
