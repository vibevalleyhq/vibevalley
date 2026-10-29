import { stories, story } from "@vibevalley/stories";
import { Button } from "./Button";
import { ToastHost } from "./ToastHost";
import { toast } from "./toasts";

export default stories({
  title: "组件/工作台/ToastHost",
  stories: {
    Toasts: story({
      fill: true,
      note: "底部一行，四秒后走；按钮在两个主题里都会加一条。",
      render: () => (
        <div class="flex items-start gap-2">
          <Button onClick={() => toast("已复制链接")}>说一句</Button>
          <Button tone="danger" onClick={() => toast("没连上服务端，稍后再试", "bad")}>
            说一句坏的
          </Button>
          <ToastHost />
        </div>
      ),
    }),
  },
});
