import { stories, story } from "@vibevalley/stories";
import { PxButton } from "./button";
import { ToastStore } from "./toasts";
import { ToastViewport } from "./ToastViewport";

export default stories({
  title: "pixel/ToastViewport",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    Toasts: story({
      fill: true,
      note: "顶上居中一叠，指针放上去就停住，往右或往下拖开关掉。",
      render: () => {
        const store = new ToastStore();
        return (
          <div class="flex items-start gap-2">
            <PxButton onClick={() => store.add({ title: "两块地熟了", description: "去看改动" })}>说一句</PxButton>
            <PxButton tone="danger" onClick={() => store.add({ type: "error", title: "没连上服务端" })}>
              说一句坏的
            </PxButton>
            <PxButton onClick={() => store.add({ type: "achievement", title: "第一次就过", timeout: 0 })}>成就</PxButton>
            <ToastViewport store={store} top={48} />
          </div>
        );
      },
    }),
  },
});
