import { createSignal } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { ChipsInput, KeyValueEditor } from "./Chips";

export default stories({
  title: "组件/工作台/Chips",
  stories: {
    Words: story({
      note: "回车或逗号加一个，空着按退格删最后一个。",
      args: { words: "frontend,urgent", disabled: false },
      render: (a, set) => (
        <div class="w-80">
          <ChipsInput
            label="标签"
            placeholder="加一个标签"
            value={a.words ? a.words.split(",") : []}
            disabled={a.disabled}
            onChange={(v) => set({ words: v.join(",") })}
          />
        </div>
      ),
    }),
    "Key and value": story({
      render: () => {
        const [env, setEnv] = createSignal<Record<string, string>>({ NODE_ENV: "development", PORT: "8787" });
        return (
          <div class="w-96">
            <KeyValueEditor value={env()} onChange={setEnv} />
          </div>
        );
      },
    }),
  },
});
