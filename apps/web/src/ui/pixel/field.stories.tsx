import { stories, story } from "@vibevalley/stories";
import { PxField, PxTextArea, PxTextInput, PxTip } from "./field";

export default stories({
  title: "pixel/field",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    Text: story({
      args: { value: "", error: "", required: true, mono: false, disabled: false },
      render: (a, set) => (
        <div class="w-72">
          <PxField label="地的名字" tip="写在地头的木牌上" error={a.error || undefined} required={a.required}>
            {(id) => (
              <PxTextInput
                id={id}
                value={a.value}
                mono={a.mono}
                disabled={a.disabled}
                placeholder="登录页"
                suggestions={["登录页", "设置页", "首页"]}
                onChange={(value) => set({ value })}
              />
            )}
          </PxField>
        </div>
      ),
    }),
    "Long text": story({
      args: { value: "修好登录：过期的会话回到登录页。", reading: true },
      render: (a, set) => (
        <div class="w-96">
          <PxField label="说明">{(id) => <PxTextArea id={id} rows={5} value={a.value} reading={a.reading} onChange={(value) => set({ value })} />}</PxField>
        </div>
      ),
    }),
    Tip: story({
      render: () => (
        <PxTip tip="悬停才出来">
          <span class="border-b-2 border-dotted border-bark-500">这是什么</span>
        </PxTip>
      ),
    }),
  },
});
