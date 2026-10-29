import { createSignal, For, Show } from "solid-js";
import { stories, story } from "@vibevalley/stories";
import { ConfirmButton } from "../ui/ConfirmButton";
import { Empty } from "../ui/Empty";
import { ToastHost } from "../ui/ToastHost";
import { toast } from "../ui/toasts";

const all = ["登录页改版", "补齐看板的测试", "灵动岛的动画"];

export default stories({
  title: "交互/确认危险操作",
  stories: {
    "Delete in place": story({
      fill: true,
      note: "第一下就地问，第二下才删；Escape 或焦点离开就收回。删掉以后底下说一声。没有 window.confirm。",
      render: () => {
        const [left, setLeft] = createSignal(all);
        return (
          <div class="flex flex-col gap-3">
            <Show when={left().length > 0} fallback={<Empty icon="issues">都删掉了。</Empty>}>
              <ul class="flex w-full max-w-xl flex-col divide-y divide-line rounded-lg border border-line">
                <For each={left()}>
                  {(title) => (
                    <li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
                      <span class="min-w-0 flex-1 truncate text-sm">{title}</span>
                      <ConfirmButton
                        label="删除"
                        icon="delete"
                        question="改动和它的分支一起删掉。"
                        onConfirm={() => {
                          setLeft(left().filter((t) => t !== title));
                          toast(`删掉了「${title}」`);
                        }}
                      />
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <ToastHost />
          </div>
        );
      },
    }),
  },
});
