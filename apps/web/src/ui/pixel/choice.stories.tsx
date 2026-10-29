import { stories, story } from "@vibevalley/stories";
import { PxPick, PxSegmented, PxSwitchField } from "./choice";

const runtimes = [
  { value: "claude", label: "Claude Code", detail: "Anthropic" },
  { value: "codex", label: "Codex", detail: "OpenAI" },
  { value: "pi", label: "pi" },
];

export default stories({
  title: "组件/像素/choice",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    Segmented: story({
      args: { value: "day", block: false },
      controls: { value: { kind: "choice", options: ["day", "week", "all"] } },
      render: (a, set) => (
        <PxSegmented
          label="范围"
          value={a.value}
          block={a.block}
          onChange={(value) => set({ value })}
          options={[
            { value: "day", label: "今天" },
            { value: "week", label: "这周" },
            { value: "all", label: "全部" },
          ]}
        />
      ),
    }),
    Pick: story({
      args: { value: "", clearable: true, disabled: false },
      render: (a, set) => (
        <div class="w-64">
          <PxPick
            label="农机"
            placeholder="选一台农机"
            value={a.value}
            clearable={a.clearable}
            disabled={a.disabled}
            options={runtimes}
            onChange={(value) => set({ value })}
          />
        </div>
      ),
    }),
    Switch: story({
      args: { checked: true, disabled: false },
      render: (a, set) => (
        <div class="w-72">
          <PxSwitchField label="自动派活" hint="管家看到空闲的帮工就派" checked={a.checked} disabled={a.disabled} onChange={(checked) => set({ checked })} />
        </div>
      ),
    }),
  },
});
