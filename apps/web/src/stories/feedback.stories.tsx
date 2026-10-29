import { createSignal, For, Match, Switch } from "solid-js";
import { stories, story } from "@vibevalley/stories";
import { Button } from "@/ui/Button";
import { Empty } from "@/ui/Empty";
import { ToastHost } from "@/ui/ToastHost";
import { toast } from "@/ui/toasts";

export default stories({
  title: "交互/空的、加载和出错",
  stories: {
    "Three states": story({
      fill: true,
      note: "一个地方的空、加载中、出错三种样子都要有（docs/style/design.md 的自查）：空的说为什么和下一步，加载只是一行淡字，出错说原因、给重试。",
      args: { state: "empty" },
      controls: { state: { kind: "choice", options: ["empty", "loading", "failed", "full"] } },
      render: (a, set) => {
        const [rows, setRows] = createSignal<string[]>([]);
        return (
          <div class="flex flex-col">
            <Switch>
              <Match when={a.state === "empty"}>
                <Empty
                  icon="issues"
                  action={
                    <Button
                      tone="primary"
                      icon="add"
                      onClick={() => {
                        setRows(["修好登录"]);
                        set({ state: "full" });
                      }}
                    >
                      新工单
                    </Button>
                  }
                >
                  还没有工单。写一句要做的事，管家会帮你拆开。
                </Empty>
              </Match>
              <Match when={a.state === "loading"}>
                <p class="p-4 text-xs text-faint" aria-busy="true">
                  在读……
                </p>
              </Match>
              <Match when={a.state === "failed"}>
                <Empty icon="warn" action={<Button onClick={() => toast("还是没连上，稍后再试", "bad")}>重试</Button>}>
                  没读到工单：服务端没开。
                </Empty>
              </Match>
              <Match when={a.state === "full"}>
                <ul class="divide-y divide-line rounded-lg border border-line">
                  <For each={rows().length > 0 ? rows() : ["修好登录", "补齐看板的测试"]}>{(r) => <li class="px-4 py-2.5 text-sm">{r}</li>}</For>
                </ul>
              </Match>
            </Switch>
            <ToastHost />
          </div>
        );
      },
    }),
  },
});
